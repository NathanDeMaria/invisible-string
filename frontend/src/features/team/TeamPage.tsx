import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSelector } from "react-redux";

import type { RootState } from "../../app/store";
import {
  useGetHistoryQuery,
  useGetRatingsQuery,
  type HistoryPoint,
  type TeamRow,
} from "../../services/api";
import {
  movementTitle,
  placeMove,
  ratingMove,
  record,
} from "../ratings/movement";
import { RatingTimeline } from "./RatingTimeline";
import { seasons } from "./timeline";

/**
 * One team: where it stands now, and how it got there.
 *
 * Two queries, and the first of them is usually free. The standing comes from
 * the same `/ratings` response the leaderboard rendered, so arriving here by
 * clicking a team's name costs one request rather than two -- and the rank
 * printed here is the rank that was printed there, rather than a second
 * computation of it that could disagree.
 *
 * The model follows the leaderboard's selection for the same reason: a team
 * page showing glicko's line under elo's rank would be two models wearing one
 * heading.
 *
 * A team the release doesn't rate is a 404 in prose rather than an empty
 * chart. The history file can't answer "is this a real team" -- it has no rows
 * for anybody before its model is republished -- but the ratings table can,
 * and it is already in hand.
 */
export function TeamPage() {
  const { league = "mens", team: raw = "" } = useParams();
  const team = decodeURIComponent(raw);
  const { model } = useSelector((s: RootState) => s.ui);

  const ratings = useGetRatingsQuery({ league, model: model ?? undefined });
  const history = useGetHistoryQuery({
    league,
    teams: team,
    model: model ?? undefined,
  });

  const [season, setSeason] = useState<number | "all">("all");

  const points = useMemo(
    () => history.data?.series[0]?.points ?? [],
    [history.data],
  );
  const years = useMemo(
    () => [...new Set(points.map((point) => point.year))].sort((a, b) => a - b),
    [points],
  );
  const shown = useMemo(
    () =>
      season === "all"
        ? points
        : points.filter((point) => point.year === season),
    [points, season],
  );

  const standing = ratings.data?.ratings.find((row) => row.team === team);
  const since = ratings.data?.movement_since?.date ?? null;

  if (ratings.isError) {
    return <p className="error">No ratings published for {league} yet.</p>;
  }
  if (ratings.isSuccess && !standing) {
    return (
      <p className="error">
        {ratings.data.model} doesn&rsquo;t rate a team called {team}.{" "}
        <Link to={`/${league}/ratings`}>Back to the leaderboard</Link>.
      </p>
    );
  }

  return (
    <section className="team-page">
      <h2>{team}</h2>

      {standing && <Standing row={standing} since={since} />}

      <h3>Rating over time</h3>
      {history.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : points.length === 0 ? (
        // Not an error: a model published before the history artifact existed
        // has no rows for anybody, and that resolves itself on the next
        // publish rather than needing anyone to do something.
        <p className="empty">
          No rating history published for {history.data?.model ?? "this model"}{" "}
          yet.
        </p>
      ) : (
        <>
          {years.length > 1 && (
            <div className="controls">
              <div className="field">
                <label htmlFor="team-season">Season</label>
                <select
                  id="team-season"
                  value={season}
                  onChange={(e) =>
                    setSeason(
                      e.target.value === "all" ? "all" : Number(e.target.value),
                    )
                  }
                >
                  <option value="all">All seasons</option>
                  {[...years].reverse().map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <RatingTimeline team={team} points={shown} />
          <SeasonTable points={shown} />
        </>
      )}
    </section>
  );
}

/**
 * Where the team stands, in the words the leaderboard used.
 *
 * The movement repeats the ratings table's Week column rather than recomputing
 * it: same number, same sentence in the title, one definition of what "since
 * last week" means (`app.movement`).
 */
function Standing({ row, since }: { row: TeamRow; since: string | null }) {
  const places = row.movement ? placeMove(row.movement.rank) : null;
  return (
    <dl className="facts">
      <div>
        <dt>Rank</dt>
        <dd>
          {row.rank}
          <span className="of">in this league</span>
        </dd>
      </div>
      <div>
        <dt>Rating</dt>
        <dd>
          {row.rating.toFixed(1)}
          {row.rd != null && <span className="of">RD {row.rd.toFixed(1)}</span>}
        </dd>
      </div>
      <div>
        <dt>Record</dt>
        <dd>
          {row.wins}&ndash;{row.losses}
          <span className="of">this season</span>
        </dd>
      </div>
      {row.movement && since && (
        <div>
          <dt>Last week</dt>
          <dd title={movementTitle(row.movement, since)}>
            {ratingMove(row.movement.rating)}
            <span className="of">
              {places && (
                <>
                  {places.glyph}
                  {places.count} place{places.count === 1 ? "" : "s"}
                </>
              )}
              {places &&
                record(row.movement.wins, row.movement.losses) &&
                " · "}
              {record(row.movement.wins, row.movement.losses)}
              {!places &&
                !record(row.movement.wins, row.movement.losses) &&
                "no change"}
            </span>
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The chart as a table, which is the version a screen reader and a copy-paste
 * can both use.
 *
 * By season rather than by week: 300 rows is a data dump, and the reading a
 * reader actually takes off the line is "where did this season start, where
 * did it end, and what was the record".
 */
function SeasonTable({ points }: { points: HistoryPoint[] }) {
  const runs = seasons(points);
  if (runs.length === 0) return null;

  return (
    <table className="ratings">
      <caption className="meta">Every season this model has rated.</caption>
      <thead>
        <tr>
          <th scope="col">Season</th>
          <th scope="col" className="num">
            Weeks
          </th>
          <th scope="col" className="num">
            Start
          </th>
          <th scope="col" className="num">
            End
          </th>
          <th scope="col" className="num">
            Change
          </th>
          <th scope="col" className="num">
            W&ndash;L
          </th>
        </tr>
      </thead>
      <tbody>
        {[...runs].reverse().map((run) => {
          const first = run.points[0];
          const last = run.points[run.points.length - 1];
          return (
            <tr key={`${run.year}-${run.from}`}>
              <td>{run.year}</td>
              <td className="num">{run.points.length}</td>
              <td className="num">{first.rating.toFixed(1)}</td>
              <td className="num">{last.rating.toFixed(1)}</td>
              {/* Within the season only. A change measured from last season's
                  last week would include the offseason rollover, which is the
                  same reason the line breaks there. */}
              <td className="num">{ratingMove(last.rating - first.rating)}</td>
              <td className="num">
                {last.wins}&ndash;{last.losses}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
