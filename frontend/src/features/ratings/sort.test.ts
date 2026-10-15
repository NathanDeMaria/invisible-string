import { describe, expect, it } from "vitest";

import type { TeamRow } from "../../services/api";
import { MODEL_ORDER, nextSort, sortRows } from "./sort";

const team = (overrides: Partial<TeamRow>): TeamRow => ({
  team: "Team",
  rank: 1,
  rating: 1500,
  rd: 50,
  wins: 0,
  losses: 0,
  ...overrides,
});

const names = (rows: TeamRow[]) => rows.map((row) => row.team);

describe("nextSort", () => {
  it("starts a new column best-first", () => {
    expect(nextSort(MODEL_ORDER, "rating")).toEqual({
      key: "rating",
      direction: "desc",
    });
    // Lower is better for these two.
    expect(nextSort(MODEL_ORDER, "rd").direction).toBe("asc");
    expect(nextSort(MODEL_ORDER, "defenseSuccess").direction).toBe("asc");
  });

  it("flips the column already sorted", () => {
    const once = nextSort(MODEL_ORDER, "offense");
    expect(nextSort(once, "offense")).toEqual({
      key: "offense",
      direction: "asc",
    });
    expect(nextSort(MODEL_ORDER, "rank")).toEqual({
      key: "rank",
      direction: "desc",
    });
  });
});

describe("sortRows", () => {
  it("leaves the rows it was given alone", () => {
    const rows = [team({ team: "B", rank: 2 }), team({ team: "A", rank: 1 })];
    sortRows(rows, MODEL_ORDER);
    expect(names(rows)).toEqual(["B", "A"]);
  });

  it("sorts a record by the share of games won, then by wins", () => {
    const rows = [
      team({ team: "Half", rank: 1, wins: 5, losses: 5 }),
      team({ team: "Unbeaten short", rank: 2, wins: 2, losses: 0 }),
      team({ team: "Unbeaten long", rank: 3, wins: 9, losses: 0 }),
      team({ team: "Winless", rank: 4, wins: 0, losses: 3 }),
    ];
    expect(names(sortRows(rows, { key: "record", direction: "desc" }))).toEqual(
      ["Unbeaten long", "Unbeaten short", "Half", "Winless"],
    );
  });

  it("keeps a row with nothing in the column at the bottom both ways", () => {
    const rows = [
      team({ team: "No plays", rank: 1 }),
      team({ team: "Good", rank: 2, offense: { rating: 1900, rd: 70 } }),
      team({ team: "Bad", rank: 3, offense: { rating: 1600, rd: 70 } }),
    ];
    expect(
      names(sortRows(rows, { key: "offense", direction: "desc" })),
    ).toEqual(["Good", "Bad", "No plays"]);
    expect(names(sortRows(rows, { key: "offense", direction: "asc" }))).toEqual(
      ["Bad", "Good", "No plays"],
    );
  });

  it("counts a team that hasn't played as having no record", () => {
    // 0-0 is not 0-5: a team yet to play has no share to rank on.
    const rows = [
      team({ team: "Unplayed", rank: 1 }),
      team({ team: "Winless", rank: 2, wins: 0, losses: 5 }),
    ];
    expect(names(sortRows(rows, { key: "record", direction: "asc" }))).toEqual([
      "Winless",
      "Unplayed",
    ]);
  });

  it("breaks a tie on the model's rank", () => {
    const rows = [
      team({ team: "Third", rank: 3, rd: 40 }),
      team({ team: "First", rank: 1, rd: 40 }),
      team({ team: "Second", rank: 2, rd: 40 }),
    ];
    expect(names(sortRows(rows, { key: "rd", direction: "desc" }))).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("sorts names alphabetically", () => {
    const rows = [
      team({ team: "Ohio State", rank: 1 }),
      team({ team: "Alabama", rank: 2 }),
    ];
    expect(names(sortRows(rows, { key: "team", direction: "asc" }))).toEqual([
      "Alabama",
      "Ohio State",
    ]);
  });
});
