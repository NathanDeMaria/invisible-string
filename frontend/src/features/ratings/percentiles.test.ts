import { describe, expect, it } from "vitest";

import { leaguePercentile } from "./percentiles";

describe("leaguePercentile", () => {
  const all = [0.3, 0.35, 0.4, 0.45, 0.5];

  it("puts the highest offense at the top and the lowest at the bottom", () => {
    expect(leaguePercentile(all, 0.5, "offenseSuccess")).toBe(100);
    expect(leaguePercentile(all, 0.3, "offenseSuccess")).toBe(0);
    expect(leaguePercentile(all, 0.4, "offenseSuccess")).toBe(50);
  });

  it("reads a lower success rate allowed as the better defense", () => {
    expect(leaguePercentile(all, 0.3, "defenseSuccess")).toBe(100);
    expect(leaguePercentile(all, 0.5, "defenseSuccess")).toBe(0);
  });

  it("puts a tie in the middle of its run", () => {
    expect(leaguePercentile([0.1, 0.2, 0.2, 0.3], 0.2, "offenseEpa")).toBe(50);
  });

  it("has nothing to say about a population of one", () => {
    expect(leaguePercentile([0.4], 0.4, "offenseSuccess")).toBeNull();
  });
});
