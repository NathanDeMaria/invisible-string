import { describe, expect, it } from "vitest";

import type {
  CurvePoint,
  GameControl,
  LuckyBounces,
  LuckySwing,
} from "../../services/api";
import {
  RAIL,
  REGULATION_SECONDS,
  acrossTheGame,
  adjustedControlLabel,
  adjustedLinePath,
  clockLabel,
  elapsed,
  gapPath,
  kindLabel,
  linePath,
  luckLabel,
  nearest,
  place,
  placeAdjusted,
  plotBox,
  railTicks,
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
  adjusted_win_prob: 0.5,
  ...over,
});

const swing = (over: Partial<LuckySwing> = {}): LuckySwing => ({
  play_id: "p1",
  play_number: 1,
  kind: "fumble_lost",
  retained: 0.5,
  realized: 0.6,
  counterfactual: 0.4,
  home_delta: 0.1,
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
    expect(adjustedLinePath([])).toBe("");
    expect(gapPath([])).toBe("");
  });

  it("has one segment per snap", () => {
    const path = linePath([snap(), snap({ seconds_remaining: 1800 })]);
    expect(path.startsWith("M")).toBe(true);
    expect(path.match(/L/g)).toHaveLength(1);
  });

  it("draws the adjusted line off the same snaps and the other number", () => {
    // Same x, different y: the two curves are one series with two
    // probabilities on it, which is why they can never come apart.
    const points = [snap({ adjusted_win_prob: 0.7 })];
    expect(place(points[0]).x).toBe(placeAdjusted(points[0]).x);
    expect(placeAdjusted(points[0]).y).toBeLessThan(place(points[0]).y);
    expect(adjustedLinePath(points)).not.toBe(linePath(points));
  });

  it("closes the gap between the two lines", () => {
    // Down one line and back along the other, so it closes whichever line is
    // on top and however often they cross.
    const points = [snap(), snap({ seconds_remaining: 0 })];
    const gap = gapPath(points);
    expect(gap.startsWith("M")).toBe(true);
    expect(gap.endsWith("Z")).toBe(true);
    expect(gap.match(/L/g)).toHaveLength(3);
  });

  it("is a closed path with no area at all when nothing bounced", () => {
    // A clean game's two lines are the same line, so the wash between them is
    // a path with nothing inside it -- which is what "no bounces" should look
    // like rather than a special case in the component.
    const points = [snap(), snap({ seconds_remaining: 0 })];
    expect(gapPath(points)).toBe(
      `${linePath(points)} ${[...points]
        .reverse()
        .map((p) => `L${place(p).x.toFixed(1)} ${place(p).y.toFixed(1)}`)
        .join(" ")} Z`,
    );
  });
});

describe("the rail of bounces", () => {
  const points = [
    snap({ play_id: "a", seconds_remaining: 3000 }),
    snap({ play_id: "b", seconds_remaining: 1200 }),
  ];

  it("puts each bounce at the snap it happened on", () => {
    const [tick] = railTicks(points, [swing({ play_id: "b" })]);
    expect(tick.x).toBeCloseTo(place(points[1]).x);
    expect(tick.point.play_id).toBe("b");
  });

  it("stands a tick up for the home team and down for the away", () => {
    const ticks = railTicks(points, [
      swing({ play_id: "a", home_delta: 0.2 }),
      swing({ play_id: "b", home_delta: -0.1 }),
    ]);
    expect(ticks[0].height).toBe(RAIL.height);
    expect(ticks[1].height).toBe(-RAIL.height / 2);
  });

  it("scales to the biggest bounce in this game, but not past a floor", () => {
    // A game of trivial bounces should draw trivial ticks. Scaling to the
    // biggest one alone would draw a 0.004 nudge at full height.
    const [tick] = railTicks(points, [
      swing({ play_id: "a", home_delta: 0.01 }),
    ]);
    expect(tick.height).toBe((0.01 / RAIL.floor) * RAIL.height);
  });

  it("drops a bounce whose snap isn't on the curve", () => {
    // Shouldn't happen -- upstream only prices a bounce that is a snap with
    // something after it -- and inventing an x for one would be a mark at a
    // moment the game wasn't at.
    expect(railTicks(points, [swing({ play_id: "elsewhere" })])).toEqual([]);
  });
});

describe("kindLabel", () => {
  it("says what a bounce was, in the page's words", () => {
    expect(kindLabel("fumble_kept")).toBe("Fumble recovered");
    expect(kindLabel("pass_defended_incomplete")).toBe("Pass broken up");
  });

  it("spells out a kind it doesn't know rather than dropping it", () => {
    // `kind` is a plain string on the wire because upstream may name a fifth
    // coin one day; a row that rendered blank would be worse than one that
    // reads oddly.
    expect(kindLabel("muffed_punt")).toBe("muffed punt");
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

describe("adjustedControlLabel", () => {
  const control: GameControl = { home: 0.42, away: 0.58, seconds: 3580 };
  const adjusted: GameControl = { home: 0.37, away: 0.63, seconds: 3580 };

  it("says both numbers about the same team", () => {
    // A sentence that switched teams between the two would read as a swing
    // that isn't there.
    const label = adjustedControlLabel(control, adjusted, "Bears");
    expect(label).toContain("Bears held 42%");
    expect(label).toContain("37%");
    expect(label).not.toContain("Packers");
  });

  it("says how much of the clock the numbers cover", () => {
    // Regulation only, so a game that went to overtime reports less than
    // sixty -- and the number should say so rather than imply a full game.
    expect(adjustedControlLabel(control, adjusted, "Bears")).toContain(
      "60 minutes",
    );
  });

  it("says nothing when there was no clock to average over", () => {
    expect(adjustedControlLabel(null, null, "Bears")).toBeNull();
  });
});

describe("luckLabel", () => {
  const luck: LuckyBounces = { home: 0.12, away: 0.03, swings: [swing()] };

  it("says what the bounces were worth to each side", () => {
    const label = luckLabel(luck, "Bears", "Packers");
    expect(label).toContain("0.12 of win probability to Bears");
    expect(label).toContain("0.03 to Packers");
  });

  it("says nothing about a game nothing bounced in", () => {
    // Which is not the same as 0.00 and 0.00: the page has its own sentence
    // for "nothing here turned on a bounce".
    expect(
      luckLabel({ home: 0, away: 0, swings: [] }, "Bears", "P"),
    ).toBeNull();
    expect(luckLabel(null, "Bears", "Packers")).toBeNull();
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
