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

export interface RatingsArgs {
  league: string;
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
  }),
});

export const { useGetLeaguesQuery, useGetRatingsQuery } = api;
