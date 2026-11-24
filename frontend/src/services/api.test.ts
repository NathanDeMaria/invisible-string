import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStore } from "../app/store";
import { server } from "../test/server";
import { api } from "./api";

describe("an expired session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the reader to the login page and back to where they were", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      origin: window.location.origin,
      pathname: "/ncaafb/teams/42",
      search: "?model=x",
      assign,
    });
    server.use(
      http.get("*/api/leagues", () =>
        HttpResponse.json({ detail: "Not logged in" }, { status: 401 }),
      ),
    );

    const store = createStore();
    await store.dispatch(api.endpoints.getLeagues.initiate());

    expect(assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/ncaafb/teams/42?model=x")}`,
    );
  });

  it("leaves other errors alone", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    server.use(
      http.get("*/api/leagues", () => new HttpResponse(null, { status: 500 })),
    );

    const store = createStore();
    await store.dispatch(api.endpoints.getLeagues.initiate());

    expect(assign).not.toHaveBeenCalled();
  });
});
