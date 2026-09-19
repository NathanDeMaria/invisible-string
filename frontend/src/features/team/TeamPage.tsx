import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSelector } from "react-redux";

import type { RootState } from "../../app/store";
import {
  useGetHistoryQuery,
  useGetRatingsQuery,
  useGetTeamGamesQuery,
  type HistoryPoint,
  type TeamGameRow,
  type TeamRow,
  type UnitRating,
} from "../../services/api";
import { probability, spread } from "../games/format";
import { useRowKeys } from "../keys/useRowKeys";
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
  // The third query, and the only one that isn't about the rating: what this
  // team actually played. Its own request because it reads its own artifact
  // -- a model published without `predictions.parquet` loses its game list
  // and keeps its chart, which is the same degradation the chart makes on its
  // own file.
  const played = useGetTeamGamesQuery({
    league,
    team,
    model: model ?? undefined,
  });

  const [season, setSeason] = useState<number | "all">("all");

  const points = useMemo(
    () => history.data?.series[0]?.points ?? [],
    [history.data],
  );
  // Every season either artifact knows about. The union rather than the
  // chart's own, because the two files are published separately: a model with
  // games and no history should still offer the picker, and it now narrows
  // both halves of the page rather than only the line.
  const years = useMemo(() => {
    const charted = points.map((point) => point.year);
    const played_in = (played.data?.games ?? []).map((row) => row.season);
    return [...new Set([...charted, ...played_in])].sort((a, b) => a - b);
  }, [points, played.data]);
  const shown = useMemo(
    () =>
      season === "all"
        ? points
        : points.filter((point) => point.year === season),
    [points, season],
  );

  const games = useMemo(() => {
    const all = played.data?.games ?? [];
    return season === "all" ? all : all.filter((row) => row.season === season);
  }, [played.data, season]);

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

      {/* Above both sections, because it narrows both. */}
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
          <RatingTimeline team={team} points={shown} />
          <SeasonTable points={shown} />
        </>
      )}

      <h3>Games</h3>
      {played.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : games.length === 0 ? (
        <p className="empty">
          {played.data && played.data.games.length > 0
            ? `Nothing in ${season}.`
            : `No games published for ${played.data?.model ?? "this model"} yet.`}
        </p>
      ) : (
        <GameTable league={league} rows={games} />
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
      <Unit name="Offense" unit={row.offense} />
      <Unit name="Defense" unit={row.defense} />
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
 * One half of a team, where the model rates the halves apart.
 *
 * Beside the rating rather than under its own heading, because that is what it
 * is: the compound Glicko rates an offense and a defense on EPA per play and
 * blends them back into the number above, so the three belong in one list.
 *
 * Absent entirely for a model that rates the result alone, and for a team that
 * model has no plays for -- which is why this renders nothing rather than a
 * dash. A page for one team has no column to keep aligned, and "Offense —"
 * would look like a rating that failed to load.
 */
function Unit({
  name,
  unit,
}: {
  name: string;
  unit: UnitRating | null | undefined;
}) {
  if (!unit) return null;
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        {unit.rating.toFixed(1)}
        <span className="of">RD {unit.rd.toFixed(1)}</span>
      </dd>
    </div>
  );
}

/**
 * What the team played, and what was said about it beforehand.
 *
 * The counterpart to the chart: the line says a rating moved, and this says
 * what moved it. Every row is a link into the game's own page, and every link
 * carries the season -- the games API finds a game near today on its own and
 * needs the season for anything older, which is most of this list
 * (`app.games.find_game`).
 *
 * Two numbers a game long, not four: what the model made the team, and what
 * the market did. Both from this team's side (the API turns an away row
 * around), so a column of them can be read straight down without working out
 * who was at home on each line.
 */
function GameTable({ league, rows }: { league: string; rows: TeamGameRow[] }) {
  // Walked with the arrows and opened with Enter, like every other table of
  // games on the site (`useRowKeys`).
  const rowKeys = useRowKeys();

  return (
    <table className="ratings">
      <caption className="meta">
        Newest first. Both spreads are from this team&rsquo;s side, so a
        negative number is one it was favoured by.
      </caption>
      <thead>
        <tr>
          <th scope="col">Game</th>
          <th scope="col" className="num">
            Result
          </th>
          <th scope="col" className="num">
            Win prob
          </th>
          <th scope="col" className="num">
            Model
          </th>
          <th scope="col" className="num">
            Market
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const path = `/games/${league}/${row.game_id}?season=${row.season}`;
          return (
            <tr key={row.game_id} {...rowKeys(path)}>
              <td>
                <Link className="job-name" tabIndex={-1} to={path}>
                  {row.neutral ? "vs" : row.home ? "vs" : "@"} {row.opponent}
                </Link>
                <span className="when">{gameDay(row.date)}</span>
              </td>
              <Result row={row} />
              <td className="num">{probability(row.win_prob)}</td>
              <td className="num">{spread(row.predicted_spread)}</td>
              <td className="num">{spread(row.market_spread)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The score, and which way it went.
 *
 * A game with no score is one the run forecast and nobody has played yet --
 * the newest rows in the file are often those -- so the cell says nothing
 * rather than calling it a loss.
 */
function Result({ row }: { row: TeamGameRow }) {
  if (row.team_score == null || row.opponent_score == null) {
    return (
      <td className="num">
        <span className="quiet">&mdash;</span>
      </td>
    );
  }
  const won = row.team_score > row.opponent_score;
  return (
    <td className="num">
      <span className={won ? "up" : "down"}>{won ? "W" : "L"}</span>{" "}
      {row.team_score}&ndash;{row.opponent_score}
    </td>
  );
}

/** A game's day, in the zone the games are filed under. */
function gameDay(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString(undefined, {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
