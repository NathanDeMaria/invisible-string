import { describe, expect, it } from "vitest";

import type { GameRow } from "../../services/api";
import { marketGap, marketGapTitle } from "./market";

const game = (market: number | null, model: number | null): GameRow => ({
  league: "mens",
  game_id: "g",
  day: "2026-08-20",
  start: "2026-08-21T01:00:00Z",
  home: "Duke",
  away: "North Carolina",
  neutral: false,
  completed: true,
  status: "STATUS_FINAL",
  home_score: 78,
  away_score: 71,
  market_spread: null,
  market_home_prob: market,
  prediction:
    model == null
      ? null
      : {
          model: "glicko_tuned",
          run_id: "r",
          home_win_prob: model,
          predicted_spread: null,
          home_rating: 1500,
          away_rating: 1400,
        },
});

describe("marketGap", () => {
  it("names the side the model rates above the market, in printed points", () => {
    expect(marketGap(game(0.66, 0.69))).toEqual({
      pick: "Duke",
      home: true,
      points: 3,
    });
    expect(marketGap(game(0.66, 0.6))).toEqual({
      pick: "North Carolina",
      home: false,
      points: 6,
    });
  });

  it("says nothing without both numbers", () => {
    expect(marketGap(game(null, 0.69))).toBeNull();
    expect(marketGap(game(0.66, null))).toBeNull();
  });

  it("says nothing when the two columns print the same", () => {
    // 66.4% and 65.6% both print as 66%: a gap the reader can't see.
    expect(marketGap(game(0.664, 0.656))).toBeNull();
  });

  it("says the gap out loud", () => {
    expect(marketGapTitle({ pick: "Duke", home: true, points: 1 })).toBe(
      "The model gives Duke 1 more point of win probability than the market does",
    );
  });
});
