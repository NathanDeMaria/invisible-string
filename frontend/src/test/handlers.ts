import { HttpResponse, http } from "msw";

import type {
  CurvePoint,
  GameDetail,
  GameRow,
  GamesResponse,
  HistoryResponse,
  JobHealth,
  JobRun,
  JobsResponse,
  LeagueSummary,
  PredictResponse,
  LeagueDistributions,
  RatingsResponse,
  TeamGameRow,
  TeamGamesResponse,
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
  {
    league: "ncaafb",
    models: [
      {
        name: "compound_glicko",
        is_default: true,
        run_id: "r4",
        created_at: "2026-08-08T09:05:44Z",
        metrics: { ...metrics, brier_score: 0.1694 },
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
  // The week the movement column is measured from -- the last game of the
  // snapshot before this release's own.
  movement_since: { year: 2026, week: 1, date: "2026-07-31T23:00:00Z" },
  ratings: [
    {
      rank: 1,
      team: "Duke",
      rating: 1834.2,
      rd: 71.4,
      wins: 24,
      losses: 5,
      // Held its place while gaining ground, which is the case a table of
      // arrows alone would render as nothing at all.
      movement: { rating: 24.2, rank: 0, wins: 2, losses: 0 },
    },
    {
      rank: 2,
      team: "Houston",
      rating: 1810.0,
      rd: 68.0,
      wins: 26,
      losses: 4,
      movement: { rating: -8.5, rank: -1, wins: 1, losses: 1 },
    },
    // A name with a space in it, which is most of them -- and what the team
    // page's link has to survive encoding and decoding.
    {
      rank: 3,
      team: "North Carolina",
      rating: 1790.0,
      rd: 74.1,
      wins: 22,
      losses: 8,
      movement: { rating: -10.5, rank: 0, wins: 1, losses: 1 },
    },
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
  // Published before the history artifact existed, which is every model in the
  // bucket until it is republished: the column goes rather than filling with
  // dashes.
  movement_since: null,
  ratings: [
    { rank: 1, team: "Duke", rating: 1801.0, rd: null, wins: 24, losses: 5 },
    { rank: 2, team: "Houston", rating: 1799.5, rd: null, wins: 26, losses: 4 },
  ],
};

/**
 * Mirrors backend/tests/fixtures/models/ncaafb/compound_glicko: the one model
 * that rates a team's two halves apart.
 *
 * Georgia leads the table on a defense nobody else has and Ohio State has the
 * better offense, so a page that rendered the team rating under both headings
 * would look plausible and still fail. Alabama carries no units at all -- a
 * team the play-by-play index never had a game for, which is what stops the
 * columns from promising a number for every row.
 */
export const compound: RatingsResponse = {
  league: "ncaafb",
  model: "compound_glicko",
  run_id: "r4",
  created_at: "2026-08-08T09:05:44Z",
  trained_through: {
    season_year: 2026,
    last_game_date: "2026-08-07T23:45:00Z",
    processed_game_ids: [],
  },
  metrics: { ...metrics, brier_score: 0.1694 },
  movement_since: null,
  ratings: [
    {
      rank: 1,
      team: "Georgia",
      rating: 1892.4,
      rd: 58.2,
      wins: 12,
      losses: 1,
      offense: { rating: 1861.0, rd: 74.5 },
      defense: { rating: 1923.8, rd: 69.1 },
    },
    {
      rank: 2,
      team: "Ohio State",
      rating: 1874.1,
      rd: 61.0,
      wins: 11,
      losses: 2,
      offense: { rating: 1948.2, rd: 71.2 },
      defense: { rating: 1800.0, rd: 76.4 },
    },
    {
      rank: 3,
      team: "Alabama",
      rating: 1751.9,
      rd: 70.3,
      wins: 9,
      losses: 4,
    },
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
  homeRating = 1600,
  awayRating = 1500,
): GameRow["prediction"] => ({
  model: "glicko_tuned",
  run_id: "r1",
  home_win_prob: homeWinProb,
  predicted_spread: spread,
  home_rating: homeRating,
  away_rating: awayRating,
});

export const games: GamesResponse = {
  days_back: 2,
  days_ahead: 1,
  since: isoDay(-2),
  until: isoDay(1),
  games: [
    // Two days back, finished. Its number is the forecast the run made
    // before it was played, which is what the mark beside it grades.
    gameRow(-2, {
      game_id: "g-2",
      home: "Duke",
      away: "North Carolina",
      completed: true,
      status: "STATUS_FINAL",
      home_score: 78,
      away_score: 71,
      market_spread: -4.5,
      prediction: predicted(-5.3, 0.69),
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
    // Tomorrow, and football: the one game on this board that can be asked a
    // what-if, since only football prices the matchup terms.
    gameRow(1, {
      league: "nfl",
      game_id: "g1nfl",
      home: "Detroit Lions",
      away: "Minnesota Vikings",
      market_spread: -3.5,
      prediction: predicted(-4.1, 0.6),
    }),
  ],
};

// -- one game, and its curve ------------------------------------------
//
// Two endpoints because the app reads two upstreams, and the fixtures keep
// that separation: a game exists whether or not anyone has play-by-play for
// it, and only football has a fit at all.

/**
 * Only football has a win probability model, which is what the flag says --
 * and only football prices the matchup terms, which is what `matchup` being
 * null says everywhere else. A played football game reports what was true; an
 * unplayed one reports what has been stated, which starts as nothing.
 */
export const detailFor = (
  row: GameRow,
  stated?: URLSearchParams,
  season = 2026,
): GameDetail => {
  const football = row.league === "nfl" || row.league === "ncaafb";
  const on = (flag: string) => stated?.get(flag) === "true";
  // The real API prices these through the model; the fake just has to move
  // the number the same direction, so a test can tell a toggle that reached
  // the request from one that didn't.
  const edge =
    (on("qb_out_away") ? 0.1 : 0) -
    (on("qb_out_home") ? 0.1 : 0) +
    (on("rest_home") ? 0.05 : 0) -
    (on("rest_away") ? 0.05 : 0);

  return {
    ...row,
    season,
    week: 3,
    has_win_probability: football,
    prediction:
      row.prediction && edge
        ? {
            ...row.prediction,
            home_win_prob: row.prediction.home_win_prob + edge,
          }
        : row.prediction,
    matchup: football
      ? {
          qb_out_home: on("qb_out_home"),
          qb_out_away: on("qb_out_away"),
          // A played game's rest is read off the season schedule rather than
          // stated: the fixture below is a home side off the longer break, so
          // the page has something other than "level" to render.
          rest_home: row.completed ? true : on("rest_home"),
          rest_away: row.completed ? false : on("rest_away"),
        }
      : null,
  };
};

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
  /**
   * A game the two averages disagree about, which is the case the pair is on
   * the page for: the Bears were the better offense while it was still a
   * game (+0.20 a snap) and the Packers over the whole thing (+0.80), because
   * Chicago's last drive came with the result already settled and weighs
   * almost nothing.
   *
   * The weights are the honest part and the fixture keeps them so: Chicago's
   * four snaps are worth 2.9 of a live game and Green Bay's five are worth
   * 3.9, which is what the sample column has to be able to say.
   */
  epa: {
    home: 0.3711,
    away: 0.1713,
    net: 0.1998,
    home_unweighted: -0.3875,
    away_unweighted: 0.41,
    net_unweighted: -0.7975,
    home_plays: 4,
    away_plays: 5,
    home_weight: 2.94,
    away_weight: 3.92,
  },
  expected_points_fit: {
    league: "nfl",
    run_id: "20260904-024017",
    // A different range from the curve's fit, which is the point of the two
    // being named separately: they are two files that move on their own.
    seasons: [2022, 2023, 2024, 2025],
    n_games: 2433,
    log_loss: 1.319,
    mean_absolute_error: 3.75,
  },
  trained_on_this_season: false,
};

// -- what a metric usually looks like ----------------------------------

/**
 * The nfl metric shapes, as deliberately straight ramps.
 *
 * The real artifact is 101 checkpoints off five seasons and has the shape you
 * would expect. These don't, on purpose: a linear ramp makes the percentile
 * of any value arithmetic a test can state in its own assertion, so a test
 * that says "69th" is checking the lookup rather than restating whatever the
 * fixture happened to contain.
 *
 * `epa_per_play` runs -1.00 to 1.00 in steps of 0.02, and `game_control` runs
 * 0 to 1 in steps of 0.01 -- so a control share *is* its own percentile.
 */
const ramp = (from: number, to: number): number[] =>
  Array.from({ length: 101 }, (_, i) => from + ((to - from) * i) / 100);

export const nflDistributions: LeagueDistributions = {
  schema_version: 1,
  league: "nfl",
  run_id: "20260901-014420",
  created_at: "2026-09-01T01:44:20Z",
  seasons: [2021, 2022, 2023, 2024, 2025],
  metrics: {
    epa_per_play: { unit: "team-game", n: 2850, values: ramp(-1, 1) },
    game_control: { unit: "team-game", n: 2850, values: ramp(0, 1) },
  },
};

// -- one team's games -------------------------------------------------
//
// Mirrors backend/tests/fixtures/models/mens/glicko_tuned/predictions.json,
// turned around to face Duke the way the API turns it: `win_prob` is Duke's
// and both spreads are from Duke's side, so a negative one is a game Duke was
// favoured in whether they were home or away.

const teamGame = (
  overrides: Partial<TeamGameRow> &
    Pick<TeamGameRow, "game_id" | "date" | "season" | "opponent">,
): TeamGameRow => ({
  week: 1,
  home: true,
  neutral: false,
  team_score: null,
  opponent_score: null,
  win_prob: null,
  predicted_spread: null,
  market_spread: null,
  ...overrides,
});

/**
 * Duke's games, newest first, across the two seasons the chart draws.
 *
 * Four rows because four things have to render differently: a win, a loss, a
 * game nobody has played yet, and one from a season the games API can only
 * reach if the link names it -- which is what the season on every link is for.
 */
export const dukeGames: TeamGamesResponse = {
  league: "mens",
  model: "glicko_tuned",
  run_id: "r1",
  team: "Duke",
  games: [
    // Not played. The run forecasts fixtures as well as results, so the newest
    // rows in the file have no score to show.
    teamGame({
      game_id: "g0",
      date: "2026-08-23T00:00:00Z",
      season: 2026,
      opponent: "Houston",
      home: false,
      win_prob: 0.37,
      predicted_spread: 3.7,
      market_spread: 2.5,
    }),
    // Away, and lost. Every number here is the complement of the one the file
    // stores, which is the flip the API does.
    teamGame({
      game_id: "401710103",
      date: "2026-08-22T02:00:00Z",
      season: 2026,
      opponent: "Houston",
      home: false,
      team_score: 59,
      opponent_score: 61,
      win_prob: 0.45,
      predicted_spread: 1.75,
      market_spread: 1.5,
    }),
    // Home, and won.
    teamGame({
      game_id: "401710101",
      date: "2026-08-21T01:00:00Z",
      season: 2026,
      opponent: "North Carolina",
      team_score: 78,
      opponent_score: 71,
      win_prob: 0.62,
      predicted_spread: -5.5,
      market_spread: -4.5,
    }),
    // Last season, which is the row the games window cannot reach at all.
    teamGame({
      game_id: "401700101",
      date: "2025-12-19T23:45:00Z",
      season: 2025,
      week: 6,
      opponent: "Vermont",
      team_score: 90,
      opponent_score: 55,
      win_prob: 0.94,
      predicted_spread: -22.5,
      market_spread: -21.5,
    }),
  ],
};

/**
 * The games only reachable by naming a season.
 *
 * Kept beside the season rather than inside the row, because that is the shape
 * of the read: `GameRow` has no season on it, and the API finds these by
 * looking in one season's file. The handler below serves one *only* when the
 * request names the season it is actually in -- naming the wrong one has to
 * miss, or a test can't tell a link that carries the season from one that
 * merely carries something.
 */
const archived: { season: number; row: GameRow }[] = [
  {
    season: 2025,
    row: gameRow(-250, {
      game_id: "401700101",
      home: "Duke",
      away: "Vermont",
      completed: true,
      status: "STATUS_FINAL",
      home_score: 90,
      away_score: 55,
      market_spread: -21.5,
      prediction: predicted(-22.5, 0.94),
    }),
  },
];

/**
 * Duke's rating over two seasons: six weeks of 2025 and two of 2026.
 *
 * Two seasons rather than one because the offseason between them is the case
 * the chart has to get right -- the line breaks there, and the jump is
 * `pass_season` rather than a game.
 */
const dukeWeeks: [number, number, string, number, number, number][] = [
  [2025, 1, "2025-11-14T23:00:00Z", 1702.0, 2, 1],
  [2025, 2, "2025-11-21T23:30:00Z", 1718.4, 4, 1],
  [2025, 3, "2025-11-28T22:45:00Z", 1709.9, 5, 2],
  [2025, 4, "2025-12-05T23:15:00Z", 1735.2, 7, 2],
  [2025, 5, "2025-12-12T23:00:00Z", 1751.8, 9, 2],
  [2025, 6, "2025-12-19T23:45:00Z", 1766.3, 11, 2],
  [2026, 1, "2026-07-31T23:00:00Z", 1810.0, 22, 5],
  [2026, 2, "2026-08-07T23:15:00Z", 1834.2, 24, 5],
];

export const dukeHistory: HistoryResponse = {
  league: "mens",
  model: "glicko_tuned",
  run_id: "r1",
  series: [
    {
      team: "Duke",
      points: dukeWeeks.map(([year, week, date, rating, wins, losses]) => ({
        year,
        week,
        date,
        rating,
        rd: 71.4,
        wins,
        losses,
      })),
    },
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
  http.get("/api/games/:league/:gameId", ({ params, request }) => {
    const q = new URL(request.url).searchParams;
    const matches = (game: GameRow) =>
      game.league === params.league && game.game_id === params.gameId;
    // The window first, then the season file -- and only when the request
    // named a season, because that is the whole rule the team page's links
    // are built around.
    const asked = q.get("season");
    const old = asked
      ? archived.find(
          (entry) => String(entry.season) === asked && matches(entry.row),
        )
      : undefined;
    const row = games.games.find(matches) ?? old?.row;
    if (!row) {
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }
    return HttpResponse.json(detailFor(row, q, old?.season));
  }),
  http.get("/api/leagues/:league/distributions", ({ params }) => {
    // Only football has play-level metrics to describe, so every other league
    // 404s permanently -- which is the state the page renders by leaving its
    // numbers unlabelled rather than an error it reports.
    if (params.league !== "nfl") {
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }
    return HttpResponse.json(nflDistributions);
  }),
  http.get("/api/leagues/:league/teams/:team/games", ({ params, request }) => {
    if (params.league !== "mens") {
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }
    // elo has no predictions artifact, exactly as in the backend fixtures:
    // the page loses its game list and keeps its chart.
    if (new URL(request.url).searchParams.get("model") === "elo") {
      return HttpResponse.json({ ...dukeGames, model: "elo", games: [] });
    }
    if (params.team !== "Duke") {
      return HttpResponse.json({
        ...dukeGames,
        team: String(params.team),
        games: [],
      });
    }
    return HttpResponse.json(dukeGames);
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
      // The fit is named on both, since "this league has no expected points
      // model" and "this game had no snaps to score" are different states.
      epa: params.gameId === "g-1" ? winProbability.epa : null,
      home_team_id: params.gameId === "g-1" ? "3" : null,
      away_team_id: params.gameId === "g-1" ? "9" : null,
    });
  }),
  http.get("/api/jobs/volume", ({ request }) => {
    const days = Number(new URL(request.url).searchParams.get("days") ?? 7);
    return HttpResponse.json({ ...volume, window_days: days });
  }),
  http.get("/api/leagues/:league/ratings", ({ params, request }) => {
    if (params.league === "ncaafb") {
      return HttpResponse.json(compound);
    }
    if (params.league !== "mens") {
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }
    const model = new URL(request.url).searchParams.get("model");
    return HttpResponse.json(model === "elo" ? elo : glicko);
  }),
  http.get("/api/leagues/:league/history", ({ params, request }) => {
    if (params.league !== "mens") {
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }
    const q = new URL(request.url).searchParams;
    // A team with no rows is an empty series rather than a 404, exactly as
    // the API answers: the file can't tell an unrated team from a
    // nonexistent one, and elo has no history published at all.
    const asked = (q.get("teams") ?? "").split(",").map((t) => t.trim());
    const known = q.get("model") === "elo" ? [] : dukeHistory.series;
    return HttpResponse.json({
      ...dukeHistory,
      model: q.get("model") ?? "glicko_tuned",
      series: asked.map(
        (team) =>
          known.find((entry) => entry.team === team) ?? { team, points: [] },
      ),
    });
  }),
];
