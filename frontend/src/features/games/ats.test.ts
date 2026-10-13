import { describe, expect, it } from "vitest";

import type { GameRow } from "../../services/api";
import {
  NOTABLE_PUSH,
  SHOW_COVER_PROB,
  atsCall,
  atsTitle,
  edgeAmount,
  edgeTitle,
  modelEdge,
  pushNote,
} from "./ats";

/**
 * One finished game, with the two numbers and the score that grade it.
 *
 * Every spread here is from the home team's side, which is the convention
 * both columns of the page share -- so `line: -4.5` is the home team laying
 * four and a half, and `model: -8.5` is the model saying they should be
 * laying more than that.
 */
const game = ({
  line,
  model,
  cover,
  home = 78,
  away = 71,
  ...rest
}: {
  line: number | null;
  model: number | null;
  home?: number | null;
  away?: number | null;
  completed?: boolean;
  /** The kernel's [home covers, away covers, push], for a release that has one. */
  cover?: [number, number, number];
}): GameRow => ({
  league: "mens",
  game_id: "g",
  day: "2026-08-20",
  start: "2026-08-21T01:00:00Z",
  home: "Duke",
  away: "North Carolina",
  neutral: false,
  completed: true,
  status: "STATUS_FINAL",
  home_score: home,
  away_score: away,
  market_spread: line,
  market_home_prob: null,
  prediction:
    model == null
      ? null
      : {
          model: "glicko_tuned",
          run_id: "r1",
          home_win_prob: 0.69,
          predicted_spread: model,
          // Nothing here reads them; the ordering is what ratings are for.
          home_rating: 1600,
          away_rating: 1500,
          home_cover_prob: cover?.[0] ?? null,
          away_cover_prob: cover?.[1] ?? null,
          push_prob: cover?.[2] ?? null,
        },
  ...rest,
});

describe("atsCall", () => {
  it("takes the side the model gives more points to than the book", () => {
    // Model -8.5 against a book at -4.5: the model says the home team wins by
    // more than the price, so the pick is home, and home won by 7.
    const call = atsCall(game({ line: -4.5, model: -8.5 }));
    expect(call).toEqual({
      pick: "Duke",
      home: true,
      pickLine: -4.5,
      points: 4,
      odds: null,
      result: "hit",
    });
  });

  it("takes the away side when the model likes the underdog", () => {
    // The same game with the model at -1.5: it thinks the home team is being
    // asked to lay too much, which is a bet on the visitors -- and they lost
    // by 7, so the number was wrong.
    const call = atsCall(game({ line: -4.5, model: -1.5 }));
    expect(call).toEqual({
      pick: "North Carolina",
      home: false,
      pickLine: 4.5,
      points: 3,
      odds: null,
      result: "miss",
    });
  });

  it("is the cover that decides it, not the win", () => {
    // Home won outright by 3 and the model was on them -- but they were
    // laying 6.5, so the side the model took didn't cover.
    const call = atsCall(game({ line: -6.5, model: -9, home: 74, away: 71 }));
    expect(call?.result).toBe("miss");
  });

  it("calls a game that lands on the number a push", () => {
    // Nobody was right. The model still had a side; the game didn't give it
    // to either of them.
    const call = atsCall(game({ line: -7, model: -9 }));
    expect(call).toEqual({
      pick: "Duke",
      home: true,
      pickLine: -7,
      points: 2,
      odds: null,
      result: "push",
    });
  });

  it("says nothing about a disagreement the page doesn't show", () => {
    // Both columns print -4.5, so a mark here would be grading a difference
    // the reader can't see -- and handing a coin flip an opinion.
    expect(atsCall(game({ line: -4.5, model: -4.52 }))).toBeNull();
    expect(atsCall(game({ line: -4.5, model: -4.5 }))).toBeNull();
  });

  it("says nothing without both numbers", () => {
    expect(atsCall(game({ line: null, model: -8.5 }))).toBeNull();
    expect(atsCall(game({ line: -4.5, model: null }))).toBeNull();
  });

  it("says nothing without a result", () => {
    // Tonight's game is a forecast; it isn't right or wrong yet. A score of
    // one half is a bug rather than a result, and grades no better.
    expect(
      atsCall(
        game({
          line: -4.5,
          model: -8.5,
          completed: false,
          home: null,
          away: null,
        }),
      ),
    ).toBeNull();
    expect(atsCall(game({ line: -4.5, model: -8.5, home: null }))).toBeNull();
  });
});

describe("atsTitle", () => {
  it("names the side the model took, and what became of it", () => {
    expect(
      atsTitle({
        pick: "Duke",
        home: true,
        pickLine: -4.5,
        points: 4,
        odds: null,
        result: "hit",
      }),
    ).toBe("The model liked Duke at -4.5; Duke covered");
    expect(
      atsTitle({
        pick: "North Carolina",
        home: false,
        pickLine: 4.5,
        points: 3,
        odds: null,
        result: "miss",
      }),
    ).toBe(
      "The model liked North Carolina at +4.5; North Carolina didn’t cover",
    );
  });

  it("says a push landed on the number rather than blaming a side", () => {
    expect(
      atsTitle({
        pick: "Duke",
        home: true,
        pickLine: -7,
        points: 2,
        odds: null,
        result: "push",
      }),
    ).toBe("The model liked Duke at -7; the game landed on the number");
  });
});

describe("modelEdge", () => {
  it("names the side the model gives more points to, and how many", () => {
    // The book has Duke laying 4.5 and the model has them laying 8.5, so the
    // model is four points better on Duke than the board is. That is the
    // whole content of putting the two columns side by side.
    expect(modelEdge(game({ line: -4.5, model: -8.5 }))).toEqual({
      pick: "Duke",
      home: true,
      pickLine: -4.5,
      points: 4,
      odds: null,
    });
  });

  it("falls on the away side when the model won't lay the price", () => {
    expect(modelEdge(game({ line: -4.5, model: -1.5 }))).toEqual({
      pick: "North Carolina",
      home: false,
      pickLine: 4.5,
      points: 3,
      odds: null,
    });
  });

  it("speaks for a game that hasn't been played", () => {
    // The reason this is separate from `atsCall`: tonight's slate is most of
    // the page, and the disagreement is exactly as real before the result as
    // after it. Only the verdict has to wait.
    const tonight = game({
      line: -4.5,
      model: -8.5,
      completed: false,
      home: null,
      away: null,
    });
    expect(modelEdge(tonight)).toMatchObject({ pick: "Duke", points: 4 });
    expect(atsCall(tonight)).toBeNull();
  });

  it("says nothing without both numbers", () => {
    expect(modelEdge(game({ line: null, model: -8.5 }))).toBeNull();
    expect(modelEdge(game({ line: -4.5, model: null }))).toBeNull();
  });

  it("says nothing about a gap the columns don't show", () => {
    // Both print -4.5. Naming a side off a difference the reader can't see is
    // worse than naming none.
    expect(modelEdge(game({ line: -4.5, model: -4.52 }))).toBeNull();
  });
});

describe("edgeTitle", () => {
  it("decodes the shorthand into the sentence behind it", () => {
    expect(
      edgeTitle({
        pick: "Duke",
        home: true,
        pickLine: -4.5,
        points: 4,
        odds: null,
      }),
    ).toBe("The model gives Duke 4 more points than the book does");
  });

  it("says one point rather than one points", () => {
    expect(
      edgeTitle({
        pick: "Duke",
        home: true,
        pickLine: -4.5,
        points: 1,
        odds: null,
      }),
    ).toBe("The model gives Duke 1 more point than the book does");
  });

  it("rounds to what the columns print", () => {
    // 0.75 of a point of disagreement between two numbers printed to a tenth.
    expect(
      edgeTitle({
        pick: "Duke",
        home: true,
        pickLine: -4.5,
        points: 0.75,
        odds: null,
      }),
    ).toBe("The model gives Duke 0.8 more points than the book does");
  });
});

/**
 * A release with a margin kernel: the pick follows the cover probabilities.
 *
 * The numbers are the shape a football kernel gives a game whose model
 * spread sits right on a key number -- the favourite has to win by *more*
 * than 7, so with the model at -7 against a book at -7 the underdog covers
 * half the time, the favourite 44.5%, and the rest is push.
 */
describe("modelEdge with cover probabilities", () => {
  const onSeven: [number, number, number] = [0.445, 0.5, 0.055];

  it("takes the side likelier to cover, even when the spreads agree", () => {
    // The subtraction has nothing to say here -- both columns print -7 --
    // but the probabilities do, and the underdog is the pick.
    expect(modelEdge(game({ line: -7, model: -7 }))).toBeNull();
    expect(modelEdge(game({ line: -7, model: -7, cover: onSeven }))).toEqual({
      pick: "North Carolina",
      home: false,
      pickLine: 7,
      points: 0,
      odds: { cover: 0.5, push: 0.055, lose: 0.445 },
    });
  });

  it("follows the probability where it disagrees with the subtraction", () => {
    // The model lays 7.5 against a book at 7, which the subtraction reads as
    // half a point on Duke -- but the cover probabilities still lean to
    // North Carolina, and they decide.
    const edge = modelEdge(game({ line: -7, model: -7.5, cover: onSeven }));
    expect(edge).toMatchObject({ pick: "North Carolina", home: false });
    expect(edge?.points).toBeCloseTo(-0.5);
    // A side the points don't back gets no "+N" beside it.
    if (!SHOW_COVER_PROB) expect(edgeAmount(edge!)).toBeNull();
  });

  it("keeps the points beside a pick they agree with", () => {
    const edge = modelEdge(
      game({ line: -4.5, model: -8.5, cover: [0.58, 0.42, 0] }),
    );
    expect(edge).toMatchObject({ pick: "Duke", points: 4 });
    expect(edgeAmount(edge!)).toBe(SHOW_COVER_PROB ? "58%" : "+4");
  });

  it("needs no model spread to make a pick", () => {
    // A release with a kernel and no point-margin fit.
    const row = game({ line: -4.5, model: 0, cover: [0.42, 0.58, 0] });
    row.prediction!.predicted_spread = null;
    expect(modelEdge(row)).toMatchObject({
      pick: "North Carolina",
      points: null,
    });
  });

  it("says nothing when the two sides are within two points", () => {
    // 50.9% to 49.1%: a coin flip with a decimal on it. And the subtraction
    // doesn't get a second go -- four points of spread don't outvote it.
    const even = game({ line: -4.5, model: -8.5, cover: [0.509, 0.491, 0] });
    expect(modelEdge(even)).toBeNull();
    expect(atsCall(even)).toBeNull();
  });

  it("speaks at two points", () => {
    expect(
      modelEdge(game({ line: -4.5, model: -4.5, cover: [0.511, 0.489, 0] })),
    ).toMatchObject({ pick: "Duke" });
  });

  it("is graded on the score, however the pick was made", () => {
    // Duke won by 7 on a -7 line: a push, whichever side the model was on.
    expect(atsCall(game({ line: -7, model: -7, cover: onSeven }))?.result).toBe(
      "push",
    );
    // Won by 10 -- Duke covered, and the model was on North Carolina.
    expect(
      atsCall(game({ line: -7, model: -7, cover: onSeven, home: 81 }))?.result,
    ).toBe("miss");
  });
});

describe("pushNote", () => {
  it("names a push worth knowing about", () => {
    expect(
      pushNote(game({ line: -7, model: -7, cover: [0.445, 0.5, 0.055] })),
    ).toBe("6% push");
  });

  it("stays quiet below the threshold, on a half point, or without a kernel", () => {
    const below = NOTABLE_PUSH - 0.01;
    expect(
      pushNote(game({ line: -4, model: -4, cover: [0.5, 0.5 - below, below] })),
    ).toBeNull();
    expect(
      pushNote(game({ line: -4.5, model: -4, cover: [0.5, 0.5, 0] })),
    ).toBeNull();
    expect(pushNote(game({ line: -7, model: -7 }))).toBeNull();
  });
});

describe("edgeTitle with cover probabilities", () => {
  it("says which side is likelier, and why the points disagree", () => {
    const edge = modelEdge(
      game({ line: -7, model: -7.5, cover: [0.445, 0.5, 0.055] }),
    )!;
    expect(edgeTitle(edge)).toBe(
      SHOW_COVER_PROB
        ? "The model gives North Carolina a 50% chance to cover +7, with 6% on a push; its spread gives North Carolina 0.5 fewer points than the book does"
        : "The model makes North Carolina the likelier side to cover +7, with 6% on a push; its spread gives North Carolina 0.5 fewer points than the book does",
    );
  });
});
