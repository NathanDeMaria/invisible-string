import { describe, expect, it } from "vitest";

import type { GameRow } from "../../services/api";
import { byLeagueThenRating, topRating } from "./order";

/**
 * A game, named by its two teams' ratings rather than by a score: everything
 * here is about what order rows go in, and the rating of the better team is
 * the only thing on a row that decides it.
 */
const game = ({
  id,
  league = "mens",
  home = 1500,
  away = 1400,
  rated = true,
  start = "2026-08-22T19:00:00-05:00",
}: {
  id: string;
  league?: string;
  home?: number;
  away?: number;
  rated?: boolean;
  start?: string;
}): GameRow => ({
  league,
  game_id: id,
  day: "2026-08-22",
  start,
  home: `${id}-home`,
  away: `${id}-away`,
  neutral: false,
  completed: false,
  status: "STATUS_SCHEDULED",
  home_score: null,
  away_score: null,
  market_spread: null,
  prediction: rated
    ? {
        model: "glicko_tuned",
        run_id: "r1",
        home_win_prob: 0.6,
        predicted_spread: -3,
        in_sample: false,
        home_rating: home,
        away_rating: away,
      }
    : null,
});

const order = (games: GameRow[]) =>
  byLeagueThenRating(games).map((g) => g.game_id);

describe("topRating", () => {
  it("takes the better of the two, not the average", () => {
    // A top team playing a cupcake is a bigger game than two mid-table sides,
    // and the average says the opposite.
    expect(topRating(game({ id: "a", home: 1900, away: 1200 }))).toBe(1900);
    expect(topRating(game({ id: "b", home: 1200, away: 1900 }))).toBe(1900);
  });

  it("has nothing to say about a game with no prediction", () => {
    expect(topRating(game({ id: "a", rated: false }))).toBeNull();
  });
});

describe("byLeagueThenRating", () => {
  it("groups the leagues before it ranks anything", () => {
    // Ratings are only comparable within a league -- each release has its own
    // scale -- so the nfl game does not outrank a mens game by having a
    // bigger number on it.
    const games = [
      game({ id: "m-small", league: "mens", home: 1500 }),
      game({ id: "n-big", league: "nfl", home: 9000 }),
      game({ id: "m-big", league: "mens", home: 1800 }),
    ];
    expect(order(games)).toEqual(["m-big", "m-small", "n-big"]);
  });

  it("puts the best game in a league first", () => {
    const games = [
      game({ id: "mid", home: 1500, away: 1450 }),
      game({ id: "best", home: 1400, away: 1900 }),
      game({ id: "worst", home: 1100, away: 1000 }),
    ];
    expect(order(games)).toEqual(["best", "mid", "worst"]);
  });

  it("sorts an unrated game to the end of its own league, not the page", () => {
    // A league with no published release, or a team the release has never
    // rated. "Nothing to say about this one" is a reason to read it after the
    // ones there is something to say about -- and not a reason to drop it
    // past another league entirely.
    const games = [
      game({ id: "n-rated", league: "nfl", home: 1500 }),
      game({ id: "m-unrated", league: "mens", rated: false }),
      game({ id: "m-rated", league: "mens", home: 1500 }),
    ];
    expect(order(games)).toEqual(["m-rated", "m-unrated", "n-rated"]);
  });

  it("breaks a tie on tip-off, then on the id", () => {
    // Equally rated games reshuffling between renders would make the page
    // look like it hadn't finished loading.
    const games = [
      game({ id: "late", start: "2026-08-22T21:00:00-05:00" }),
      game({ id: "early", start: "2026-08-22T18:00:00-05:00" }),
    ];
    expect(order(games)).toEqual(["early", "late"]);
    expect(order([...games].reverse())).toEqual(["early", "late"]);
  });

  it("compares tip-offs as instants, not as strings", () => {
    // Both are the same evening. Lexically the offset one sorts last; it is
    // an hour earlier.
    const games = [
      game({ id: "utc", start: "2026-08-23T01:00:00Z" }),
      game({ id: "offset", start: "2026-08-22T19:00:00-05:00" }),
    ];
    expect(order(games)).toEqual(["offset", "utc"]);
  });

  it("leaves the caller's array alone", () => {
    const games = [
      game({ id: "b", home: 1200 }),
      game({ id: "a", home: 1800 }),
    ];
    byLeagueThenRating(games);
    expect(games.map((g) => g.game_id)).toEqual(["b", "a"]);
  });
});
