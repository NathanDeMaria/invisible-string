import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { renderApp } from "./test/render";

const at = () => screen.getByTestId("location").textContent;

describe("navigation", () => {
  it("offers leagues at the top level, not league-panel pairs", async () => {
    renderApp(<App />, { route: "/mens/ratings" });
    // The nav element exists before the leagues query resolves, so wait for a
    // link rather than for the nav.
    await screen.findByRole("link", { name: "mens" });
    const leagueNav = screen.getByRole("navigation", { name: "League" });

    expect(
      within(leagueNav).getByRole("link", { name: "mens" }),
    ).toBeInTheDocument();
    // The flat version had "mens matchup" up here beside "mens", which made a
    // league and one of its panels look like siblings.
    expect(
      within(leagueNav).queryByRole("link", { name: /matchup/i }),
    ).toBeNull();
  });

  it("puts the panels under the league", async () => {
    renderApp(<App />, { route: "/mens/ratings" });
    const panels = await screen.findByRole("navigation", { name: "Panel" });

    expect(
      within(panels).getByRole("link", { name: "Leaderboard" }),
    ).toBeInTheDocument();
    expect(
      within(panels).getByRole("link", { name: "Matchup" }),
    ).toBeInTheDocument();
  });

  it("switches panels without losing the league", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/womens/ratings" });

    await user.click(await screen.findByRole("link", { name: "Matchup" }));

    await waitFor(() => expect(at()).toBe("/womens/matchup"));
  });

  it("keeps the panel when the league changes", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/mens/matchup" });

    await user.click(await screen.findByRole("link", { name: "womens" }));

    // Not /womens/ratings: the outer tabs move where you are, they don't
    // discard it.
    await waitFor(() => expect(at()).toBe("/womens/matchup"));
  });

  it("lands on the leaderboard when a league is picked", async () => {
    renderApp(<App />, { route: "/mens" });
    await waitFor(() => expect(at()).toBe("/mens/ratings"));
  });

  it("sends the bare root somewhere useful", async () => {
    renderApp(<App />, { route: "/" });
    await waitFor(() => expect(at()).toBe("/mens/ratings"));
  });
});

describe("legacy URLs", () => {
  /**
   * `/ratings/:league` and `/:league/ratings` have the same number of static
   * and dynamic segments, so which one React Router picks is worth checking
   * rather than assuming. If the ranking ever went the other way, `/ratings/mens`
   * would render a league literally named "ratings" -- an empty page rather
   * than an error.
   */
  it("redirects the old ratings URL", async () => {
    renderApp(<App />, { route: "/ratings/womens" });
    await waitFor(() => expect(at()).toBe("/womens/ratings"));
  });

  it("redirects the old matchup URL, query string intact", async () => {
    renderApp(<App />, { route: "/matchup/mens" });
    await waitFor(() => expect(at()).toBe("/mens/matchup"));
  });

  it("does not read 'ratings' as a league name", async () => {
    renderApp(<App />, { route: "/ratings/mens" });
    await waitFor(() => expect(at()).toBe("/mens/ratings"));
    // The league heading is the tell: a mis-ranked route renders "ratings" here.
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("mens");
  });
});
