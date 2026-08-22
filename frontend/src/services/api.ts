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
export type PredictResponse = components["schemas"]["PredictResponse"];
export type JobsResponse = components["schemas"]["JobsResponse"];
export type JobHealth = components["schemas"]["JobHealth"];
export type JobRun = components["schemas"]["JobRun"];
export type VolumeResponse = components["schemas"]["VolumeResponse"];
export type OddsDay = components["schemas"]["OddsDay"];
export type SeasonObject = components["schemas"]["SeasonObject"];

export interface RatingsArgs {
  league: string;
  model?: string;
}

/** Days of history. The backend caps it at a week -- see DESIGN.md §12.3. */
export interface WindowArgs {
  days: number;
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
    // Job health and data volume are separate queries against separate
    // endpoints because they read separate upstreams: Batch being slow
    // shouldn't blank the volume tables, or the other way round.
    getJobs: builder.query<JobsResponse, WindowArgs>({
      query: ({ days }) => ({ url: "jobs", params: { days } }),
    }),
    getJobVolume: builder.query<VolumeResponse, WindowArgs>({
      query: ({ days }) => ({ url: "jobs/volume", params: { days } }),
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
  usePredictQuery,
  useGetJobsQuery,
  useGetJobVolumeQuery,
} = api;
