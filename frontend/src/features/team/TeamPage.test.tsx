import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { dukeGames, dukeHistory } from "../../test/handlers";
import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { TeamPage } from "./TeamPage";

const TEAM_ROUTE = (team: string, league = "mens") => ({
  route: `/${league}/teams/${encodeURIComponent(team)}`,
  path: "/:league/teams/:team",
});

/**
 * The season table, which is the chart's other half.
 *
 * Named rather than "the table on the page": the games list is a table too,
 * and both of them are rows about the same team. Each is reached through its
 * own caption, which is also what a screen reader tells them apart by.
 */
const seasonRows = () =>
  within(screen.getByRole("table", { name: /Every season/ }))
    .getAllByRole("row")
    .slice(1);

/** The games list under it. */
const gameRows = () =>
  within(screen.getByRole("table", { name: /Newest first/ }))
    .getAllByRole("row")
    .slice(1);

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
    // Both artifacts, because the picker narrows both halves of the page: a
    // team with one season of history and two of games has a second season to
    // pick, and offering nothing would leave half the list unreachable.
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
      http.get("/api/leagues/:league/teams/:team/games", () =>
        HttpResponse.json({
          ...dukeGames,
          games: dukeGames.games.filter((row) => row.season === 2026),
        }),
      ),
    );
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("img");

    expect(screen.queryByLabelText("Season")).toBeNull();
  });

  it("offers the picker for a season only the games know about", async () => {
    // The two artifacts are published separately, so one can carry a season
    // the other doesn't. Here the history is 2026 alone and the games reach
    // back into 2025 -- and 2025 has to be pickable, or those rows can only
    // ever be read as part of "all seasons".
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

    const picker = await screen.findByLabelText("Season");
    expect(
      within(picker).getByRole("option", { name: "2025" }),
    ).toBeInTheDocument();
  });

  it("lists the games the model forecast, newest first", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));

    await screen.findByRole("table", { name: /Newest first/ });
    const rows = gameRows();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Houston");
    expect(rows[3]).toHaveTextContent("Vermont");
  });

  it("says which way each game went", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("table", { name: /Newest first/ });

    // Home and won, away and lost, and one nobody has played.
    expect(gameRows()[2]).toHaveTextContent("W 78–71");
    expect(gameRows()[1]).toHaveTextContent("L 59–61");
    expect(gameRows()[0]).not.toHaveTextContent(/[WL] \d/);
  });

  it("marks which side of the fixture the team was on", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("table", { name: /Newest first/ });

    expect(gameRows()[1]).toHaveTextContent("@ Houston");
    expect(gameRows()[2]).toHaveTextContent("vs North Carolina");
  });

  it("shows both numbers from this team's side", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("table", { name: /Newest first/ });

    // Duke were 0.45 at Houston, getting 1.75 from the model and 1.5 from the
    // book -- the away end of a row the file stores from Houston's.
    const away = gameRows()[1];
    expect(away).toHaveTextContent("45%");
    expect(away).toHaveTextContent("+1.8");
    expect(away).toHaveTextContent("+1.5");
  });

  it("links every game, carrying the season the API needs", async () => {
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("table", { name: /Newest first/ });

    // The link is the whole point of the list: without the season on it, the
    // games API can only answer for the fortnight around today.
    expect(
      within(gameRows()[2]).getByRole("link", { name: /North Carolina/ }),
    ).toHaveAttribute("href", "/games/mens/401710101?season=2026");
    expect(
      within(gameRows()[3]).getByRole("link", { name: /Vermont/ }),
    ).toHaveAttribute("href", "/games/mens/401700101?season=2025");
  });

  it("narrows the games to the chosen season too", async () => {
    const user = userEvent.setup();
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("table", { name: /Newest first/ });

    await user.selectOptions(screen.getByLabelText("Season"), "2025");

    // One picker over both halves of the page: narrowing the chart to a
    // season and leaving the list on all of them would be two answers to one
    // question.
    await waitFor(() => expect(gameRows()).toHaveLength(1));
    expect(gameRows()[0]).toHaveTextContent("Vermont");
  });

  it("says so when the model has published no games", async () => {
    // elo has no predictions artifact, which is every model in the bucket
    // until it is republished. The list goes; the chart stays.
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));
    await screen.findByRole("table", { name: /Newest first/ });

    server.use(
      http.get("/api/leagues/:league/teams/:team/games", () =>
        HttpResponse.json({ ...dukeGames, model: "elo", games: [] }),
      ),
    );
    renderApp(<TeamPage />, TEAM_ROUTE("Duke"));

    expect(await screen.findByText(/No games published/)).toBeInTheDocument();
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
