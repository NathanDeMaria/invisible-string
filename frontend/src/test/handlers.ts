import { HttpResponse, http } from "msw";

import type {
  CurvePoint,
  GameDetail,
  GameRow,
  GamesResponse,
  JobHealth,
  JobRun,
  JobsResponse,
  LeagueSummary,
  PredictResponse,
  RatingsResponse,
  VolumeResponse,
  WinProbabilityResponse,
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

/**
 * A day `offset` days from today, in US Central.
 *
 * The zone matters, and adding milliseconds to `Date.now()` was the wrong
 * arithmetic for it: that files a game under the *runner's* date, which is a
 * day ahead of Central for the hours either side of UTC midnight. The old
 * page asked for a window and grouped whatever came back, so it never
 * noticed; a page that asks for one particular day does.
 *
 * Its own implementation rather than the page's, because this stands in for
 * the backend -- which has one of its own, in `app.games.window_bounds`. A
 * fixture that agreed with the browser by construction couldn't catch the
 * page reading the wrong day.
 */
export const isoDay = (offset: number): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    Number(parts.find((piece) => piece.type === type)?.value);
  const at = new Date(part("year"), part("month") - 1, part("day") + offset);
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

/**
 * The ratings the win probability came from, on the release's own scale.
 *
 * Defaulted rather than required on every call: only the ordering cares which
 * game has the better team in it, and spelling two numbers onto rows that
 * exist to test a status label would bury what those rows are for.
 */
const predicted = (
  spread: number,
  homeWinProb: number,
  inSample = false,
  homeRating = 1600,
  awayRating = 1500,
): GameRow["prediction"] => ({
  model: "glicko_tuned",
  run_id: "r1",
  home_win_prob: homeWinProb,
  predicted_spread: spread,
  in_sample: inSample,
  home_rating: homeRating,
  away_rating: awayRating,
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
    // Yesterday, finished, and the model was on the wrong side of it: it
    // gave the home team more than the book did, and the visitors covered.
    // Out of sample too, so the cross carries no dagger.
    gameRow(-1, {
      league: "womens",
      game_id: "g-1w",
      home: "South Carolina",
      away: "UConn",
      completed: true,
      status: "STATUS_FINAL",
      home_score: 68,
      away_score: 72,
      market_spread: -6.5,
      prediction: predicted(-9.2, 0.78),
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

// -- one game, and its curve ------------------------------------------
//
// Two endpoints because the app reads two upstreams, and the fixtures keep
// that separation: a game exists whether or not anyone has play-by-play for
// it, and only football has a fit at all.

/** Only football has a win probability model, which is what the flag says. */
const detailFor = (row: GameRow): GameDetail => ({
  ...row,
  season: 2026,
  week: 3,
  has_win_probability: row.league === "nfl" || row.league === "ncaafb",
});

/**
 * A short game whose scoreboard moves twice, which is all the chart needs to
 * be worth testing: a line with a shape, two scoring marks, and a control
 * number that isn't 0.5.
 *
 * Written as (period, clock, home, away, probability, split) rather than as
 * full objects -- the fields that don't vary are noise in a fixture whose
 * point is the six that do. The last one defaults to the one before it, so a
 * snap only says what the bounces did to it where they did something: the
 * fumble is in the third quarter, and every snap from it carries the gap.
 */
const snap = (
  period: number,
  clock: number,
  home: number,
  away: number,
  prob: number,
  adjusted: number = prob,
): CurvePoint => ({
  play_id: `p${period}-${clock}`,
  play_number: (period - 1) * 100 + (900 - clock),
  period,
  clock_seconds: clock,
  seconds_remaining: clock + (4 - period) * 900,
  home_score: home,
  away_score: away,
  home_win_prob: prob,
  adjusted_win_prob: adjusted,
});

export const winProbability: WinProbabilityResponse = {
  league: "nfl",
  game_id: "g-1",
  home: "Chicago Bears",
  away: "Green Bay Packers",
  home_team_id: "3",
  away_team_id: "9",
  fit: {
    league: "nfl",
    run_id: "20260901-004159",
    seasons: [2023, 2024, 2025],
    n_games: 3975,
    brier_score: 0.159,
    log_loss: 0.476,
  },
  control: { home: 0.42, away: 0.58, seconds: 3580 },
  adjusted_control: { home: 0.37, away: 0.63, seconds: 3580 },
  luck: {
    home: 0.12,
    away: 0.03,
    swings: [
      {
        // The fumble the Bears came up with in the third, which is the one
        // the two lines part company over.
        play_id: "p3-640",
        play_number: 260,
        kind: "fumble_lost",
        retained: 0.5,
        realized: 0.5,
        counterfactual: 0.26,
        home_delta: 0.12,
      },
      {
        play_id: "p4-500",
        play_number: 400,
        kind: "fumble_kept",
        retained: 0.5,
        realized: 0.78,
        counterfactual: 0.84,
        home_delta: -0.03,
      },
    ],
  },
  // The gate is open on this one, so the page says nothing about it -- the
  // paragraph about a feed that records only half the coin is the other case,
  // and `GamePage.test.tsx` asks for it with a fixture of its own.
  records_defended_passes: true,
  points: [
    snap(1, 890, 0, 0, 0.54),
    snap(1, 402, 0, 0, 0.5),
    snap(1, 96, 0, 7, 0.31),
    snap(2, 700, 0, 7, 0.33),
    snap(2, 210, 7, 7, 0.52),
    snap(3, 640, 7, 7, 0.5, 0.44),
    snap(3, 120, 14, 7, 0.74, 0.68),
    snap(4, 500, 14, 7, 0.78, 0.72),
    snap(4, 40, 17, 24, 0.04, 0.05),
  ],
  trained_on_this_season: false,
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
    const q = new URL(request.url).searchParams;
    const back = Number(q.get("back") ?? 2);
    const ahead = Number(q.get("ahead") ?? 1);
    // Both ends are a real filter, not decoration. The page asks for one day
    // as an offset from today, so `ahead` is what stops a request for
    // yesterday from also answering with tomorrow.
    const since = isoDay(-back);
    const until = isoDay(ahead);
    return HttpResponse.json({
      ...games,
      days_back: back,
      days_ahead: ahead,
      since,
      until,
      games: games.games.filter(
        (game) => game.day >= since && game.day <= until,
      ),
    });
  }),
  http.get("/api/games/:league/:gameId", ({ params }) => {
    const row = games.games.find(
      (game) => game.league === params.league && game.game_id === params.gameId,
    );
    if (!row) {
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }
    return HttpResponse.json(detailFor(row));
  }),
  http.get("/api/games/:league/:gameId/win-probability", ({ params }) => {
    if (params.league !== "nfl") {
      return HttpResponse.json({ detail: "no model" }, { status: 404 });
    }
    // Only the finished game has plays. The scheduled one is the case the
    // page has to say something about rather than draw.
    return HttpResponse.json({
      ...winProbability,
      game_id: String(params.gameId),
      points: params.gameId === "g-1" ? winProbability.points : [],
      control: params.gameId === "g-1" ? winProbability.control : null,
      adjusted_control:
        params.gameId === "g-1" ? winProbability.adjusted_control : null,
      luck: params.gameId === "g-1" ? winProbability.luck : null,
      home_team_id: params.gameId === "g-1" ? "3" : null,
      away_team_id: params.gameId === "g-1" ? "9" : null,
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
