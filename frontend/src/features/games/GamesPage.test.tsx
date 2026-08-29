import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { GamesPage } from "./GamesPage";

const headings = async () => {
  await screen.findAllByRole("table");
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((h) => h.textContent ?? "");
};

const rowFor = async (team: string) => {
  const cell = await screen.findByText(new RegExp(team));
  const row = cell.closest("tr");
  return row?.textContent ?? "";
};

describe("GamesPage", () => {
  it("puts today first, then tomorrow, then backwards", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // Not chronological in either direction: today is what the page is for,
    // and the finished days read backwards underneath it.
    expect(await headings()).toEqual([
      "Today",
      "Tomorrow",
      "Yesterday",
      expect.stringMatching(/\w/),
    ]);
  });

  it("shows the model, the line and the result in one row", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    const row = await rowFor("North Carolina @ Duke");
    expect(row).toContain("-5.3"); // the model, from the home side
    expect(row).toContain("-4.5"); // the book, same convention
    expect(row).toContain("71–78"); // away first, like the matchup
    expect(row).toContain("Duke"); // who won
  });

  it("marks a prediction the model has already trained on", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // Releases are rebuilt nightly, so last night's result is usually already
    // in the ratings that "predicted" it. That's hindsight, not a forecast.
    const marker = screen.getByTitle(/already trained on this result/);
    expect(marker.closest("tr")?.textContent).toContain(
      "North Carolina @ Duke",
    );
  });

  it("keeps the games of a league with no model", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // No release published for the nfl, so no prediction -- but the score and
    // the line are still worth the row.
    const row = await rowFor("Green Bay Packers @ Chicago Bears");
    expect(row).toContain("17");
    expect(row).toContain("+6.5");
  });

  it("says nothing rather than zero where a number is missing", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // Tomorrow's game has no line on the board and no score. A 0 in either
    // column would read as a pick'em and a scoreless final.
    const row = await rowFor("Houston @ Kansas");
    expect(row).not.toMatch(/\b0\b/);
    expect(row).toContain("—");
  });

  it("filters by league without refetching", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    await user.selectOptions(screen.getByLabelText("League"), "nfl");

    await waitFor(() =>
      expect(screen.queryByText(/North Carolina @ Duke/)).toBeNull(),
    );
    expect(
      screen.getByText(/Green Bay Packers @ Chicago Bears/),
    ).toBeInTheDocument();
    // One window covers every league, so this is a filter over what's already
    // loaded -- the day headings for leagues with nothing in them go with it.
    expect(await headings()).toEqual(["Yesterday"]);
  });

  it("narrows the window when you ask for fewer days", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    await user.selectOptions(screen.getByLabelText("Since"), "1");

    await waitFor(() =>
      expect(screen.queryByText(/North Carolina @ Duke/)).toBeNull(),
    );
    expect(await headings()).toEqual(["Today", "Tomorrow", "Yesterday"]);
  });

  it("summarizes the window above the tables", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    const meta = await screen.findByTestId("games-meta");
    expect(meta).toHaveTextContent("4 games");
    expect(meta).toHaveTextContent("2 days back");
  });

  it("explains the sign convention and the dagger", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // Two spread columns in the market's convention are unreadable without
    // the sentence that says which side they're quoted from.
    expect(screen.getByText(/home team’s side/)).toBeInTheDocument();
    expect(screen.getByText(/already trained on/)).toBeInTheDocument();
  });

  it("drops the dagger note when nothing is daggered", async () => {
    server.use(
      http.get("/api/games", () =>
        HttpResponse.json({
          days_back: 2,
          days_ahead: 1,
          since: "2026-08-20",
          until: "2026-08-23",
          games: [
            {
              league: "mens",
              game_id: "g",
              day: "2026-08-22",
              start: "2026-08-23T01:00:00Z",
              home: "Duke",
              away: "Houston",
              neutral: false,
              completed: false,
              home_score: null,
              away_score: null,
              market_spread: -2.5,
              prediction: {
                model: "glicko_tuned",
                run_id: "r1",
                home_win_prob: 0.63,
                predicted_spread: -3.7,
                in_sample: false,
              },
            },
          ],
        }),
      ),
    );
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // A footnote about a symbol that isn't on the page is one more thing to
    // go looking for.
    expect(screen.queryByText(/already trained on/)).toBeNull();
    expect(screen.getByText(/home team’s side/)).toBeInTheDocument();
  });

  it("reports an unreadable bucket rather than an empty evening", async () => {
    server.use(
      http.get("/api/games", () =>
        HttpResponse.json({ detail: "could not read s3" }, { status: 502 }),
      ),
    );
    renderApp(<GamesPage />, { route: "/games" });

    expect(
      await screen.findByText(/Games are unavailable/),
    ).toBeInTheDocument();
  });

  it("says an empty window is empty", async () => {
    server.use(
      http.get("/api/games", () =>
        HttpResponse.json({
          days_back: 2,
          days_ahead: 1,
          since: "2026-08-20",
          until: "2026-08-23",
          games: [],
        }),
      ),
    );
    renderApp(<GamesPage />, { route: "/games" });

    expect(
      await screen.findByText(/No games in this window/),
    ).toBeInTheDocument();
  });

  it("keeps the four columns a row needs", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    const table = (await screen.findAllByRole("table"))[0];

    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Game", "Model", "Line", "Result"]);
  });
});
