/**
 * The order a reader asked the ratings table for.
 *
 * Every column sorts, and each one sorts best-first on the first click: a
 * leaderboard re-sorted by offense is a question about the best offenses, and
 * making a reader click twice to get them would answer a question nobody asks.
 * "Best" is not always "biggest" -- a lower RD is the more settled rating, and
 * a lower success rate allowed is the better defense -- so each column says
 * which way it starts.
 *
 * A row with nothing in the column (a team with no plays on file, or whose
 * first game was this week) goes to the bottom in both directions. Reversing
 * the sort is a request to see the other end of the numbers, not to fill the
 * top of the table with dashes.
 *
 * Ties fall back to the model's own rank, so a re-sort never shuffles teams
 * the column can't tell apart.
 */

import type { TeamRow } from "../../services/api";

export type SortKey =
  | "rank"
  | "rating"
  | "record"
  | "team"
  | "rd"
  | "offense"
  | "defense"
  | "offenseSuccess"
  | "defenseSuccess"
  | "week";

export type SortDirection = "asc" | "desc";

export interface Sort {
  key: SortKey;
  direction: SortDirection;
}

/** The table as the model ranked it. */
export const MODEL_ORDER: Sort = { key: "rank", direction: "asc" };

/** Which way each column reads best-first. */
const BEST_FIRST: Record<SortKey, SortDirection> = {
  rank: "asc",
  rating: "desc",
  record: "desc",
  team: "asc",
  rd: "asc",
  offense: "desc",
  defense: "desc",
  offenseSuccess: "desc",
  defenseSuccess: "asc",
  week: "desc",
};

/**
 * The sort a click on a column's heading asks for: best-first on a new column,
 * and the other way round on the one already sorted.
 */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) return { key, direction: BEST_FIRST[key] };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** What a column sorts a row on, or null where the row has nothing there. */
function value(row: TeamRow, key: SortKey): number | string | null {
  switch (key) {
    case "rank":
      return row.rank;
    case "rating":
      return row.rating;
    case "record":
      return winShare(row);
    case "team":
      return row.team;
    case "rd":
      return row.rd ?? null;
    case "offense":
      return row.offense?.rating ?? null;
    case "defense":
      return row.defense?.rating ?? null;
    case "offenseSuccess":
      return row.success?.offense.rate ?? null;
    case "defenseSuccess":
      return row.success?.defense.rate ?? null;
    case "week":
      return row.movement?.rating ?? null;
  }
}

/**
 * A record as the share of games won, which is what a column of W-L is
 * read for. A team that hasn't played has no share to rank on -- 0-0 is not
 * the same record as 0-5.
 */
function winShare(row: TeamRow): number | null {
  const played = row.wins + row.losses;
  return played === 0 ? null : row.wins / played;
}

export function sortRows(rows: TeamRow[], sort: Sort): TeamRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a, sort.key);
    const right = value(b, sort.key);
    if (left == null || right == null) {
      if (left != null) return -1;
      if (right != null) return 1;
      return a.rank - b.rank;
    }
    const order =
      typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right)
        : (left as number) - (right as number);
    if (order !== 0) return sign * order;
    // Same share of games won: the team with more of them is the one that
    // has shown it longer. Then the model's rank, whichever way the column
    // runs.
    if (sort.key === "record" && a.wins !== b.wins) {
      return sign * (a.wins - b.wins);
    }
    return a.rank - b.rank;
  });
}
