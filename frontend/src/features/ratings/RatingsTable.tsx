import type { ReactNode, Ref } from "react";
import { Link } from "react-router-dom";

import { useRowKeys } from "../keys/useRowKeys";
import type { RateRating, TeamRow, UnitRating } from "../../services/api";
import { movementTitle, placeMove, ratingMove, record } from "./movement";
import type { Sort, SortKey } from "./sort";

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
   * Whether this model keeps each side's success rate -- the units models do,
   * beside their offense and defense. Dropped otherwise, for the reason the
   * unit columns are.
   */
  showSuccess: boolean;
  /**
   * When the week every movement is measured from ended, or null where the
   * history can't say -- a model published without one, or the first week of
   * a season. Null drops the column rather than filling it with dashes.
   */
  since: string | null;
  /** The order the rows arrive in, which the headings mark. */
  sort: Sort;
  /** A heading was clicked: re-sort on its column. */
  onSort: (key: SortKey) => void;
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
  showSuccess,
  since,
  sort,
  onSort,
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

  const sorting = { sort, onSort };

  return (
    <table className="ratings">
      <thead>
        <tr>
          <SortHeader column="rank" label="#" className="rank" {...sorting} />
          <SortHeader column="rating" label="Rating" {...sorting} />
          <SortHeader column="record" label={<>W&ndash;L</>} {...sorting} />
          <SortHeader column="team" label="Team" text {...sorting} />
          {showRd && <SortHeader column="rd" label="RD" {...sorting} />}
          {showUnits && (
            <>
              <SortHeader column="offense" label="Off" {...sorting} />
              <SortHeader column="defense" label="Def" {...sorting} />
            </>
          )}
          {showSuccess && (
            <>
              <SortHeader
                column="offenseSuccess"
                label={
                  <abbr title="Success rate: the share of its downs this offense wins against an average defense">
                    Off SR
                  </abbr>
                }
                {...sorting}
              />
              <SortHeader
                column="defenseSuccess"
                label={
                  <abbr title="Success rate allowed: the share of downs an average offense wins against this defense -- lower is better">
                    Def SR
                  </abbr>
                }
                {...sorting}
              />
            </>
          )}
          {since && <SortHeader column="week" label="Week" {...sorting} />}
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
            <td className="num">{row.rating.toFixed(1)}</td>
            <td className="num">
              {row.wins}&ndash;{row.losses}
            </td>
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
            {showRd && <td className="num">{row.rd?.toFixed(1) ?? "—"}</td>}
            {showUnits && (
              <>
                <UnitCell unit={row.offense} />
                <UnitCell unit={row.defense} />
              </>
            )}
            {showSuccess && (
              <>
                <RateCell rate={row.success?.offense} />
                <RateCell rate={row.success?.defense} />
              </>
            )}
            {since && <MovementCell row={row} since={since} />}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A column heading that sorts the table on its column.
 *
 * The click target is a button inside the heading rather than the heading
 * itself, so it is a tab stop and answers to Enter and Space the way any other
 * control does. `aria-sort` sits on the heading, where a screen reader looks
 * for it; the arrow is for everyone else, and only on the sorted column -- an
 * arrow on every heading would be ten things saying the same nothing.
 */
function SortHeader({
  column,
  label,
  className,
  text = false,
  sort,
  onSort,
}: {
  column: SortKey;
  label: ReactNode;
  className?: string;
  /** A column of words rather than numbers, aligned to the left. */
  text?: boolean;
  sort: Sort;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === column;
  const classes = [text ? null : "num", className].filter(Boolean).join(" ");
  return (
    <th
      scope="col"
      className={classes || undefined}
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <button type="button" className="sort" onClick={() => onSort(column)}>
        {label}
        {active && (
          <span className="arrow" aria-hidden="true">
            {sort.direction === "asc" ? "▲" : "▼"}
          </span>
        )}
      </button>
    </th>
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
 * One side's success rate, as a percentage of its downs.
 *
 * Opponent-adjusted -- against an average opponent on a neutral field -- so
 * it is not the share the team posted, and the deviation goes in the title the
 * way a unit's does. A dash for a team with no plays on file, as for its units.
 */
function RateCell({ rate }: { rate: RateRating | null | undefined }) {
  if (!rate) {
    return (
      <td className="num">
        <span className="quiet">&mdash;</span>
      </td>
    );
  }
  return (
    <td className="num">
      <abbr className="unit" title={`± ${(rate.sd * 100).toFixed(1)} pts`}>
        {(rate.rate * 100).toFixed(1)}%
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
