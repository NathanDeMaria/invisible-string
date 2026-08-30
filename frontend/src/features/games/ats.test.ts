import { describe, expect, it } from "vitest";

import type { GameRow } from "../../services/api";
import { atsCall, atsTitle } from "./ats";

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
    expect(call).toEqual({ pick: "Duke", pickLine: -4.5, result: "hit" });
  });

  it("takes the away side when the model likes the underdog", () => {
    // The same game with the model at -1.5: it thinks the home team is being
    // asked to lay too much, which is a bet on the visitors -- and they lost
    // by 7, so the number was wrong.
    const call = atsCall(game({ line: -4.5, model: -1.5 }));
    expect(call).toEqual({
      pick: "North Carolina",
      pickLine: 4.5,
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
    expect(call).toEqual({ pick: "Duke", pickLine: -7, result: "push" });
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
    expect(atsTitle({ pick: "Duke", pickLine: -4.5, result: "hit" })).toBe(
      "The model liked Duke at -4.5; Duke covered",
    );
    expect(
      atsTitle({ pick: "North Carolina", pickLine: 4.5, result: "miss" }),
    ).toBe(
      "The model liked North Carolina at +4.5; North Carolina didn’t cover",
    );
  });

  it("says a push landed on the number rather than blaming a side", () => {
    expect(atsTitle({ pick: "Duke", pickLine: -7, result: "push" })).toBe(
      "The model liked Duke at -7; the game landed on the number",
    );
  });
});
