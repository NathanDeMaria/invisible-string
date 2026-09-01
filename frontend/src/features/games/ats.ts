/**
 * Was the model right about the line? And before that: does it disagree at all?
 *
 * The two spread columns are the reason this page exists (DESIGN.md §13):
 * both are quoted from the home team's side, so the gap between them is the
 * model's disagreement with the book, read straight off the row. That gap is
 * there from the moment both numbers are -- which is when a reader wants it --
 * and once the game is final it has an answer. `modelEdge` is the gap;
 * `atsCall` is the answer.
 *
 * The pick is implied, never chosen: the model doesn't say "take Duke", it
 * says a number, and the side it likes is whichever one its number gives more
 * points to than the book does. A model at -8.5 against a book at -4.5 is
 * saying the home team wins by more than the price -- so the pick is home, and
 * it hits if home wins by more than 4.5.
 *
 * Kept out of the components for the reason `format.ts` is: every rule here is
 * a judgement about when *not* to speak -- no line, no result, or a
 * disagreement too small to be visible -- and those are worth testing
 * directly rather than through a rendered table.
 */

import type { GameRow } from "../../services/api";
import { points, spread } from "./format";

/** How the side the model liked finished against the book's number. */
export type AtsResult = "hit" | "miss" | "push";

/**
 * The model's disagreement with the book, and which way it falls.
 *
 * Everything here is knowable before the game is played, which is the whole
 * reason it's separate from the grade below it: a reader scanning tonight's
 * slate wants to know where the model is off the board, and until now the
 * page made them subtract two columns to find out.
 */
export interface ModelEdge {
  /** The team the model's number likes, once set beside the book's. */
  pick: string;
  /** True when that side is the home team. */
  home: boolean;
  /** The book's number from that side: negative means the pick lays points. */
  pickLine: number;
  /** Points the model gives the pick beyond what the book gives it. */
  points: number;
}

export interface AtsCall extends ModelEdge {
  result: AtsResult;
}

/**
 * Below this, the two columns print the same number.
 *
 * `spread()` rounds to a tenth and calls anything inside half a point of zero
 * a pick'em, so a gap this small is invisible on the page. Speaking to it
 * would name a side on a disagreement the reader can't see, and hand a
 * coin-flip an opinion it doesn't have.
 */
const SAME_NUMBER = 0.05;

/**
 * Which side the model is on and by how much, or null when it isn't saying.
 *
 * Null, not a zero: no line on the board, no model number, or the two numbers
 * agreeing to within what the column prints. None of those is a disagreement,
 * and rendering them as one would put a number on rows that have nothing to
 * report.
 *
 * Unlike the grade below, this says nothing about whether the game has been
 * played -- an unplayed game is exactly the case it exists for.
 */
export function modelEdge(game: GameRow): ModelEdge | null {
  const line = game.market_spread;
  const model = game.prediction?.predicted_spread;
  if (line == null || model == null) return null;

  // Positive when the model lays more than the book does, which is the model
  // liking the home side. Both numbers are from the home side already, so
  // this is a subtraction and not a sign puzzle.
  const edge = line - model;
  if (Math.abs(edge) < SAME_NUMBER) return null;

  const home = edge > 0;
  return {
    pick: home ? game.home : game.away,
    home,
    pickLine: home ? line : -line,
    points: Math.abs(edge),
  };
}

/**
 * The model's side of this game's line, and how it finished -- or null for a
 * game there's nothing to say about yet.
 *
 * Everything `modelEdge` declines to answer, plus one more: a game with no
 * final score. The disagreement is real then, and the page shows it; what it
 * hasn't got is a verdict.
 *
 * A game the model has already trained on is graded like any other. The result
 * is real either way; what it *isn't* is a forecast, and the dagger beside it
 * (§13.3) is what says so.
 */
export function atsCall(game: GameRow): AtsCall | null {
  const edge = modelEdge(game);
  // `modelEdge` already required a line, so the second half of this never
  // fires -- it is what tells the compiler the arithmetic below is on numbers.
  if (edge === null || game.market_spread == null) return null;
  if (!game.completed || game.home_score == null || game.away_score == null) {
    return null;
  }

  // The book's own arithmetic, and cassandra's: `spread + home_mov > 0` is a
  // home cover. Zero is a push -- the game landed exactly on the number, and
  // neither side of it was right.
  const cover = game.home_score - game.away_score + game.market_spread;
  if (cover === 0) return { ...edge, result: "push" };
  const homeCovered = cover > 0;
  return { ...edge, result: edge.home === homeCovered ? "hit" : "miss" };
}

/**
 * The gap said out loud, for the title on the shorthand that carries it.
 *
 * The cell has room for "home +4" and no more. The sentence that decodes it
 * lives here, and under the tables for anyone who can't hover.
 */
export function edgeTitle(edge: ModelEdge): string {
  const size = points(edge.points);
  const noun = size === "1" ? "point" : "points";
  return `The model gives ${edge.pick} ${size} more ${noun} than the book does`;
}

/**
 * The mark said out loud, for the title that carries it.
 *
 * Always about the pick rather than about the home team: a reader hovering a
 * cross wants to know which side the model was on before they want to know
 * who covered, and naming the other team here is one more mapping to do.
 */
export function atsTitle(call: AtsCall): string {
  const at = `${call.pick} at ${spread(call.pickLine)}`;
  if (call.result === "push") {
    return `The model liked ${at}; the game landed on the number`;
  }
  const verb = call.result === "hit" ? "covered" : "didn’t cover";
  return `The model liked ${at}; ${call.pick} ${verb}`;
}
