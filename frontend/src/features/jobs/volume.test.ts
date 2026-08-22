import { describe, expect, it } from "vitest";

import type { OddsDay } from "../../services/api";
import { byLeague } from "./volume";

const day = (
  league: string,
  date: string,
  pulls: number,
  extra: Partial<OddsDay> = {},
): OddsDay => ({
  league,
  day: date,
  pulls,
  bytes: pulls * 100,
  latest_at: null,
  latest_records: null,
  ...extra,
});

describe("byLeague", () => {
  it("totals the window and keeps the per-day rows", () => {
    // A weekly total hides the shape: 13 a day and then 2 today is an odds
    // job that has quietly stopped, and it still sums to a healthy number.
    const [nfl] = byLeague([
      day("nfl", "2026-08-22", 2),
      day("nfl", "2026-08-21", 13),
    ]);

    expect(nfl.pulls).toBe(15);
    expect(nfl.days.map((d) => d.pulls)).toEqual([2, 13]);
  });

  it("takes the record count from the newest pull, not the first one found", () => {
    const [nfl] = byLeague([
      day("nfl", "2026-08-21", 13, {
        latest_at: "2026-08-21T22:00:00Z",
        latest_records: 61,
      }),
      day("nfl", "2026-08-22", 2, {
        latest_at: "2026-08-22T14:00:00Z",
        latest_records: 4,
      }),
    ]);

    expect(nfl.latestAt).toBe("2026-08-22T14:00:00Z");
    expect(nfl.latestRecords).toBe(4);
  });

  it("keeps zero records as an answer", () => {
    // The offseason case: the job succeeds every hour and pulls nothing.
    const [ncaabb] = byLeague([
      day("ncaabb", "2026-08-22", 12, {
        latest_at: "2026-08-22T14:00:00Z",
        latest_records: 0,
      }),
    ]);

    expect(ncaabb.latestRecords).toBe(0);
  });

  it("sorts leagues so the table doesn't reshuffle", () => {
    const rows = byLeague([
      day("nfl", "2026-08-22", 1),
      day("ncaabb", "2026-08-22", 1),
    ]);
    expect(rows.map((r) => r.league)).toEqual(["ncaabb", "nfl"]);
  });

  it("is empty for an empty window", () => {
    expect(byLeague([])).toEqual([]);
  });
});
