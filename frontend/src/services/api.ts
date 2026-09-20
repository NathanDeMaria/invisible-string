import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

import type { components } from "../api/schema";

// Response types come from the committed OpenAPI schema rather than being
// hand-written, so a renamed field on the backend is a type error here
// instead of an `undefined` in the browser. CI regenerates and diffs
// schema.d.ts to catch the case where nobody reran the generator.
export type LeagueSummary = components["schemas"]["LeagueSummary"];
export type ModelSummary = components["schemas"]["ModelSummary"];
export type RatingsResponse = components["schemas"]["RatingsResponse"];
export type TeamRow = components["schemas"]["TeamRow"];
export type UnitRating = components["schemas"]["UnitRating"];
export type Movement = components["schemas"]["Movement"];
export type MovementWindow = components["schemas"]["MovementWindow"];
export type HistoryResponse = components["schemas"]["HistoryResponse"];
export type TeamSeries = components["schemas"]["TeamSeries"];
export type HistoryPoint = components["schemas"]["HistoryPoint"];
export type PredictResponse = components["schemas"]["PredictResponse"];
export type JobsResponse = components["schemas"]["JobsResponse"];
export type JobHealth = components["schemas"]["JobHealth"];
export type JobRun = components["schemas"]["JobRun"];
export type VolumeResponse = components["schemas"]["VolumeResponse"];
export type OddsDay = components["schemas"]["OddsDay"];
export type SeasonObject = components["schemas"]["SeasonObject"];
export type GamesResponse = components["schemas"]["GamesResponse"];
export type GameRow = components["schemas"]["GameRow"];
export type GamePrediction = components["schemas"]["GamePrediction"];
export type GameDetail = components["schemas"]["GameDetail"];
export type TeamGamesResponse = components["schemas"]["TeamGamesResponse"];
export type TeamGameRow = components["schemas"]["TeamGameRow"];
export type WinProbabilityResponse =
  components["schemas"]["WinProbabilityResponse"];
export type WinProbabilityFit = components["schemas"]["WinProbabilityFit"];
export type CurvePoint = components["schemas"]["CurvePoint"];
export type GameControl = components["schemas"]["GameControl"];
export type LuckyBounces = components["schemas"]["LuckyBounces"];
export type LuckySwing = components["schemas"]["LuckySwing"];
export type EpaPerPlay = components["schemas"]["EpaPerPlay"];
export type ExpectedPointsFit = components["schemas"]["ExpectedPointsFit"];
export type LeagueDistributions = components["schemas"]["LeagueDistributions"];
export type MetricDistribution = components["schemas"]["MetricDistribution"];

export interface RatingsArgs {
  league: string;
  model?: string;
}

/**
 * A team's rating over time. `teams` is comma-separated and capped at five by
 * the API -- the chart is one to a handful of lines, never a league.
 */
export interface HistoryArgs {
  league: string;
  teams: string;
  model?: string;
}

/**
 * One team's games. Singular, unlike `HistoryArgs` -- a chart overlays a
 * handful of lines and a game list is about one team by construction.
 */
export interface TeamGamesArgs {
  league: string;
  team: string;
  model?: string;
}

/** Days of history. The backend caps it at a week -- see DESIGN.md §12.3. */
export interface WindowArgs {
  days: number;
}

/**
 * The window the games page preloads, in days either side of today.
 * `ahead: 0` is the rest of today; the backend caps both at ten days.
 */
export interface GamesWindowArgs {
  back: number;
  ahead: number;
}

/**
 * One specific day, past the window's horizon.
 *
 * Not capped the way `GamesWindowArgs` is -- the backend reads a single day
 * at the same cost regardless of how far it is from today, which is what lets
 * the picker reach further than the window ever preloads.
 */
export interface GamesDayArgs {
  day: string;
}

export type GamesArgs = GamesWindowArgs | GamesDayArgs;

/**
 * One game, by the two things that name it on the wire -- plus the season,
 * for one the schedule source can't reach without it.
 *
 * `season` is optional because a game in the fortnight either side of today is
 * found without it, which is every game reached from the games table. A link
 * from a team's game list carries it, because most of those are older than
 * that (see `app.games.find_game`).
 */
export interface GameArgs {
  league: string;
  gameId: string;
  season?: number;
}

/**
 * A game, asked about as if something were true of it.
 *
 * Separate from `GameArgs` because only the game query takes these: the curve
 * is drawn from plays that happened and has no what-if to answer.
 */
export interface GameStatedArgs extends GameArgs {
  qbOutHome?: boolean;
  qbOutAway?: boolean;
  restHome?: boolean;
  restAway?: boolean;
}

export interface PredictArgs {
  league: string;
  home: string;
  away: string;
  neutral?: boolean;
  model?: string;
}

// Absolute rather than a bare "/api": Node's fetch (which is what jsdom uses
// under vitest) rejects relative URLs outright. Resolving against the current
// origin is also what we want in production, where FastAPI serves the built
// SPA from the same origin -- so there's no environment switch here.
const baseUrl = new URL("/api", window.location.origin).toString();

export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl }),
  endpoints: (builder) => ({
    getLeagues: builder.query<LeagueSummary[], void>({
      query: () => "leagues",
    }),
    getRatings: builder.query<RatingsResponse, RatingsArgs>({
      query: ({ league, model }) => ({
        url: `leagues/${league}/ratings`,
        params: model ? { model } : undefined,
      }),
    }),
    // The whole of a team's history in one request: a few hundred points, and
    // smaller than the ratings table the page was reached from. The season
    // range picker filters what came back rather than asking again.
    getHistory: builder.query<HistoryResponse, HistoryArgs>({
      query: ({ league, teams, model }) => ({
        url: `leagues/${league}/history`,
        params: model ? { teams, model } : { teams },
      }),
    }),
    // Job health and data volume are separate queries against separate
    // endpoints because they read separate upstreams: Batch being slow
    // shouldn't blank the volume tables, or the other way round.
    getJobs: builder.query<JobsResponse, WindowArgs>({
      query: ({ days }) => ({ url: "jobs", params: { days } }),
    }),
    getJobVolume: builder.query<VolumeResponse, WindowArgs>({
      query: ({ days }) => ({ url: "jobs/volume", params: { days } }),
    }),
    // One query for the whole window across every league: the games come from
    // one place (endgame's bucket) and the page filters by league in the
    // browser, so switching leagues is instant and hits nothing.
    //
    // `day` is the other shape this takes, for a day past the window's
    // horizon -- a distinct cache key from any window, so jumping out to an
    // old date and back doesn't cost the window its cache entry.
    getGames: builder.query<GamesResponse, GamesArgs>({
      query: (args) =>
        "day" in args
          ? { url: "games", params: { day: args.day } }
          : { url: "games", params: { back: args.back, ahead: args.ahead } },
    }),
    // The game page's two queries, against two endpoints, because they read
    // two upstreams: a season pickle for the schedule and a parquet object
    // for the plays. The chart being slow -- or absent -- must not hold up
    // the game it belongs to.
    getGame: builder.query<GameDetail, GameStatedArgs>({
      // The flags are omitted when false rather than sent as `false`, so an
      // untouched game page asks the same URL it always did -- one cache key
      // for the ordinary case, and a distinct one per what-if.
      query: ({
        league,
        gameId,
        season,
        qbOutHome,
        qbOutAway,
        restHome,
        restAway,
      }) => ({
        url: `games/${league}/${gameId}`,
        params: {
          ...(season ? { season } : {}),
          ...(qbOutHome ? { qb_out_home: true } : {}),
          ...(qbOutAway ? { qb_out_away: true } : {}),
          ...(restHome ? { rest_home: true } : {}),
          ...(restAway ? { rest_away: true } : {}),
        },
      }),
    }),
    getWinProbability: builder.query<WinProbabilityResponse, GameArgs>({
      query: ({ league, gameId, season }) => ({
        url: `games/${league}/${gameId}/win-probability`,
        // The same season the game itself is fetched with. Without it an old
        // game's curve 404s while the game above it renders, which reads as a
        // league with no play-by-play rather than as a link that outran the
        // schedule source.
        params: season ? { season } : undefined,
      }),
    }),
    // The team page's game list. One request for the whole career: a few
    // hundred rows, and smaller than the ratings table the page came from --
    // so the season picker filters what it already has, like the chart's.
    // The shape of a league's metrics, for saying where one game sits among
    // every other. One request per league rather than one per number: the
    // page already holds the metrics, and this is the population they are
    // measured against. 404s for every league without a play-level model,
    // which is every basketball league -- the page then renders its numbers
    // with no label beside them.
    getDistributions: builder.query<LeagueDistributions, { league: string }>({
      query: ({ league }) => `leagues/${league}/distributions`,
    }),
    getTeamGames: builder.query<TeamGamesResponse, TeamGamesArgs>({
      query: ({ league, team, model }) => ({
        url: `leagues/${league}/teams/${encodeURIComponent(team)}/games`,
        params: model ? { model } : undefined,
      }),
    }),
    predict: builder.query<PredictResponse, PredictArgs>({
      query: ({ league, home, away, neutral, model }) => ({
        url: "predict",
        // A GET, so RTK Query caches a matchup for free and re-picking a
        // previous pair is instant (DESIGN.md section 3).
        params: {
          league,
          home,
          away,
          ...(neutral ? { neutral: true } : {}),
          ...(model ? { model } : {}),
        },
      }),
    }),
  }),
});

export const {
  useGetLeaguesQuery,
  useGetRatingsQuery,
  useGetHistoryQuery,
  usePredictQuery,
  useGetJobsQuery,
  useGetJobVolumeQuery,
  useGetGamesQuery,
  useGetGameQuery,
  useGetWinProbabilityQuery,
  useGetTeamGamesQuery,
  useGetDistributionsQuery,
} = api;
