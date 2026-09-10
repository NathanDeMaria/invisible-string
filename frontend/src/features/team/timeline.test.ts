import { describe, expect, it } from "vitest";

import type { HistoryPoint } from "../../services/api";
import {
  acrossThePlot,
  bounds,
  linePath,
  nearest,
  plotBox,
  ratingY,
  seasons,
  summary,
  ticks,
} from "./timeline";

const week = (
  year: number,
  weekNumber: number,
  rating: number,
): HistoryPoint => ({
  year,
  week: weekNumber,
  date: `${year}-11-${String(weekNumber + 6).padStart(2, "0")}T23:00:00Z`,
  rating,
  rd: 71.4,
  wins: weekNumber,
  losses: 1,
});

const TWO_SEASONS = [
  week(2025, 1, 1702),
  week(2025, 2, 1718.4),
  week(2025, 3, 1766.3),
  week(2026, 1, 1810),
  week(2026, 2, 1834.2),
];

describe("seasons", () => {
  it("splits the series where the year changes", () => {
    const runs = seasons(TWO_SEASONS);
    expect(runs.map((run) => run.year)).toEqual([2025, 2026]);
    expect(runs[0].points).toHaveLength(3);
    expect(runs[1].points).toHaveLength(2);
  });

  it("keeps each run's place in the whole series", () => {
    // What puts a season's label over its own weeks rather than over the
    // middle of the chart.
    const runs = seasons(TWO_SEASONS);
    expect([runs[0].from, runs[0].to]).toEqual([0, 2]);
    expect([runs[1].from, runs[1].to]).toEqual([3, 4]);
  });

  it("does not rejoin a season the team came back to", () => {
    // A program that stopped and restarted. Grouping by year would draw one
    // line across the years it didn't play.
    const runs = seasons([
      week(2025, 1, 1700),
      week(2026, 1, 1710),
      week(2025, 2, 1720),
    ]);
    expect(runs.map((run) => run.year)).toEqual([2025, 2026, 2025]);
  });

  it("has nothing to split when there are no points", () => {
    expect(seasons([])).toEqual([]);
  });
});

describe("bounds", () => {
  it("rounds to numbers a reader recognises", () => {
    const scale = bounds(TWO_SEASONS);
    expect(scale.low % scale.step).toBe(0);
    expect(scale.high % scale.step).toBe(0);
  });

  it("leaves the line off the top and bottom edges", () => {
    const scale = bounds(TWO_SEASONS);
    expect(scale.low).toBeLessThan(1702);
    expect(scale.high).toBeGreaterThan(1834.2);
  });

  it("gives a flat series a band rather than a zero-height axis", () => {
    // One week of history, or a team that hasn't moved. Without this the
    // line is drawn along the top of the plot and the scale divides by zero.
    const scale = bounds([week(2026, 1, 1500)]);
    expect(scale.high).toBeGreaterThan(scale.low);
    expect(ratingY(1500, scale, plotBox())).toBeGreaterThan(plotBox().y);
  });

  it("survives having no points at all", () => {
    const scale = bounds([]);
    expect(scale.high).toBeGreaterThan(scale.low);
  });
});

describe("ticks", () => {
  it("labels the axis from bottom to top", () => {
    const scale = bounds(TWO_SEASONS);
    const values = ticks(scale);
    expect(values[0]).toBe(scale.low);
    expect(values[values.length - 1]).toBe(scale.high);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("stays a handful, not a ladder", () => {
    const values = ticks(bounds(TWO_SEASONS));
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(values.length).toBeLessThanOrEqual(9);
  });
});

describe("the axes", () => {
  it("spaces points evenly across the plot", () => {
    expect(acrossThePlot(0, 5)).toBe(0);
    expect(acrossThePlot(2, 5)).toBe(0.5);
    expect(acrossThePlot(4, 5)).toBe(1);
  });

  it("puts a lone point in the middle", () => {
    // With nothing to compare it to there is no "across" for it to be at the
    // start of.
    expect(acrossThePlot(0, 1)).toBe(0.5);
  });

  it("puts a higher rating higher up", () => {
    const scale = bounds(TWO_SEASONS);
    const box = plotBox();
    expect(ratingY(1834.2, scale, box)).toBeLessThan(ratingY(1702, scale, box));
  });
});

describe("linePath", () => {
  it("draws one path per season, not one across them", () => {
    // The gap is the offseason: `pass_season` regressed the rating, no game
    // did. A segment across it would show a slide nobody played.
    const box = plotBox();
    const scale = bounds(TWO_SEASONS);
    const [first, second] = seasons(TWO_SEASONS);
    expect(linePath(first, TWO_SEASONS.length, scale, box)).toMatch(/^M/);
    expect(linePath(second, TWO_SEASONS.length, scale, box)).toMatch(/^M/);
    // Each path starts once and only moves through its own weeks.
    expect(
      linePath(first, TWO_SEASONS.length, scale, box).match(/M/g),
    ).toHaveLength(1);
  });

  it("has nothing to draw for a season of one week", () => {
    // The component puts a marker there instead, so the week is still on the
    // chart rather than silently missing from it.
    const points = [week(2026, 1, 1810)];
    const [only] = seasons(points);
    expect(linePath(only, 1, bounds(points), plotBox())).toBe("");
  });
});

describe("nearest", () => {
  it("finds the point under the pointer", () => {
    expect(nearest(0, 5)).toBe(0);
    expect(nearest(0.5, 5)).toBe(2);
    expect(nearest(1, 5)).toBe(4);
  });

  it("says nothing outside the plot", () => {
    // A pointer in the gutter is not hovering the first week, and a readout
    // saying it is would be wrong exactly where a pointer tends to rest.
    expect(nearest(-0.3, 5)).toBeNull();
    expect(nearest(1.4, 5)).toBeNull();
  });

  it("says nothing about an empty series", () => {
    expect(nearest(0.5, 0)).toBeNull();
  });
});

describe("summary", () => {
  it("says where the line started and where it ended", () => {
    expect(summary("Duke", TWO_SEASONS)).toBe(
      "Duke's rating over 5 weeks, from 1702 in 2025 rising to 1834 in 2026",
    );
  });

  it("says which way a falling line went", () => {
    expect(
      summary("Duke", [week(2026, 1, 1800), week(2026, 2, 1700)]),
    ).toContain("falling to");
  });

  it("says so when there is nothing to draw", () => {
    expect(summary("Vermont", [])).toBe("No rating history for Vermont");
  });
});
