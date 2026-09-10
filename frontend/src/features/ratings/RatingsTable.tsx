import { Link } from "react-router-dom";

import type { TeamRow } from "../../services/api";
import { movementTitle, placeMove, ratingMove, record } from "./movement";

interface Props {
  rows: TeamRow[];
  /** Which league's team pages the names link to. */
  league: string;
  /** Glicko has a rating deviation; Elo doesn't, so the column is dropped. */
  showRd: boolean;
  /**
   * When the week every movement is measured from ended, or null where the
   * history can't say -- a model published without one, or the first week of
   * a season. Null drops the column rather than filling it with dashes.
   */
  since: string | null;
}

export function RatingsTable({ rows, league, showRd, since }: Props) {
  if (rows.length === 0) {
    return <p className="empty">No teams match that search.</p>;
  }

  return (
    <table className="ratings">
      <thead>
        <tr>
          <th scope="col" className="num">
            #
          </th>
          <th scope="col">Team</th>
          <th scope="col" className="num">
            Rating
          </th>
          {showRd && (
            <th scope="col" className="num">
              RD
            </th>
          )}
          <th scope="col" className="num">
            W&ndash;L
          </th>
          {since && (
            <th scope="col" className="num">
              Week
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.team}>
            <td className="num rank">{row.rank}</td>
            <td>
              {/* The name is the way into the team's own page, the same way a
                  matchup is the way into a game's. Coloured like text rather
                  than like a link: a table whose every second cell is blue
                  reads as a page of links rather than as a leaderboard. */}
              <Link
                className="job-name"
                to={`/${league}/teams/${encodeURIComponent(row.team)}`}
              >
                {row.team}
              </Link>
            </td>
            <td className="num">{row.rating.toFixed(1)}</td>
            {showRd && <td className="num">{row.rd?.toFixed(1) ?? "—"}</td>}
            <td className="num">
              {row.wins}&ndash;{row.losses}
            </td>
            {since && <MovementCell row={row} since={since} />}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * What the week did, in the two-line shape the games table already uses: the
 * number, and then what it was of.
 *
 * A team with no movement is one whose first game was this week -- there is no
 * previous rating to subtract, and a zero would claim there was one.
 */
function MovementCell({ row, since }: { row: TeamRow; since: string }) {
  const movement = row.movement;
  if (!movement) {
    return (
      <td className="num move">
        <span className="quiet">&mdash;</span>
      </td>
    );
  }

  const places = placeMove(movement.rank);
  const played = record(movement.wins, movement.losses);
  return (
    <td className="num move">
      <abbr className="delta" title={movementTitle(movement, since)}>
        {ratingMove(movement.rating)}
      </abbr>
      {(places || played) && (
        <span className="places">
          {places && (
            <span className={places.up ? "up" : "down"}>
              {places.glyph}
              {places.count}
            </span>
          )}
          {places && played && " · "}
          {played}
        </span>
      )}
    </td>
  );
}
