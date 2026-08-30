import { describe, expect, it } from "vitest";

import {
  dayLabel,
  dayRank,
  daysBetween,
  probability,
  score,
  spread,
  statusLabel,
  tipoff,
  todayOf,
  zoneLabel,
} from "./format";

describe("spread", () => {
  it("keeps the market's sign, from the home team's side", () => {
    // Negative is the home team laying points, which is what makes this
    // column readable against the model's beside it.
    expect(spread(-6.5)).toBe("-6.5");
    expect(spread(2.5)).toBe("+2.5");
  });

  it("drops a decimal that isn't saying anything", () => {
    expect(spread(-7)).toBe("-7");
    expect(spread(-5.34)).toBe("-5.3");
  });

  it("calls a pick'em a pick'em", () => {
    // "-0.0" and "0" both read as a missing number rather than an even game.
    expect(spread(0)).toBe("PK");
    expect(spread(-0.02)).toBe("PK");
  });

  it("says nothing rather than zero when there's no line", () => {
    expect(spread(null)).toBe("—");
    expect(spread(undefined)).toBe("—");
  });
});

describe("score", () => {
  it("reads away-first, like the matchup above it", () => {
    expect(score(71, 78)).toBe("71–78");
  });

  it("needs both halves", () => {
    // A game the scrape hasn't returned carries no score at all; half of one
    // is a bug, not a result.
    expect(score(null, 78)).toBe("—");
    expect(score(null, null)).toBe("—");
  });
});

describe("probability", () => {
  it("rounds to where the digits stop meaning anything", () => {
    expect(probability(0.6331)).toBe("63%");
    expect(probability(null)).toBe("—");
  });
});

describe("tipoff", () => {
  it("states the zone the days are cut in, not the reader's", () => {
    // 02:00 UTC is 21:00 the previous evening in Chicago -- the boundary the
    // day grouping turns on. A local clock would put this game under "Today"
    // and label it 2:00 AM, which is a page arguing with itself.
    expect(tipoff("2026-08-23T02:00:00Z")).toBe("9:00 PM");
  });

  it("names the zone by what it is on the day", () => {
    // Said once above the tables rather than on every row, and never
    // hardcoded: the page must not claim daylight time in January.
    expect(zoneLabel(new Date("2026-08-23T02:00:00Z"))).toBe("CDT");
    expect(zoneLabel(new Date("2026-01-23T02:00:00Z"))).toBe("CST");
  });

  it("says nothing rather than Invalid Date", () => {
    expect(tipoff("not a date")).toBe("");
  });
});

describe("days", () => {
  it("counts whole days either side", () => {
    expect(daysBetween("2026-08-22", "2026-08-24")).toBe(2);
    expect(daysBetween("2026-08-22", "2026-08-20")).toBe(-2);
  });

  it("survives a month boundary", () => {
    expect(daysBetween("2026-08-31", "2026-09-01")).toBe(1);
  });
});

describe("dayLabel", () => {
  const today = "2026-08-22";

  it("names the days anyone would name", () => {
    expect(dayLabel("2026-08-22", today)).toBe("Today");
    expect(dayLabel("2026-08-23", today)).toBe("Tomorrow");
    expect(dayLabel("2026-08-21", today)).toBe("Yesterday");
  });

  it("dates the rest rather than making you count", () => {
    // Parsed as local midnight, not UTC: `new Date("2026-08-20")` is UTC
    // midnight, which formats as the 19th anywhere west of Greenwich.
    expect(dayLabel("2026-08-20", today)).toContain("Thursday");
    expect(dayLabel("2026-08-20", today)).toContain("20");
  });
});

describe("dayRank", () => {
  it("puts today first, then forward, then backwards", () => {
    const today = "2026-08-22";
    const order = ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23"]
      .sort((a, b) => dayRank(a, today) - dayRank(b, today))
      .map((day) => dayLabel(day, today));

    // Chronological would bury tonight's games under two days of box scores;
    // reverse-chronological would put tomorrow above them.
    expect(order).toEqual(["Today", "Tomorrow", "Yesterday", order[3]]);
    expect(order[3]).toContain("Thursday");
  });
});

describe("todayOf", () => {
  it("takes today from the window, not from the browser's clock", () => {
    // The window is cut in US Central; a reader in another zone asking their
    // own clock would label the wrong group "Today" for part of the day.
    expect(todayOf({ until: "2026-08-23", days_ahead: 1 })).toBe("2026-08-22");
    expect(todayOf({ until: "2026-09-01", days_ahead: 1 })).toBe("2026-08-31");
    expect(todayOf({ until: "2026-08-22", days_ahead: 0 })).toBe("2026-08-22");
  });
});

describe("statusLabel", () => {
  it("says nothing for a game that simply hasn't happened", () => {
    // The tip-off beside it already says the game is ahead of us, so the
    // result column stays a dash rather than repeating it on every row.
    expect(statusLabel("STATUS_SCHEDULED")).toBeNull();
  });

  it("says nothing for a game saved before endgame carried a status", () => {
    // Most of the bucket, and all of it finished -- so this only ever reaches
    // a row that has a score to show anyway.
    expect(statusLabel("")).toBeNull();
    expect(statusLabel(undefined)).toBeNull();
    expect(statusLabel(null)).toBeNull();
  });

  it("names the states a dash would leave you waiting on", () => {
    expect(statusLabel("STATUS_IN_PROGRESS")).toBe("In progress");
    expect(statusLabel("STATUS_POSTPONED")).toBe("Postponed");
    expect(statusLabel("STATUS_CANCELED")).toBe("Cancelled");
  });

  it("calls a final with no score what it is", () => {
    // ESPN lists the occasional fixture it never fills in, and the scrape
    // records it unplayed without rewriting the status to agree. "No result"
    // rather than "Final": there is no score, and there never will be.
    expect(statusLabel("STATUS_FINAL")).toBe("No result");
  });

  it("renders a status nobody has seen rather than swallowing it", () => {
    // The API passes ESPN's own name through, so this list is open at the
    // bottom by design -- an unknown state is still better said than hidden
    // behind a dash that claims the game is merely upcoming.
    expect(statusLabel("STATUS_BAD_WEATHER")).toBe("Bad weather");
  });

  it("passes through anything not shaped like one of ESPN's names", () => {
    expect(statusLabel("weird")).toBe("weird");
  });
});
