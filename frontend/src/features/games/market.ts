/**
 * The model's win probability against the prediction markets'.
 *
 * The same question `ats.ts` asks of the spreads, asked of the other number
 * in the row: both are the home team's chance of winning, so the gap between
 * them is the model's disagreement with the market, readable straight off the
 * row. Kalshi's price where it has the game and Polymarket's where it doesn't,
 * with the markets' margin taken out -- see `app.markets` in the backend.
 *
 * Kept out of the component for the reason `ats.ts` is: the rule worth testing
 * is when *not* to speak.
 */

import type { GameRow } from "../../services/api";

export interface MarketGap {
  /** The team the model rates more likely to win than the market does. */
  pick: string;
  /** True when that side is the home team. */
  home: boolean;
  /** How many points of probability more, as the two columns print them. */
  points: number;
}

/**
 * Which side the model likes against the market, and by how much -- or null
 * when it isn't saying.
 *
 * Measured between the two numbers *as the page prints them*, whole
 * percentages, the way `points()` measures the spreads: a reader who
 * subtracts the two columns should get this back, and a gap that rounds away
 * is one they can't see. Null for no market price, no model number, or two
 * numbers that print the same.
 */
export function marketGap(game: GameRow): MarketGap | null {
  const market = game.market_home_prob;
  const model = game.prediction?.home_win_prob;
  if (market == null || model == null) return null;

  const gap = Math.round(model * 100) - Math.round(market * 100);
  if (gap === 0) return null;

  const home = gap > 0;
  return {
    pick: home ? game.home : game.away,
    home,
    points: Math.abs(gap),
  };
}

/** The gap said out loud, for the title on the shorthand that carries it. */
export function marketGapTitle(gap: MarketGap): string {
  const noun = gap.points === 1 ? "point" : "points";
  return `The model gives ${gap.pick} ${gap.points} more ${noun} of win probability than the market does`;
}
