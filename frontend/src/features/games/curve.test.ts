import { describe, expect, it } from "vitest";

import type { CurvePoint, GameControl } from "../../services/api";
import {
  REGULATION_SECONDS,
  acrossTheGame,
  areaPath,
  clockLabel,
  controlLabel,
  elapsed,
  linePath,
  nearest,
  plotBox,
  scoreChanges,
  seasonRange,
  secondsX,
} from "./curve";

const snap = (over: Partial<CurvePoint> = {}): CurvePoint => ({
  play_id: "p1",
  play_number: 1,
  period: 1,
  clock_seconds: 900,
  seconds_remaining: REGULATION_SECONDS,
  home_score: 0,
  away_score: 0,
  home_win_prob: 0.5,
  ...over,
});

describe("the time axis", () => {
  it("puts kickoff at the left and the whistle at the right", () => {
    expect(acrossTheGame(snap({ seconds_remaining: 3600 }))).toBe(0);
    expect(acrossTheGame(snap({ seconds_remaining: 0 }))).toBe(1);
  });

  it("pins overtime at the end rather than running past it", () => {
    // Every overtime snap arrives with `seconds_remaining: 0`, because
    // college overtime has no clock the model reads. Stacking them on the
    // edge is honest; inventing an axis for them wouldn't be.
    expect(elapsed(snap({ period: 5, seconds_remaining: 0 }))).toBe(
      REGULATION_SECONDS,
    );
  });

  it("puts the quarter breaks a quarter apart", () => {
    const box = plotBox();
    expect(secondsX(0)).toBeCloseTo(box.x);
    expect(secondsX(1800)).toBeCloseTo(box.x + box.width / 2);
    expect(secondsX(3600)).toBeCloseTo(box.x + box.width);
  });
});

describe("the path", () => {
  it("is empty for a game with no plays", () => {
    expect(linePath([])).toBe("");
    expect(areaPath([])).toBe("");
  });

  it("has one segment per snap", () => {
    const path = linePath([snap(), snap({ seconds_remaining: 1800 })]);
    expect(path.startsWith("M")).toBe(true);
    expect(path.match(/L/g)).toHaveLength(1);
  });

  it("closes the area onto the even line so it can be filled", () => {
    const path = areaPath([snap(), snap({ seconds_remaining: 0 })]);
    expect(path.endsWith("Z")).toBe(true);
  });
});

describe("scoreChanges", () => {
  it("finds the first snap carrying each new score", () => {
    // Scores on a point are the score *before* the snap, so the first point
    // with a new total is the first snap after the score -- which is where
    // the model's number has already moved.
    const points = [
      snap({ play_id: "a" }),
      snap({ play_id: "b" }),
      snap({ play_id: "c", away_score: 7 }),
      snap({ play_id: "d", away_score: 7 }),
      snap({ play_id: "e", away_score: 7, home_score: 7 }),
    ];
    expect(scoreChanges(points).map((p) => p.play_id)).toEqual(["c", "e"]);
  });

  it("says nothing about a scoreless game", () => {
    expect(scoreChanges([snap(), snap()])).toEqual([]);
  });
});

describe("nearest", () => {
  it("finds the snap nearest in time, not in index", () => {
    // The points bunch up wherever the clock stopped, so nearest-by-index
    // would jump around under the pointer exactly where a reader looks
    // hardest.
    const points = [
      snap({ play_id: "kickoff", seconds_remaining: 3600 }),
      snap({ play_id: "late", seconds_remaining: 120 }),
      snap({ play_id: "later", seconds_remaining: 60 }),
    ];
    expect(points[nearest(points, 0.05)!].play_id).toBe("kickoff");
    expect(points[nearest(points, 0.99)!].play_id).toBe("later");
  });

  it("has nothing to point at in an empty game", () => {
    expect(nearest([], 0.5)).toBeNull();
  });

  it("clamps a pointer that left the plot", () => {
    const points = [
      snap({ play_id: "a" }),
      snap({ play_id: "b", seconds_remaining: 0 }),
    ];
    expect(points[nearest(points, -3)!].play_id).toBe("a");
    expect(points[nearest(points, 4)!].play_id).toBe("b");
  });
});

describe("clockLabel", () => {
  it("names a snap by its quarter and clock", () => {
    expect(clockLabel(snap({ period: 3, clock_seconds: 442 }))).toBe("Q3 7:22");
  });

  it("pads the seconds", () => {
    expect(clockLabel(snap({ period: 1, clock_seconds: 605 }))).toBe(
      "Q1 10:05",
    );
  });

  it("gives overtime no clock, because the model reads none", () => {
    expect(clockLabel(snap({ period: 5, clock_seconds: 0 }))).toBe("OT");
    expect(clockLabel(snap({ period: 6, clock_seconds: 0 }))).toBe("OT2");
  });
});

describe("controlLabel", () => {
  const control: GameControl = { home: 0.42, away: 0.58, seconds: 3580 };

  it("names the side that held the game", () => {
    expect(controlLabel(control, "Bears", "Packers")).toContain("Packers held");
    expect(controlLabel(control, "Bears", "Packers")).toContain("58%");
  });

  it("says how much of the clock the number covers", () => {
    // Regulation only, so a game that went to overtime reports less than
    // sixty -- and the number should say so rather than imply a full game.
    expect(controlLabel(control, "Bears", "Packers")).toContain("60 minutes");
  });

  it("says nothing when there was no clock to average over", () => {
    expect(controlLabel(null, "Bears", "Packers")).toBeNull();
  });
});

describe("seasonRange", () => {
  it("collapses a contiguous run", () => {
    expect(seasonRange([2006, 2007, 2008])).toBe("2006–2008");
  });

  it("keeps a gap visible rather than smoothing it over", () => {
    expect(seasonRange([2006, 2008])).toBe("2006, 2008");
  });

  it("says one season as one season", () => {
    expect(seasonRange([2025])).toBe("2025");
  });
});
