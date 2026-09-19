import type { Ref } from "react";
import { Link } from "react-router-dom";

import { useRowKeys } from "../keys/useRowKeys";
import type { TeamRow, UnitRating } from "../../services/api";
import { movementTitle, placeMove, ratingMove, record } from "./movement";

interface Props {
  rows: TeamRow[];
  /** Which league's team pages the names link to. */
  league: string;
  /** Glicko has a rating deviation; Elo doesn't, so the column is dropped. */
  showRd: boolean;
  /**
   * Whether this model rates a team's two halves apart. Only the compound
   * Glicko does, so for every other model the pair of columns is dropped
   * rather than filled with dashes the width of a rating.
   */
  showUnits: boolean;
  /**
   * When the week every movement is measured from ended, or null where the
   * history can't say -- a model published without one, or the first week of
   * a season. Null drops the column rather than filling it with dashes.
   */
  since: string | null;
  /** The row the filter box's Down key hands focus to. */
  firstRowRef?: Ref<HTMLTableRowElement>;
  /** Where Up goes from that row -- back to the filter box. */
  onExitTop?: () => void;
}

export function RatingsTable({
  rows,
  league,
  showRd,
  showUnits,
  since,
  firstRowRef,
  onExitTop,
}: Props) {
  // Every row is a tab stop and an arrow stop, and Enter opens the team --
  // see `useRowKeys`. Called before the early return below, because a hook
  // has to be.
  const rowKeys = useRowKeys({ onExitTop });

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
          {showUnits && (
            <>
              <th scope="col" className="num">
                Off
              </th>
              <th scope="col" className="num">
                Def
              </th>
            </>
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
        {rows.map((row, index) => (
          <tr
            key={row.team}
            ref={index === 0 ? firstRowRef : undefined}
            {...rowKeys(teamPath(league, row.team))}
          >
            <td className="num rank">{row.rank}</td>
            <td>
              {/* The name is the way into the team's own page, the same way a
                  matchup is the way into a game's. Coloured like text rather
                  than like a link: a table whose every second cell is blue
                  reads as a page of links rather than as a leaderboard. */}
              {/* Out of the tab order, because the row it sits in is in it:
                  one stop per team either way, and the focused thing is the
                  whole line rather than six words of it. */}
              <Link
                className="job-name"
                tabIndex={-1}
                to={teamPath(league, row.team)}
              >
                {row.team}
              </Link>
            </td>
            <td className="num">{row.rating.toFixed(1)}</td>
            {showRd && <td className="num">{row.rd?.toFixed(1) ?? "—"}</td>}
            {showUnits && (
              <>
                <UnitCell unit={row.offense} />
                <UnitCell unit={row.defense} />
              </>
            )}
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

/** Where a team's name leads, and where Enter on its row goes. */
function teamPath(league: string, team: string): string {
  return `/${league}/teams/${encodeURIComponent(team)}`;
}

/**
 * One side of a team, on the same scale as the rating beside it.
 *
 * The deviation goes in the title rather than in a column of its own: two more
 * numeric columns would double what this table asks a reader to hold, and how
 * settled a side's number is matters at the moment you doubt it rather than at
 * a glance.
 *
 * A dash for a team the model rates on its record alone. The column exists
 * because *some* team in this league has units, which is not a promise that
 * every one does -- a team with no plays on file has earned nothing to show.
 */
function UnitCell({ unit }: { unit: UnitRating | null | undefined }) {
  if (!unit) {
    return (
      <td className="num">
        <span className="quiet">&mdash;</span>
      </td>
    );
  }
  return (
    <td className="num">
      <abbr className="unit" title={`RD ${unit.rd.toFixed(1)}`}>
        {unit.rating.toFixed(1)}
      </abbr>
    </td>
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
