import type { ReactNode } from "react";

import type { PlayerRow } from "../../services/api";
import {
  nextSort,
  perGame,
  type PlayerSort,
  type PlayerSortKey,
} from "./players";

const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;

/**
 * The players' table, on the Players page and a team's. A team's leaves out
 * the Team column, every row being the same one, and says what it holds in a
 * caption, as the other tables on that page do.
 */
export function PlayersTable({
  rows,
  sort,
  onSort,
  showTeam = true,
  caption,
}: {
  rows: PlayerRow[];
  sort: PlayerSort;
  onSort: (next: PlayerSort) => void;
  showTeam?: boolean;
  caption?: ReactNode;
}) {
  return (
    <div className="table-scroll">
      <table className="ratings players">
        {caption && <caption className="meta">{caption}</caption>}
        <thead>
          <tr>
            <Header
              column="player"
              label="Player"
              text
              className="team"
              sort={sort}
              on={onSort}
            />
            <Header column="total" label="Total" sort={sort} on={onSort} />
            <Header
              column="total_sd"
              label={
                <abbr title="How sure the total is: one standard deviation">
                  ±
                </abbr>
              }
              sort={sort}
              on={onSort}
            />
            <Header column="offense" label="Off" sort={sort} on={onSort} />
            <Header column="defense" label="Def" sort={sort} on={onSort} />
            <Header
              column="vs_team"
              label={
                <abbr title="The total without the fifth of it that's his team's rating">
                  vs Team
                </abbr>
              }
              sort={sort}
              on={onSort}
            />
            {showTeam && (
              <Header column="team" label="Team" text sort={sort} on={onSort} />
            )}
            <Header column="games" label="G" sort={sort} on={onSort} />
            <Header column="starts" label="GS" sort={sort} on={onSort} />
            <Header
              column="per_game"
              label={<abbr title="Minutes a game">MPG</abbr>}
              sort={sort}
              on={onSort}
            />
            <Header
              column="share"
              label={
                <abbr title="Share of the team's minutes on the floor; projected for someone yet to play">
                  Share
                </abbr>
              }
              sort={sort}
              on={onSort}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row
              key={`${row.athlete_id}-${row.team_id}`}
              row={row}
              showTeam={showTeam}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row, showTeam }: { row: PlayerRow; showTeam: boolean }) {
  const minutes = perGame(row);
  return (
    <tr className={row.projected ? "projected" : undefined}>
      <td className="team">
        {row.player ?? "Unnamed"}
        {row.projected && (
          <abbr
            className="tag"
            title="Hasn't played: rated on his prior, at projected minutes"
          >
            proj
          </abbr>
        )}
      </td>
      <td className="num">{signed(row.total)}</td>
      <td className="num">{row.total_sd.toFixed(1)}</td>
      <td className="num" title={`± ${row.offense_sd.toFixed(1)}`}>
        {signed(row.offense)}
      </td>
      <td className="num" title={`± ${row.defense_sd.toFixed(1)}`}>
        {signed(row.defense)}
      </td>
      <td className="num">{signed(row.vs_team)}</td>
      {showTeam && <td>{row.team ?? ""}</td>}
      <td className="num">{row.projected ? "" : (row.games ?? "")}</td>
      <td className="num">{row.projected ? "" : (row.starts ?? "")}</td>
      <td className="num">{minutes == null ? "" : minutes.toFixed(1)}</td>
      <td className="num">
        {row.share == null ? "" : `${(row.share * 100).toFixed(0)}%`}
      </td>
    </tr>
  );
}

function Header({
  column,
  label,
  text = false,
  className,
  sort,
  on,
}: {
  column: PlayerSortKey;
  label: ReactNode;
  /** A column of words rather than numbers, aligned to the left. */
  text?: boolean;
  className?: string;
  sort: PlayerSort;
  on: (next: PlayerSort) => void;
}) {
  const active = sort.key === column;
  return (
    <th
      scope="col"
      className={
        [text ? null : "num", className].filter(Boolean).join(" ") || undefined
      }
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <button
        type="button"
        className="sort"
        onClick={() => on(nextSort(sort, column))}
      >
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
