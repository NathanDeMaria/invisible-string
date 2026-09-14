import { describe, expect, it } from "vitest";

import { percentileLabel, percentileOf } from "./percentile";

/** p0..p100 at 0.00, 0.01, ... 1.00 -- so a value *is* its own percentile. */
const linear = Array.from({ length: 101 }, (_, i) => i / 100);

describe("percentileOf", () => {
  it("reads a value off the checkpoint it sits on", () => {
    expect(percentileOf(linear, 0.5)).toBeCloseTo(50);
    expect(percentileOf(linear, 0.93)).toBeCloseTo(93);
  });

  it("interpolates between two checkpoints", () => {
    // Halfway between p40 and p41.
    expect(percentileOf(linear, 0.405)).toBeCloseTo(40.5);
  });

  it("clamps past either end", () => {
    // p0 and p100 are single extreme games, not numbers to read past: a value
    // beyond one of them is as extreme as this population has seen.
    expect(percentileOf(linear, -5)).toBe(0);
    expect(percentileOf(linear, 5)).toBe(100);
  });

  it("puts a value in a run of ties at the middle of the run", () => {
    // A metric with a mass at one value -- a luck total that is 0 for most
    // games. Sitting in that mass is neither the bottom of it nor the top.
    const tied = [
      ...Array.from({ length: 30 }, (_, i) => i / 100),
      ...Array(41).fill(0.3),
      ...Array.from({ length: 30 }, (_, i) => 0.4 + i / 100),
    ];
    expect(tied).toHaveLength(101);

    // The run covers p29 through p70 inclusive (p29 is 0.29... plus the 41
    // copies from index 30). Its middle is what a tied game reads as.
    const answer = percentileOf(tied, 0.3);
    expect(answer).toBeGreaterThan(45);
    expect(answer).toBeLessThan(55);
  });

  it("never reports the bottom of a tie run as beating nobody", () => {
    const mostlyZero = [...Array(80).fill(0), ...Array(21).fill(1)];
    // 0 is the modal value, not the worst one.
    expect(percentileOf(mostlyZero, 0)).toBeGreaterThan(0);
  });

  it("is null for a metric the league has no distribution for", () => {
    // The degradation this whole feature has to make gracefully: no artifact
    // means the number renders with no label beside it.
    expect(percentileOf(undefined, 0.3)).toBeNull();
    expect(percentileOf(null, 0.3)).toBeNull();
  });

  it("is null for a value there isn't one of", () => {
    expect(percentileOf(linear, null)).toBeNull();
    expect(percentileOf(linear, undefined)).toBeNull();
    expect(percentileOf(linear, NaN)).toBeNull();
  });

  it("is null for a distribution too short to search", () => {
    expect(percentileOf([], 0.3)).toBeNull();
    expect(percentileOf([0.5], 0.3)).toBeNull();
  });

  it("rises with the value", () => {
    // The one property that has to hold whatever the shape: a better number
    // can never read as a worse percentile.
    const shaped = [0, 0.05, ...Array.from({ length: 99 }, (_, i) => 0.1 + i)];
    let previous = -1;
    for (let v = -1; v < 100; v += 0.37) {
      const answer = percentileOf(shaped, v) ?? 0;
      expect(answer).toBeGreaterThanOrEqual(previous);
      previous = answer;
    }
  });
});

describe("percentileLabel", () => {
  it("writes English ordinals", () => {
    expect(percentileLabel(93)).toBe("93rd");
    expect(percentileLabel(1)).toBe("1st");
    expect(percentileLabel(2)).toBe("2nd");
    expect(percentileLabel(50)).toBe("50th");
  });

  it("gets the teens right", () => {
    expect(percentileLabel(11)).toBe("11th");
    expect(percentileLabel(12)).toBe("12th");
    expect(percentileLabel(13)).toBe("13th");
  });

  it("rounds rather than claiming a decimal the artifact hasn't got", () => {
    expect(percentileLabel(40.5)).toBe("41st");
    expect(percentileLabel(92.4)).toBe("92nd");
  });

  it("is null when there is no percentile", () => {
    expect(percentileLabel(null)).toBeNull();
  });
});
