/**
 * Was the model right about the line?
 *
 * The two spread columns are the reason this page exists (DESIGN.md §13):
 * both are quoted from the home team's side, so the gap between them is the
 * model's disagreement with the book, read straight off the row. Once the game
 * is final that disagreement has an answer, and this is it.
 *
 * The pick is implied, never chosen: the model doesn't say "take Duke", it
 * says a number, and the side it likes is whichever one its number gives more
 * points to than the book does. A model at -8.5 against a book at -4.5 is
 * saying the home team wins by more than the price -- so the pick is home, and
 * it hits if home wins by more than 4.5.
 *
 * Kept out of the components for the reason `format.ts` is: every rule here is
 * a judgement about when *not* to grade -- no line, no result, or a
 * disagreement too small to be visible -- and those are worth testing
 * directly rather than through a rendered table.
 */

import type { GameRow } from "../../services/api";
import { spread } from "./format";

/** How the side the model liked finished against the book's number. */
export type AtsResult = "hit" | "miss" | "push";

export interface AtsCall {
  /** The team the model's number likes, once set beside the book's. */
  pick: string;
  /** The book's number from that side: negative means the pick lays points. */
  pickLine: number;
  result: AtsResult;
}

/**
 * Below this, the two columns print the same number.
 *
 * `spread()` rounds to a tenth and calls anything inside half a point of zero
 * a pick'em, so a gap this small is invisible on the page. Grading it would
 * put a check mark on a disagreement the reader can't see, and hand a
 * coin-flip an opinion it doesn't have.
 */
const SAME_NUMBER = 0.05;

/**
 * The model's side of this game's line, and how it finished -- or null for a
 * game there's nothing to say about yet.
 *
 * Null, not a fourth result, in four cases: no line on the board, no model
 * number, no final score, and the two numbers agreeing. None of them is a
 * grade, and rendering them as one would put a mark on most of the page.
 *
 * A game the model has already trained on is graded like any other. The result
 * is real either way; what it *isn't* is a forecast, and the dagger beside it
 * (§13.3) is what says so.
 */
export function atsCall(game: GameRow): AtsCall | null {
  const line = game.market_spread;
  const model = game.prediction?.predicted_spread;
  if (line == null || model == null) return null;
  if (!game.completed || game.home_score == null || game.away_score == null) {
    return null;
  }

  // Positive when the model lays more than the book does, which is the model
  // liking the home side. Both numbers are from the home side already, so
  // this is a subtraction and not a sign puzzle.
  const edge = line - model;
  if (Math.abs(edge) < SAME_NUMBER) return null;

  const likesHome = edge > 0;
  const pick = likesHome ? game.home : game.away;
  const pickLine = likesHome ? line : -line;

  // The book's own arithmetic, and cassandra's: `spread + home_mov > 0` is a
  // home cover. Zero is a push -- the game landed exactly on the number, and
  // neither side of it was right.
  const cover = game.home_score - game.away_score + line;
  if (cover === 0) return { pick, pickLine, result: "push" };
  const homeCovered = cover > 0;
  return { pick, pickLine, result: likesHome === homeCovered ? "hit" : "miss" };
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
