import { HttpResponse, http } from "msw";

import type {
  GameRow,
  GamesResponse,
  JobHealth,
  JobRun,
  JobsResponse,
  LeagueSummary,
  PredictResponse,
  RatingsResponse,
  VolumeResponse,
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
  // Listed, but the ratings handler below 404s for it -- which is the real
  // shape of a league whose releases exist as prefixes but aren't servable,
  // and what the "no ratings published" case renders from.
  {
    league: "womens",
    models: [
      {
        name: "glicko_tuned",
        is_default: true,
        run_id: "r3",
        created_at: "2026-08-08T09:02:10Z",
        metrics: { ...metrics, brier_score: 0.1601 },
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

// -- job health -------------------------------------------------------
//
// Mirrors backend/tests/fixtures/jobs, and like the backend's local source it
// is relative to now: every duration on the page is an age, so fixed dates
// would render as "247d ago" a year from now and stop testing anything.

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

const jobRun = (
  definition: string,
  status: string,
  hours: number,
  extra: Partial<JobRun> = {},
): JobRun => ({
  job_id: `${definition}-${hours}`,
  name: `${definition}-scheduled-run`,
  definition,
  status,
  created_at: hoursAgo(hours),
  started_at: hoursAgo(hours),
  stopped_at: status === "RUNNING" ? null : hoursAgo(hours - 0.1),
  status_reason: null,
  exit_code: null,
  duration_seconds: status === "RUNNING" ? null : 360,
  ...extra,
});

const jobHealth = (
  definition: string,
  runs: JobRun[],
  overrides: Partial<JobHealth> = {},
): JobHealth => {
  const succeeded = runs.filter((r) => r.status === "SUCCEEDED").length;
  const failed = runs.filter((r) => r.status === "FAILED").length;
  const terminal = succeeded + failed;
  const [kind, league] = definition.startsWith("odds-")
    ? ["odds", definition.slice("odds-".length)]
    : ["games", definition.slice("daily-games-".length)];

  return {
    name: definition,
    kind,
    league,
    runs: runs.length,
    succeeded,
    failed,
    running: runs.length - terminal,
    success_rate: terminal ? succeeded / terminal : null,
    last_run: runs[0] ?? null,
    last_success_at:
      runs.find((r) => r.status === "SUCCEEDED")?.stopped_at ?? null,
    recent: runs,
    ...overrides,
  };
};

/** Already in the order the API sorts them: broken now, broken earlier, green. */
export const jobs: JobsResponse = {
  window_days: 7,
  since: hoursAgo(7 * 24),
  truncated: false,
  jobs: [
    jobHealth("daily-games-mens", [
      jobRun("daily-games-mens", "FAILED", 4, {
        status_reason: "ESPN returned 503 for scoreboard/20260821",
        exit_code: 1,
      }),
      jobRun("daily-games-mens", "SUCCEEDED", 28),
      jobRun("daily-games-mens", "SUCCEEDED", 52),
    ]),
    jobHealth("daily-games-womens", [
      jobRun("daily-games-womens", "SUCCEEDED", 4),
      jobRun("daily-games-womens", "FAILED", 28, {
        status_reason: "Essential container in task exited",
        exit_code: 1,
      }),
      jobRun("daily-games-womens", "SUCCEEDED", 52),
    ]),
    // Still in flight, so it counts toward neither side of the rate.
    jobHealth("odds-nfl", [
      jobRun("odds-nfl", "RUNNING", 0.2),
      jobRun("odds-nfl", "SUCCEEDED", 1),
      jobRun("odds-nfl", "SUCCEEDED", 2),
    ]),
    // Nothing has finished in the window at all.
    jobHealth("odds-ncaabb", [jobRun("odds-ncaabb", "RUNNING", 0.2)]),
  ],
};

const day = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

export const volume: VolumeResponse = {
  window_days: 7,
  since: hoursAgo(7 * 24),
  odds: [
    // An offseason league: the job succeeds every hour and pulls nothing,
    // which only the record count can tell you.
    {
      league: "ncaabb",
      day: day(0),
      pulls: 12,
      bytes: 2412,
      latest_at: hoursAgo(1),
      latest_records: 0,
    },
    {
      league: "ncaabb",
      day: day(1),
      pulls: 13,
      bytes: 2613,
      latest_at: hoursAgo(25),
      latest_records: null,
    },
    {
      league: "nfl",
      day: day(0),
      pulls: 12,
      bytes: 149204,
      latest_at: hoursAgo(1),
      latest_records: 61,
    },
    {
      league: "nfl",
      day: day(1),
      pulls: 13,
      bytes: 161880,
      latest_at: hoursAgo(25),
      latest_records: null,
    },
  ],
  seasons: [
    // Basketball in August: the whole schedule is on file and none of it has
    // been played, which is the case a size-only column called healthy.
    {
      league: "mens",
      year: 2026,
      artifact: "games",
      key: "seasons/2026/mens.pkl",
      bytes: 19402118,
      last_modified: hoursAgo(28),
      games: 5412,
      games_today: 0,
      games_in_window: 0,
    },
    // Rows, not games, so no count -- only a size.
    {
      league: "mens",
      year: 2026,
      artifact: "possessions",
      key: "seasons/2026/mens.csv",
      bytes: 84119002,
      last_modified: hoursAgo(28),
      games: null,
      games_today: null,
      games_in_window: null,
    },
    {
      league: "nfl",
      year: 2026,
      artifact: "games",
      key: "seasons/2026/nfl.pkl",
      bytes: 402889,
      last_modified: hoursAgo(4),
      games: 334,
      games_today: 4,
      games_in_window: 31,
    },
  ],
};

// -- games ------------------------------------------------------------
//
// Mirrors backend/tests/fixtures/games, and relative to now for the same
// reason the job fixtures are: the page groups by day against a "today" it
// derives from the window, so fixed dates would stop landing in it.

const isoDay = (offset: number): string => {
  const at = new Date(Date.now() + offset * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

const gameRow = (
  offset: number,
  overrides: Partial<GameRow> & Pick<GameRow, "game_id" | "home" | "away">,
): GameRow => ({
  league: "mens",
  day: isoDay(offset),
  start: new Date(Date.now() + offset * 86_400_000).toISOString(),
  neutral: false,
  completed: false,
  // The ordinary unplayed game: on the schedule, nothing to report.
  status: "STATUS_SCHEDULED",
  home_score: null,
  away_score: null,
  market_spread: null,
  prediction: null,
  ...overrides,
});

const predicted = (
  spread: number,
  homeWinProb: number,
  inSample = false,
): GameRow["prediction"] => ({
  model: "glicko_tuned",
  run_id: "r1",
  home_win_prob: homeWinProb,
  predicted_spread: spread,
  in_sample: inSample,
});

export const games: GamesResponse = {
  days_back: 2,
  days_ahead: 1,
  since: isoDay(-2),
  until: isoDay(1),
  games: [
    // Two days back, finished. The model has already trained on it, which is
    // what the dagger in the table is for.
    gameRow(-2, {
      game_id: "g-2",
      home: "Duke",
      away: "North Carolina",
      completed: true,
      status: "STATUS_FINAL",
      home_score: 78,
      away_score: 71,
      market_spread: -4.5,
      prediction: predicted(-5.3, 0.69, true),
    }),
    // Two days back, and called off. A row the dash can't explain: without a
    // status a reader waits all evening for a score that isn't coming.
    gameRow(-2, {
      league: "womens",
      game_id: "g-2c",
      home: "UConn",
      away: "Vermont",
      status: "STATUS_CANCELED",
    }),
    // Yesterday, and a league with no published model: score and line only.
    gameRow(-1, {
      league: "nfl",
      game_id: "g-1",
      home: "Chicago Bears",
      away: "Green Bay Packers",
      completed: true,
      // Saved before endgame carried a status. Final, but nothing said so.
      status: "",
      home_score: 17,
      away_score: 24,
      market_spread: 6.5,
    }),
    // Tonight.
    gameRow(0, {
      game_id: "g0",
      home: "Houston",
      away: "Duke",
      market_spread: -2.5,
      prediction: predicted(-3.7, 0.633),
    }),
    // Tonight, already under way. The season file's partial score is a
    // snapshot from whenever the job ran, so the row shows the state instead.
    gameRow(0, {
      game_id: "g0live",
      home: "Kansas",
      away: "Vermont",
      status: "STATUS_IN_PROGRESS",
      market_spread: -18.5,
    }),
    // Tomorrow, with no line on the board yet.
    gameRow(1, {
      game_id: "g1",
      home: "Kansas",
      away: "Houston",
      prediction: predicted(2.1, 0.44),
    }),
  ],
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
  http.get("/api/jobs", ({ request }) => {
    const days = Number(new URL(request.url).searchParams.get("days") ?? 7);
    // The window is a real filter, not decoration: a shorter one drops the
    // older runs, which is what the picker is for.
    const cutoff = Date.now() - days * 86_400_000;
    return HttpResponse.json({
      ...jobs,
      window_days: days,
      jobs: jobs.jobs.map((job) => ({
        ...job,
        recent: job.recent.filter(
          (r) => new Date(r.created_at).getTime() >= cutoff,
        ),
      })),
    });
  }),
  http.get("/api/games", ({ request }) => {
    const back = Number(new URL(request.url).searchParams.get("back") ?? 2);
    // The window is a real filter, not decoration: a shorter one drops the
    // older days, which is what the picker is for.
    const since = isoDay(-back);
    return HttpResponse.json({
      ...games,
      days_back: back,
      since,
      games: games.games.filter((game) => game.day >= since),
    });
  }),
  http.get("/api/jobs/volume", ({ request }) => {
    const days = Number(new URL(request.url).searchParams.get("days") ?? 7);
    return HttpResponse.json({ ...volume, window_days: days });
  }),
  http.get("/api/leagues/:league/ratings", ({ params, request }) => {
    if (params.league !== "mens") {
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }
    const model = new URL(request.url).searchParams.get("model");
    return HttpResponse.json(model === "elo" ? elo : glicko);
  }),
];
