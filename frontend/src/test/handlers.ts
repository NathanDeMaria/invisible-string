import { HttpResponse, http } from "msw";

import type {
  LeagueSummary,
  PredictResponse,
  RatingsResponse,
} from "../services/api";

// Mirrors backend/tests/fixtures/models/mens/glicko_tuned. `margin_mae` is
// over every game with a final score; the other two are the model's and the
// closing line's error over just the games a book priced, and are null for a
// league with no odds coverage.
const metrics = {
  brier_score: 0.1782,
  margin_mae: 9.4,
  against_spread_accuracy: 0.508,
  spread_game_margin_mae: 9.1,
  market_margin_mae: 8.8,
  n_games: 98342,
  n_spread_games: 21150,
};

export const leagues: LeagueSummary[] = [
  {
    league: "mens",
    models: [
      {
        name: "glicko_tuned",
        is_default: true,
        run_id: "r1",
        created_at: "2026-08-08T09:00:12Z",
        metrics,
      },
      {
        name: "elo",
        is_default: false,
        run_id: "r2",
        created_at: "2026-08-08T09:01:44Z",
        metrics: { ...metrics, brier_score: 0.1954 },
      },
    ],
  },
];

export const glicko: RatingsResponse = {
  league: "mens",
  model: "glicko_tuned",
  run_id: "r1",
  created_at: "2026-08-08T09:00:12Z",
  trained_through: {
    season_year: 2026,
    last_game_date: "2026-08-07T23:15:00Z",
    processed_game_ids: [],
  },
  metrics,
  ratings: [
    { rank: 1, team: "Duke", rating: 1834.2, rd: 71.4, wins: 24, losses: 5 },
    { rank: 2, team: "Houston", rating: 1810.0, rd: 68.0, wins: 26, losses: 4 },
  ],
};

// Elo has no rating deviation, so the RD column should disappear. Its MAEs are
// set the other way round from glicko's -- better than the closing line rather
// than worse -- so switching models exercises both directions of the
// comparison in the header.
const elo: RatingsResponse = {
  ...glicko,
  model: "elo",
  run_id: "r2",
  metrics: {
    ...metrics,
    brier_score: 0.1954,
    spread_game_margin_mae: 8.6,
    market_margin_mae: 8.8,
  },
  ratings: [
    { rank: 1, team: "Duke", rating: 1801.0, rd: null, wins: 24, losses: 5 },
    { rank: 2, team: "Houston", rating: 1799.5, rd: null, wins: 26, losses: 4 },
  ],
};

/**
 * Stands in for the real predictor with something monotone in the rating gap,
 * so the sign relationships the UI depends on hold: whoever is more likely to
 * win lays the points, and `predicted_spread` is from the *home* team's side.
 */
export const predictionFor = ({
  home,
  away,
  neutral = false,
}: {
  home: string;
  away: string;
  neutral?: boolean;
}): PredictResponse => {
  const ratingOf = (team: string) =>
    glicko.ratings.find((row) => row.team === team)?.rating ?? 1500;
  const edge = ratingOf(home) - ratingOf(away) + (neutral ? 0 : 95);
  const homeProb = 1 / (1 + Math.pow(10, -edge / 400));

  return {
    league: "mens",
    model: "glicko_tuned",
    run_id: "r1",
    home,
    away,
    neutral,
    home_win_prob: homeProb,
    away_win_prob: 1 - homeProb,
    // Margin is positive when home wins by that much; the wire format negates.
    predicted_spread: -(edge / 25),
    home_rating: ratingOf(home),
    away_rating: ratingOf(away),
  };
};

export const handlers = [
  http.get("/api/leagues", () => HttpResponse.json(leagues)),
  http.get("/api/predict", ({ request }) => {
    const q = new URL(request.url).searchParams;
    const home = q.get("home") ?? "";
    const away = q.get("away") ?? "";
    if (!home || !away) {
      return HttpResponse.json({ detail: "missing team" }, { status: 422 });
    }
    return HttpResponse.json(
      predictionFor({ home, away, neutral: q.get("neutral") === "true" }),
    );
  }),
  http.get("/api/leagues/:league/ratings", ({ params, request }) => {
    if (params.league !== "mens") {
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }
    const model = new URL(request.url).searchParams.get("model");
    return HttpResponse.json(model === "elo" ? elo : glicko);
  }),
];
