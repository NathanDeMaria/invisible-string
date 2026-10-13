/**
 * Was the model right about the line? And before that: does it disagree at all?
 *
 * The two spread columns are the reason this page exists (DESIGN.md §13):
 * both are quoted from the home team's side, so the gap between them is the
 * model's disagreement with the book, read straight off the row. That gap is
 * there from the moment both numbers are -- which is when a reader wants it --
 * and once the game is final it has an answer. `modelEdge` is the
 * disagreement; `atsCall` is the answer.
 *
 * The pick is implied, never chosen: the model doesn't say "take Duke", it
 * says a number. Since cassandra started publishing a margin kernel, that
 * number can be a probability on the line itself -- P(home covers), P(away
 * covers), P(push) -- and the side the model likes is **the one more likely
 * to cover** (§13.6). That is not always the side the spread subtraction
 * favours: football games end on 3 and 7 far more often than on the margins
 * either side, so a model at -7 against a book at -7 isn't a coin flip --
 * the favourite has to win by *more* than 7, and a share of games land
 * exactly on it.
 *
 * A row with no cover probabilities -- an older release, or a league without
 * a kernel -- falls back to the subtraction: a model at -8.5 against a book
 * at -4.5 is saying the home team wins by more than the price, so the pick is
 * home.
 *
 * Kept out of the components for the reason `format.ts` is: every rule here is
 * a judgement about when *not* to speak -- no line, no result, or a
 * disagreement too small to be visible -- and those are worth testing
 * directly rather than through a rendered table.
 */

import type { GameRow } from "../../services/api";
import { points, probability, spread } from "./format";

/** How the side the model liked finished against the book's number. */
export type AtsResult = "hit" | "miss" | "push";

/**
 * Whether the page prints the model's cover probability.
 *
 * Off, on purpose, and the pick logic below doesn't depend on it. Measured
 * against real lines (2026-10-13, 443 lined ncaafb games), the cover
 * probabilities are overconfident: games the kernel put at 25% to cover were
 * covered 50-60% of the time, and its Brier score (0.27-0.28) is worse than
 * calling every game 50%. The kernel's *shape* is right; the overconfidence
 * is the model's disagreements with the line being mostly noise, which is the
 * same "no edge over the line" the betting ledger shows in points.
 *
 * cassandra plans a market-aware version -- the win probability shrunk
 * toward the line's before it goes through the kernel. When that ships, the
 * number is worth showing and this flips. Push alone is shown regardless (see
 * `NOTABLE_PUSH`): it comes from the kernel's shape, not the model's opinion.
 */
export const SHOW_COVER_PROB = false;

/**
 * Below this, the two cover probabilities are the same number.
 *
 * The probability version of `SAME_NUMBER`: inside two points of percentage
 * the model isn't saying anything about the line, and naming a side would
 * hand a coin flip an opinion it doesn't have. Two points rather than the
 * one `probability()` rounds to because the numbers are overconfident to
 * begin with (`SHOW_COVER_PROB`), so a gap that small is noise twice over.
 */
const SAME_CHANCE = 0.02;

/**
 * Below this, a push isn't worth a word.
 *
 * Every whole-number line has *some* push, so the threshold is what keeps the
 * note to the ones a reader should know about: in football that means lines
 * on 3, 7, 10 and 14, where a real share of games land, and practically never
 * anything in basketball, where the margin is a smooth curve. A half-point
 * line has no push at all.
 */
export const NOTABLE_PUSH = 0.04;

/** How a line settles, from one side: the three add to one. */
export interface CoverOdds {
  cover: number;
  push: number;
  lose: number;
}

/**
 * The model's disagreement with the book, and which way it falls.
 *
 * Everything here is knowable before the game is played, which is the whole
 * reason it's separate from the grade below it: a reader scanning tonight's
 * slate wants to know where the model is off the board, and until now the
 * page made them subtract two columns to find out.
 */
export interface ModelEdge {
  /** The team the model likes against the book's number. */
  pick: string;
  /** True when that side is the home team. */
  home: boolean;
  /** The book's number from that side: negative means the pick lays points. */
  pickLine: number;
  /**
   * Points the model's spread gives the pick beyond what the book gives it.
   *
   * Secondary to the pick when the pick came from cover probabilities, and
   * then it can be zero or even negative -- the -7 against -7 case -- because
   * the pick followed the probability and not the subtraction. Null when the
   * row has no model spread to subtract.
   */
  points: number | null;
  /** The pick's cover, push and lose, or null for a row the kernel didn't price. */
  odds: CoverOdds | null;
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
 * Which side the model is on, or null when it isn't saying.
 *
 * Null, not a zero: no line on the board, nothing from the model to read it
 * against, or the model's two sides within `SAME_CHANCE` (or, without cover
 * probabilities, its spread within `SAME_NUMBER` of the book's). None of
 * those is a disagreement, and rendering them as one would put a number on
 * rows that have nothing to report.
 *
 * A row the kernel priced is decided by the probabilities alone: if they say
 * the two sides are even, the subtraction doesn't get a second go.
 *
 * Unlike the grade below, this says nothing about whether the game has been
 * played -- an unplayed game is exactly the case it exists for.
 */
export function modelEdge(game: GameRow): ModelEdge | null {
  const line = game.market_spread;
  const prediction = game.prediction;
  if (line == null || prediction == null) return null;

  const model = prediction.predicted_spread;
  const homeCover = prediction.home_cover_prob;
  const awayCover = prediction.away_cover_prob;

  let home: boolean;
  let odds: CoverOdds | null = null;
  if (homeCover != null && awayCover != null) {
    const side = coverSide(homeCover, awayCover);
    if (side === null) return null;
    home = side === "home";
    const push = prediction.push_prob ?? 0;
    odds = home
      ? { cover: homeCover, push, lose: awayCover }
      : { cover: awayCover, push, lose: homeCover };
  } else {
    if (model == null) return null;
    // Positive when the model lays more than the book does, which is the
    // model liking the home side. Both numbers are from the home side
    // already, so this is a subtraction and not a sign puzzle.
    const edge = line - model;
    if (Math.abs(edge) < SAME_NUMBER) return null;
    home = edge > 0;
  }

  return {
    pick: home ? game.home : game.away,
    home,
    pickLine: home ? line : -line,
    points: model == null ? null : home ? line - model : model - line,
    odds,
  };
}

/**
 * The side likelier to cover, or null when the two are within `SAME_CHANCE`.
 *
 * The whole of the probability rule, on its own so the matchup page -- which
 * has a line the reader typed rather than a row -- reads it the same way.
 */
export function coverSide(
  homeCover: number,
  awayCover: number,
): "home" | "away" | null {
  const lean = homeCover - awayCover;
  if (Math.abs(lean) < SAME_CHANCE) return null;
  return lean > 0 ? "home" : "away";
}

/**
 * The model's side of this game's line, and how it finished -- or null for a
 * game there's nothing to say about yet.
 *
 * Everything `modelEdge` declines to answer, plus one more: a game with no
 * final score. The disagreement is real then, and the page shows it; what it
 * hasn't got is a verdict.
 *
 * The grade doesn't care how the pick was made: hit, miss or push, from the
 * final score against the book's number.
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
 * The amount beside the side in the shorthand -- "+4" or "54%" -- or null for
 * a side with nothing to quantify it.
 *
 * The cover probability once `SHOW_COVER_PROB` is on. Until then, the points
 * gap, but only when it points the same way as the pick: a pick that came
 * from the probabilities against a spread that says otherwise has no honest
 * "+N", and printing "+0" would be one.
 */
export function edgeAmount(edge: ModelEdge): string | null {
  if (SHOW_COVER_PROB && edge.odds) return probability(edge.odds.cover);
  if (edge.points == null || edge.points < SAME_NUMBER) return null;
  return `+${points(edge.points)}`;
}

/**
 * The push, when it is worth saying: "8% push", or null.
 *
 * About the line rather than about either side, so it is read off the row
 * and not the pick -- a game can land on the number whether or not the model
 * has an opinion about it.
 */
export function pushNote(game: GameRow): string | null {
  const push = game.prediction?.push_prob;
  if (push == null || push < NOTABLE_PUSH) return null;
  return `${probability(push)} push`;
}

/**
 * The pick said out loud, for the title on the shorthand that carries it.
 *
 * The cell has room for "home +4" and no more. The sentence that decodes it
 * lives here, and under the tables for anyone who can't hover. Phrased as
 * what the model's probabilities say, because that is all they are.
 */
export function edgeTitle(edge: ModelEdge): string {
  const line = spread(edge.pickLine);
  const gap = pointsClause(edge);

  if (edge.odds == null) {
    return `The model gives ${edge.pick} ${gap ?? "the same number as the book"}`;
  }
  const lead = SHOW_COVER_PROB
    ? `The model gives ${edge.pick} a ${probability(edge.odds.cover)} chance to cover ${line}`
    : `The model makes ${edge.pick} the likelier side to cover ${line}`;
  const push =
    edge.odds.push >= NOTABLE_PUSH
      ? `, with ${probability(edge.odds.push)} on a push`
      : "";
  return `${lead}${push}${gap ? `; its spread gives ${edge.pick} ${gap}` : ""}`;
}

/** "4 more points than the book does", or its mirror, or null for no gap. */
function pointsClause(edge: ModelEdge): string | null {
  if (edge.points == null || Math.abs(edge.points) < SAME_NUMBER) return null;
  const size = points(edge.points);
  const noun = size === "1" ? "point" : "points";
  const more = edge.points > 0 ? "more" : "fewer";
  return `${size} ${more} ${noun} than the book does`;
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
