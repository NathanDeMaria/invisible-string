import { describe, expect, it } from "vitest";

import type { GameRow } from "../../services/api";
import { atsCall, atsTitle, edgeTitle, modelEdge } from "./ats";

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
  home = 78,
  away = 71,
  ...rest
}: {
  line: number | null;
  model: number | null;
  home?: number | null;
  away?: number | null;
  completed?: boolean;
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
  prediction:
    model == null
      ? null
      : {
          model: "glicko_tuned",
          run_id: "r1",
          home_win_prob: 0.69,
          predicted_spread: model,
          in_sample: false,
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
        result: "hit",
      }),
    ).toBe("The model liked Duke at -4.5; Duke covered");
    expect(
      atsTitle({
        pick: "North Carolina",
        home: false,
        pickLine: 4.5,
        points: 3,
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
    });
  });

  it("falls on the away side when the model won't lay the price", () => {
    expect(modelEdge(game({ line: -4.5, model: -1.5 }))).toEqual({
      pick: "North Carolina",
      home: false,
      pickLine: 4.5,
      points: 3,
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
      edgeTitle({ pick: "Duke", home: true, pickLine: -4.5, points: 4 }),
    ).toBe("The model gives Duke 4 more points than the book does");
  });

  it("says one point rather than one points", () => {
    expect(
      edgeTitle({ pick: "Duke", home: true, pickLine: -4.5, points: 1 }),
    ).toBe("The model gives Duke 1 more point than the book does");
  });

  it("rounds to what the columns print", () => {
    // 0.75 of a point of disagreement between two numbers printed to a tenth.
    expect(
      edgeTitle({ pick: "Duke", home: true, pickLine: -4.5, points: 0.75 }),
    ).toBe("The model gives Duke 0.8 more points than the book does");
  });
});
