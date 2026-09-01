/**
 * What order a day's games go in.
 *
 * The day used to be a slice of a chronological window, so the rows arrived
 * in the order the API sorts them -- by tip-off -- and that was the order they
 * were read in. On a single day that ordering answers a question nobody asked:
 * the games are all within a few hours of each other, and interleaving three
 * leagues by start time means a reader scanning for one league's slate reads
 * every row to find it.
 *
 * So: league first, and within a league the biggest game first. Kept out of
 * the components for the reason `format.ts` and `ats.ts` are -- the rules that
 * matter here are the ones about what to do when there is no number, and those
 * are worth testing directly rather than through a rendered table.
 */

import type { GameRow } from "../../services/api";

/**
 * The rating of the better team in a game, or null when there isn't one.
 *
 * Null for a league with no published release, and for a game whose teams the
 * release hasn't rated -- both of which arrive here as a row with no
 * prediction. `home_rating` and `away_rating` are only ever absent together,
 * because the API declines to predict a game unless it rates both sides.
 *
 * The *better* of the two rather than an average: a top team playing a cupcake
 * is a bigger game than two mid-table sides, and averaging says the opposite.
 */
export function topRating(game: GameRow): number | null {
  if (!game.prediction) return null;
  return Math.max(game.prediction.home_rating, game.prediction.away_rating);
}

/**
 * A day's games: league by league, best game first inside each.
 *
 * Ratings are only comparable *within* a league -- each release has its own
 * scale, and nothing says a glicko number for the nfl means what one for
 * ncaabb means. Sorting by league first is what makes the second key
 * meaningful at all, rather than a leaderboard across incomparable scales.
 *
 * A game with no rating sorts last in its league rather than first or missing:
 * "the model has nothing to say about this one" is a reason to read it after
 * the ones it does, and not a reason to drop it down the page past another
 * league entirely.
 *
 * Ties fall back to tip-off and then to the game id, so the order is total.
 * Two equally rated games reshuffling between renders would make the page look
 * like it was still loading.
 */
export function byLeagueThenRating(games: GameRow[]): GameRow[] {
  return [...games].sort((a, b) => {
    if (a.league !== b.league) return a.league < b.league ? -1 : 1;

    const top = topRating(a);
    const other = topRating(b);
    if (top !== other) {
      if (top === null) return 1;
      if (other === null) return -1;
      return other - top;
    }

    // Parsed rather than compared as strings: these carry the offset they
    // were written with, and "2026-08-22T19:00:00-05:00" sorts after
    // "2026-08-22T21:00:00Z" lexically while being an hour earlier.
    const start = new Date(a.start).getTime() - new Date(b.start).getTime();
    if (start !== 0) return start;
    return a.game_id < b.game_id ? -1 : 1;
  });
}
