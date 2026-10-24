import { useMemo, type ReactNode, type Ref } from "react";
import { Link } from "react-router-dom";

import { useRowKeys } from "../keys/useRowKeys";
import type { TeamRow, UnitRating } from "../../services/api";
import { movementTitle, placeMove, ratingMove, record } from "./movement";
import { leaguePercentile, population } from "./percentiles";
import { METRICS, readMetric, type Metric } from "./scatter";
import type { Sort, SortKey } from "./sort";
import { percentileLabel } from "../games/percentile";

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
   * The success rate and EPA per down columns this model keeps, in order --
   * the units models carry them beside their offense and defense, and the
   * pass / run splits only when the reader asked for them. Empty drops them
   * all, for the reason the unit columns are dropped.
   */
  stats: Metric[];
  /**
   * Every team on the table, unfiltered. A percentile is read against the
   * league, and typing into the filter shouldn't move anyone's.
   */
  leagueRows: TeamRow[];
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
  stats,
  leagueRows,
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

  const populations = useMemo(
    () => new Map(stats.map((m) => [m, population(leagueRows, m)])),
    [stats, leagueRows],
  );

  if (rows.length === 0) {
    return <p className="empty">No teams match that search.</p>;
  }

  const sorting = { sort, onSort };

  return (
    // Scrolls sideways in its own box rather than widening the page: ten
    // columns don't fit a phone, and every one of them is a sort a reader can
    // ask for, so none is dropped. The team's name stays pinned to the left
    // edge while the numbers behind it scroll -- see `.ratings .team`.
    <div className="table-scroll">
      <table className="ratings">
        <thead>
          <tr>
            <SortHeader column="rank" label="#" className="rank" {...sorting} />
            <SortHeader column="rating" label="Rating" {...sorting} />
            <SortHeader column="record" label={<>W&ndash;L</>} {...sorting} />
            <SortHeader
              column="team"
              label="Team"
              className="team"
              text
              {...sorting}
            />
            {showRd && <SortHeader column="rd" label="RD" {...sorting} />}
            {showUnits && (
              <>
                <SortHeader column="offense" label="Off" {...sorting} />
                <SortHeader column="defense" label="Def" {...sorting} />
              </>
            )}
            {stats.map((metric) => (
              <SortHeader
                key={metric}
                column={metric}
                label={
                  <abbr title={STAT_TITLES[metric]}>{STAT_LABELS[metric]}</abbr>
                }
                {...sorting}
              />
            ))}
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
              <td className="team">
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
              {stats.map((metric) => (
                <StatCell
                  key={metric}
                  row={row}
                  metric={metric}
                  all={populations.get(metric) ?? []}
                />
              ))}
              {since && <MovementCell row={row} since={since} />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
 * One stat -- a success rate or an EPA per down -- and where it puts the team
 * in the league.
 *
 * Opponent-adjusted, against an average opponent on a neutral field, so it is
 * not the number the team posted; the deviation goes in the title the way a
 * unit's does. Under it the percentile among the league's teams, in the
 * two-line shape the Week column uses. A dash for a team with no plays on file.
 */
function StatCell({
  row,
  metric,
  all,
}: {
  row: TeamRow;
  metric: Metric;
  all: number[];
}) {
  const reading = readMetric(row, metric);
  if (!reading) {
    return (
      <td className="num">
        <span className="quiet">&mdash;</span>
      </td>
    );
  }
  const info = METRICS[metric];
  const place = percentileLabel(leaguePercentile(all, reading.value, metric));
  return (
    <td className="num stat">
      <abbr
        className="unit"
        title={
          reading.sd != null && info.spread
            ? info.spread(reading.sd)
            : undefined
        }
      >
        {info.format(reading.value)}
      </abbr>
      {place && (
        <span
          className="places"
          title={`${place} percentile of ${all.length} teams${info.reversed ? " (lower is better)" : ""}`}
        >
          {place}
        </span>
      )}
    </td>
  );
}

const STAT_LABELS: Partial<Record<Metric, string>> = {
  offenseSuccess: "Off SR",
  defenseSuccess: "Def SR",
  offensePassSuccess: "Pass SR",
  defensePassSuccess: "Pass SR allowed",
  offenseRunSuccess: "Run SR",
  defenseRunSuccess: "Run SR allowed",
  offenseEpa: "Off EPA",
  defenseEpa: "Def EPA",
  offensePassEpa: "Pass EPA",
  defensePassEpa: "Pass EPA allowed",
  offenseRunEpa: "Run EPA",
  defenseRunEpa: "Run EPA allowed",
};

const STAT_TITLES: Partial<Record<Metric, string>> = {
  offenseSuccess:
    "Success rate: the share of its downs this offense wins against an average defense",
  defenseSuccess:
    "Success rate allowed: the share of downs an average offense wins against this defense -- lower is better",
  offensePassSuccess:
    "Success rate on this offense's passes (sacks and scrambles included)",
  defensePassSuccess:
    "Success rate this defense allows on passes -- lower is better",
  offenseRunSuccess: "Success rate on this offense's runs",
  defenseRunSuccess:
    "Success rate this defense allows on runs -- lower is better",
  offenseEpa:
    "Expected points added per pass or run by this offense against an average defense",
  defenseEpa:
    "Expected points added per down this defense allows to an average offense -- lower is better",
  offensePassEpa: "Expected points added per pass by this offense",
  defensePassEpa:
    "Expected points per pass this defense allows -- lower is better",
  offenseRunEpa: "Expected points added per run by this offense",
  defenseRunEpa:
    "Expected points per run this defense allows -- lower is better",
};

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
