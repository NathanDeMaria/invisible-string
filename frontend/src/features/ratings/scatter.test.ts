import { describe, expect, it } from "vitest";

import type { TeamRow } from "../../services/api";
import {
  availableMetrics,
  defaultAxes,
  dots,
  fraction,
  median,
  nearestDot,
  niceStep,
  resolveAxis,
  scale,
  ticks,
  tickLabel,
} from "./scatter";

const team = (overrides: Partial<TeamRow>): TeamRow => ({
  team: "Team",
  rank: 1,
  rating: 1500,
  rd: 50,
  wins: 0,
  losses: 0,
  ...overrides,
});

describe("availableMetrics", () => {
  it("offers only what the model publishes", () => {
    expect(
      availableMetrics({
        rd: false,
        units: false,
        success: false,
        week: false,
      }),
    ).toEqual(["rating", "record"]);
    expect(
      availableMetrics({ rd: true, units: true, success: true, week: true }),
    ).toEqual([
      "rating",
      "record",
      "rd",
      "offense",
      "defense",
      "offenseSuccess",
      "defenseSuccess",
      "week",
    ]);
  });
});

describe("axes", () => {
  it("opens on offense against defense where the model has them", () => {
    expect(defaultAxes(["rating", "record", "offense", "defense"])).toEqual({
      x: "offense",
      y: "defense",
    });
    expect(defaultAxes(["rating", "record"])).toEqual({
      x: "record",
      y: "rating",
    });
  });

  it("falls back where the model doesn't publish the choice", () => {
    expect(resolveAxis("offense", ["rating", "record"], "record")).toBe(
      "record",
    );
    expect(resolveAxis("rd", ["rating", "rd"], "rating")).toBe("rd");
    expect(resolveAxis(null, ["rating"], "rating")).toBe("rating");
  });
});

describe("dots", () => {
  it("leaves off a team missing either value", () => {
    const rows = [
      team({ team: "Both", offense: { rating: 1600, rd: 50 }, wins: 3 }),
      team({ team: "No units", wins: 3 }),
      team({ team: "No games", offense: { rating: 1550, rd: 50 } }),
    ];
    expect(dots(rows, "offense", "record").map((d) => d.row.team)).toEqual([
      "Both",
    ]);
  });
});

describe("scale", () => {
  it("rounds to a step with room either side", () => {
    const axis = scale([1412, 1893], false);
    expect(axis.step).toBe(100);
    expect(axis.low).toBe(1300);
    expect(axis.high).toBe(2000);
  });

  it("labels small steps without float noise", () => {
    const axis = scale([0.31, 0.52], false);
    expect(ticks(axis).every((t) => String(t).length <= 5)).toBe(true);
  });

  it("puts better up and right on a reversed axis", () => {
    const axis = scale([0.3, 0.5], true);
    expect(fraction(0.3, axis)).toBeGreaterThan(fraction(0.5, axis));
  });

  it("survives a single value", () => {
    const axis = scale([1500], false);
    expect(axis.high).toBeGreaterThan(axis.low);
  });

  it("picks 1, 2, 2.5 or 5 of a power of ten", () => {
    expect(niceStep(0.04)).toBe(0.05);
    expect(niceStep(23)).toBe(25);
    expect(niceStep(130)).toBe(200);
  });
});

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("nearestDot", () => {
  it("finds the nearest within reach and nothing past it", () => {
    const placed = [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
    ];
    expect(nearestDot(27, 12, placed)).toBe(1);
    expect(nearestDot(100, 100, placed)).toBeNull();
  });
});

describe("tickLabel", () => {
  it("shows only the decimals the step needs", () => {
    expect(tickLabel("rating", 1600, 100)).toBe("1600");
    expect(tickLabel("offenseSuccess", 0.425, 0.025)).toBe("42.5%");
    expect(tickLabel("offenseSuccess", 0.4, 0.05)).toBe("40%");
    expect(tickLabel("week", 5, 5)).toBe("+5");
    expect(tickLabel("week", -2.5, 2.5)).toBe("−2.5");
  });
});
