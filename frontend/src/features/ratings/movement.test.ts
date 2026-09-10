import { describe, expect, it } from "vitest";

import type { Movement } from "../../services/api";
import {
  movementTitle,
  placeMove,
  ratingMove,
  record,
  weekEnding,
} from "./movement";

const SINCE = "2026-07-31T23:00:00Z";

const moved = (overrides: Partial<Movement> = {}): Movement => ({
  rating: 24.2,
  rank: 0,
  wins: 2,
  losses: 0,
  ...overrides,
});

describe("ratingMove", () => {
  it("signs the direction", () => {
    expect(ratingMove(34.16)).toBe("+34.2");
    expect(ratingMove(-10.5)).toBe("-10.5");
  });

  it("gives a week that went nowhere no sign at all", () => {
    // Every team that didn't play. "+0.0" and "-0.0" are the same week, and
    // either implies a direction the number doesn't support.
    expect(ratingMove(0)).toBe("0.0");
    expect(ratingMove(0.02)).toBe("0.0");
    expect(ratingMove(-0.04)).toBe("0.0");
  });
});

describe("placeMove", () => {
  it("says nothing about a team that held its place", () => {
    expect(placeMove(0)).toBeNull();
  });

  it("points the way the team went, not the way the number did", () => {
    // Third to second is +1: the rank fell and the team rose.
    expect(placeMove(1)).toEqual({ count: 1, up: true, glyph: "▲" });
    expect(placeMove(-3)).toEqual({ count: 3, up: false, glyph: "▼" });
  });
});

describe("record", () => {
  it("reads as the week's games", () => {
    expect(record(2, 0)).toBe("2-0");
    expect(record(1, 1)).toBe("1-1");
  });

  it("says nothing for a team on a bye", () => {
    // "0-0" would read as a week that happened and went nowhere, which is a
    // different statement from not having played.
    expect(record(0, 0)).toBeNull();
  });
});

describe("movementTitle", () => {
  it("decodes the whole cell", () => {
    expect(movementTitle(moved({ rating: 34.2, rank: 1 }), SINCE)).toBe(
      "Up 34.2 points and up 1 place since Jul 31, going 2-0",
    );
  });

  it("pluralises places", () => {
    expect(movementTitle(moved({ rank: -3 }), SINCE)).toContain(
      "down 3 places",
    );
  });

  it("leaves out the places a team didn't move", () => {
    expect(movementTitle(moved({ rank: 0 }), SINCE)).toBe(
      "Up 24.2 points since Jul 31, going 2-0",
    );
  });

  it("leaves out a record that isn't one", () => {
    const bye = moved({ rating: 0, rank: 0, wins: 0, losses: 0 });
    expect(movementTitle(bye, SINCE)).toBe("Unchanged since Jul 31");
  });
});

describe("weekEnding", () => {
  it("names the day the comparison week ended", () => {
    expect(weekEnding(SINCE)).toBe("Jul 31");
  });

  it("reads the instant in US Central, like every other date on the site", () => {
    // 00:30 UTC on the 1st is still the evening of July 31st in Chicago,
    // which is the day the games were played on.
    expect(weekEnding("2026-08-01T00:30:00Z")).toBe("Jul 31");
  });

  it("says nothing when there's nothing to compare against", () => {
    expect(weekEnding(null)).toBe("");
    expect(weekEnding(undefined)).toBe("");
    expect(weekEnding("not a date")).toBe("");
  });
});
