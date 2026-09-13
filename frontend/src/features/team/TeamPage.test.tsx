import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { dukeHistory } from "../../test/handlers";
import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { TeamPage } from "./TeamPage";

const TEAM_ROUTE = (team: string, league = "mens") => ({
  route: `/${league}/teams/${encodeURIComponent(team)}`,
  path: "/:league/teams/:team",
});

/** The season table, which is the chart's other half. */
const seasonRows = () =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("TeamPage", () => {
  it("names the team and where it stands", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));

    expect(
      await screen.findByRole("heading", { name: "Duke", level: 2 }),
    ).toBeInTheDocument();
    // Awaited, because the heading renders from the URL before the ratings
    // arrive -- these are the part that had to come back.
    expect(await screen.findByText("Rank")).toBeInTheDocument();
    // The rank the leaderboard printed, out of the response it already had --
    // not a second computation of it that could disagree.
    expect(screen.getByText("Rank").nextSibling).toHaveTextContent("1");
    expect(screen.getByText("Rating").nextSibling).toHaveTextContent("1834.2");
    expect(screen.getByText("Record").nextSibling).toHaveTextContent("24–5");
  });

  it("puts a team's two halves beside its rating", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Georgia", "ncaafb"));

    expect(await screen.findByText("Offense")).toBeInTheDocument();
    // The units, not the rating copied twice: Georgia leads this table on its
    // defense, and its offense is the lower of the two numbers.
    expect(screen.getByText("Offense").nextSibling).toHaveTextContent("1861.0");
    expect(screen.getByText("Defense").nextSibling).toHaveTextContent("1923.8");
    expect(screen.getByText("Rating").nextSibling).toHaveTextContent("1892.4");
  });

  it("says how settled each half is", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Georgia", "ncaafb"));

    expect(await screen.findByText("Offense")).toBeInTheDocument();
    expect(screen.getByText("Offense").nextSibling).toHaveTextContent(
      "RD 74.5",
    );
  });

  it("says nothing about halves for a team the model has no plays for", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Alabama", "ncaafb"));

    // The rating arrives, so this is the page rendered rather than the page
    // still loading -- and there is still no Offense on it.
    expect(await screen.findByText("Rating")).toBeInTheDocument();
    expect(screen.queryByText("Offense")).toBeNull();
    expect(screen.queryByText("Defense")).toBeNull();
  });

  it("says nothing about halves for a model that rates only the result", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));

    expect(await screen.findByText("Rating")).toBeInTheDocument();
    expect(screen.queryByText("Offense")).toBeNull();
  });

  it("repeats the week's movement rather than recomputing it", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));

    expect(await screen.findByText("Last week")).toBeInTheDocument();
    expect(screen.getByText("Last week").nextSibling).toHaveTextContent(
      "+24.2",
    );
    expect(
      screen.getByTitle(/Up 24.2 points since Jul 31, going 2-0/),
    ).toBeInTheDocument();
  });

  it("draws the rating over every week the model has rated it", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));

    // The chart carries its own summary for a reader who gets the label
    // rather than the picture.
    const chart = await screen.findByRole("img");
    expect(chart).toHaveAccessibleName(
      "Duke's rating over 8 weeks, from 1702 in 2025 rising to 1834 in 2026",
    );
  });

  it("gives each season its own line", async () => {
    // The offseason is a gap: `pass_season` regressed the rating, no game did.
    const { container } = renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("img");

    expect(container.querySelectorAll(".timeline-line")).toHaveLength(2);
    expect(container.querySelector(".timeline-break")).toBeInTheDocument();
  });

  it("says what a week was when you stop on it", async () => {
    const user = userEvent.setup();
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));

    const chart = await screen.findByRole("img");
    // Before hovering, the readout holds its place rather than appearing and
    // pushing the page down.
    expect(screen.getByRole("status")).toHaveTextContent(/hover for a week/);

    // jsdom gives every element a zero-size bounding rect, so the pointer's
    // place across the plot can't be computed from one -- stub it with the
    // viewBox's own width and the mapping is the real one.
    chart.getBoundingClientRect = () =>
      ({ left: 0, width: 640, top: 0, height: 240 }) as DOMRect;
    await user.pointer({
      target: chart,
      coords: { clientX: 320, clientY: 120 },
    });

    // The middle of eight weeks is the last of 2025, and the readout carries
    // what a reader stops on a point to ask: what it was, and when.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1735.2"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("week 4 of 2025");
    expect(screen.getByRole("status")).toHaveTextContent("7-2");
  });

  it("tables the seasons under the chart", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("img");

    // Newest first, and the change is within the season -- one measured from
    // last season would carry the offseason rollover in it.
    const rows = seasonRows();
    expect(rows[0]).toHaveTextContent("2026");
    expect(rows[0]).toHaveTextContent("+24.2");
    expect(rows[1]).toHaveTextContent("2025");
    expect(rows[1]).toHaveTextContent("+64.3");
  });

  it("narrows to one season on request", async () => {
    const user = userEvent.setup();
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("img");

    await user.selectOptions(screen.getByLabelText("Season"), "2026");

    await waitFor(() => expect(seasonRows()).toHaveLength(1));
    expect(await screen.findByRole("img")).toHaveAccessibleName(/over 2 weeks/);
  });

  it("offers no season picker when there is only one season", async () => {
    server.use(
      http.get("/api/leagues/:league/history", () =>
        HttpResponse.json({
          ...dukeHistory,
          series: [
            {
              team: "Duke",
              points: dukeHistory.series[0].points.filter(
                (point) => point.year === 2026,
              ),
            },
          ],
        }),
      ),
    );
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("img");

    expect(screen.queryByLabelText("Season")).toBeNull();
  });

  it("says so when the model has no history published", async () => {
    // Every model published before the artifact existed. Not an error: it
    // resolves itself on the next publish.
    renderApp(<TeamPage />, TEAM_ROUTE("Houston"));

    expect(
      await screen.findByText(/No rating history published/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says a team the release doesn't rate isn't one", async () => {
    // The history file can't answer this -- it has no rows for anybody before
    // its model is republished -- but the ratings table can, and it's in hand.
    renderApp(<TeamPage />, TEAM_ROUTE("Vermont"));

    expect(
      await screen.findByText(/doesn’t rate a team called Vermont/),
    ).toBeInTheDocument();
  });

  it("says so when the league has no ratings at all", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("UConn", "womens"));
    expect(await screen.findByText(/No ratings published/)).toBeInTheDocument();
  });

  it("reads a team name with a space back out of the URL", async () => {
    // Most team names have one, and the link encodes them. Asserted on the
    // standing rather than the heading, which renders from the URL before
    // anything has come back and so would pass either way.
    renderApp(<TeamPage />, TEAM_ROUTE("North Carolina"));

    expect(await screen.findByText("Rank")).toBeInTheDocument();
    expect(screen.getByText("Rank").nextSibling).toHaveTextContent("3");
    expect(
      screen.getByRole("heading", { name: "North Carolina", level: 2 }),
    ).toBeInTheDocument();
  });
});
