import { describe, expect, it } from "vitest";

import type { TeamRow } from "../../services/api";
import { teamMetrics } from "./teamMetrics";

const row = (team: string, rating: number, defense?: number): TeamRow =>
  ({
    rank: 1,
    team,
    rating,
    rd: null,
    wins: 0,
    losses: 0,
    success:
      defense == null
        ? null
        : {
            offense: { rate: 0.45, sd: 0.01 },
            defense: { rate: defense, sd: 0.01 },
          },
  }) as TeamRow;

describe("teamMetrics", () => {
  const rows = [
    row("A", 1600, 0.4),
    row("B", 1500, 0.35),
    row("C", 1500, 0.5),
    row("D", 1400),
  ];

  it("ranks higher ratings better and ties share the better place", () => {
    const [rating] = teamMetrics(rows, "B", "C");
    expect(rating.away).toEqual({
      value: "1500.0",
      rank: 2,
      of: 4,
      percentile: "50th",
    });
    expect(rating.home?.rank).toBe(2);
  });

  it("ranks a lower success rate allowed as better, among teams that have one", () => {
    const def = teamMetrics(rows, "A", "B").find((m) =>
      m.label.startsWith("Def SR"),
    );
    expect(def?.away).toEqual({
      value: "40.0%",
      rank: 2,
      of: 3,
      percentile: "50th",
    });
    expect(def?.home?.rank).toBe(1);
  });

  it("rows the pass and run splits and EPA beside the success rates", () => {
    const withSplits: TeamRow = {
      ...row("E", 1550, 0.4),
      epa: {
        offense: { epa: 0.1, sd: 0.02 },
        defense: { epa: -0.1, sd: 0.02 },
        passes: {
          offense: { epa: 0.2, sd: 0.03 },
          defense: { epa: -0.05, sd: 0.03 },
        },
      },
    } as TeamRow;
    const labels = teamMetrics([withSplits], "E", "E").map((m) => m.label);
    expect(labels).toContain("Off EPA/down");
    expect(labels).toContain("Def pass EPA allowed");
    // The model published no run split, so there is no row to promise one.
    expect(labels).not.toContain("Off run EPA");
  });

  it("leaves a team without the metric as null, and drops unrated teams", () => {
    const def = teamMetrics(rows, "A", "D").find((m) =>
      m.label.startsWith("Def SR"),
    );
    expect(def?.home).toBeNull();
    expect(teamMetrics(rows, "X", "Y")).toEqual([]);
  });
});
