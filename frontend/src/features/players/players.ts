/**
 * The Players table's rows: who clears the floor, in what order.
 *
 * Every column sorts best-first on the first click, as the leaderboard's do,
 * and a player with nothing in the column goes to the bottom in both
 * directions. The floor keeps someone the box scores have no minutes for out,
 * rather than claiming he played none or all of them.
 */

import type { PlayerRow } from "../../services/api";

export type PlayerSortKey =
  | "player"
  | "team"
  | "offense"
  | "defense"
  | "total"
  | "total_sd"
  | "vs_team"
  | "games"
  | "starts"
  | "per_game"
  | "share";

export type SortDirection = "asc" | "desc";

export interface PlayerSort {
  key: PlayerSortKey;
  direction: SortDirection;
}

export const BY_TOTAL: PlayerSort = { key: "total", direction: "desc" };

/** Of the team's time on the floor, as a percentage: about 4 minutes a game. */
export const DEFAULT_FLOOR = 10;

/** The words read A to Z, and the surest rating is the one with the least ±. */
const BEST_FIRST = (key: PlayerSortKey): SortDirection =>
  key === "player" || key === "team" || key === "total_sd" ? "asc" : "desc";

export function nextSort(current: PlayerSort, key: PlayerSortKey): PlayerSort {
  if (current.key !== key) return { key, direction: BEST_FIRST(key) };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** Minutes a game, or null for someone yet to play or missing a box score. */
export function perGame(row: PlayerRow): number | null {
  if (!row.games || row.minutes == null) return null;
  return row.minutes / row.games;
}

function value(row: PlayerRow, key: PlayerSortKey): number | string | null {
  switch (key) {
    case "per_game":
      return perGame(row);
    // Nothing played yet is nothing to rank: not the fewest games in the
    // league, which reversing the column would bring to the top.
    case "games":
    case "starts":
      return row.projected ? null : (row[key] ?? null);
    default:
      return row[key] ?? null;
  }
}

export function sortPlayers(rows: PlayerRow[], sort: PlayerSort): PlayerRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a, sort.key);
    const right = value(b, sort.key);
    if (left == null || right == null) {
      if (left != null) return -1;
      if (right != null) return 1;
      return b.total - a.total;
    }
    const order =
      typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right)
        : (left as number) - (right as number);
    return order !== 0 ? sign * order : b.total - a.total;
  });
}

export function filterPlayers(
  rows: PlayerRow[],
  search: string,
  floor: number,
): PlayerRow[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => {
    if ((row.share ?? -1) * 100 < floor) return false;
    if (!needle) return true;
    return (
      (row.player ?? "").toLowerCase().includes(needle) ||
      (row.team ?? "").toLowerCase().includes(needle)
    );
  });
}

/** Seasons are named for the year they start: 2025 reads "2025-26". */
export function seasonLabel(season: number): string {
  return `${season}-${String((season + 1) % 100).padStart(2, "0")}`;
}
