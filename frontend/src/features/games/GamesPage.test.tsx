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

  it("marks a finished game the model got right against the line", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // The model had Duke laying 5.3 against a line of 4.5, and Duke won by 7:
    // the side it took covered. That verdict is the page's whole point, and
    // it sits on the number that earned it.
    const mark = screen.getByTitle(
      "The model liked Duke at -4.5; Duke covered",
    );
    expect(mark).toHaveTextContent("✓");
    expect(mark.closest("tr")?.textContent).toContain("North Carolina @ Duke");
  });

  it("marks one it got wrong, and says which side it was on", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // Named from the side the model took rather than from the home team's:
    // a reader hovering a cross wants to know what the model backed.
    const mark = screen.getByTitle(
      "The model liked South Carolina at -6.5; South Carolina didn’t cover",
    );
    expect(mark).toHaveTextContent("✗");
  });

  it("says which side the model is on before the game is played", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // The gap between the two spread columns is the whole reason they sit
    // beside each other, and until now it was a subtraction the reader did:
    // the model has Houston laying 3.7 against a board of 2.5.
    const edge = screen.getByTitle(
      "The model gives Houston 1.2 more points than the book does",
    );
    expect(edge).toHaveTextContent("home +1.2");
    expect(edge.closest("tr")?.textContent).toContain("Duke @ Houston");
  });

  it("names the away side when the model won't lay the price", async () => {
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
              status: "STATUS_SCHEDULED",
              home_score: null,
              away_score: null,
              market_spread: -7.5,
              prediction: {
                model: "glicko_tuned",
                run_id: "r1",
                home_win_prob: 0.55,
                predicted_spread: -2,
                in_sample: false,
              },
            },
          ],
        }),
      ),
    );
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // The board asks Duke to lay 7.5 and the model only lays 2, which is 5.5
    // points of value on the visitors.
    const edge = screen.getByTitle(
      "The model gives Houston 5.5 more points than the book does",
    );
    expect(edge).toHaveTextContent("away +5.5");
  });

  it("says nothing where the model and the book agree", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // Tomorrow's game has a model number and no line, and the live one has a
    // line and no model. Neither is a disagreement, and printing a zero on
    // them would read as one.
    expect(await rowFor("Houston @ Kansas")).not.toMatch(/home \+|away \+/);
    expect(await rowFor("Vermont @ Kansas")).not.toMatch(/home \+|away \+/);
  });

  it("leaves a game with no line ungraded", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // Nothing to be right or wrong about. The nfl row has a line but no
    // model, and tonight's games have both and no result -- neither is a
    // verdict, and marking them would put a symbol on most of the page.
    expect(screen.getAllByTitle(/The model liked/)).toHaveLength(2);
  });

  it("explains the marks only when there are marks", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    expect(screen.getByText(/means that side covered/)).toBeInTheDocument();
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

  it("puts both filters in the URL, so a slate can be linked", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    await user.selectOptions(screen.getByLabelText("League"), "nfl");
    await user.selectOptions(screen.getByLabelText("Since"), "7");

    // "Tonight's nfl games" is a thing to send someone, and the URL is the
    // only state a link carries.
    const url = () => screen.getByTestId("location").textContent;
    await waitFor(() => expect(url()).toContain("league=nfl"));
    expect(url()).toContain("back=7");

    // And the default is the absence of the parameter rather than a spelling
    // of it, so an unfiltered page is still `/games`.
    await user.selectOptions(screen.getByLabelText("League"), "");
    await waitFor(() => expect(url()).not.toContain("league"));
  });

  it("reads the window and the league back out of the URL", async () => {
    renderApp(<GamesPage />, { route: "/games?league=nfl&back=1" });

    expect(
      await screen.findByText(/Green Bay Packers @ Chicago Bears/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("League")).toHaveValue("nfl");
    expect(screen.getByLabelText("Since")).toHaveValue("1");
  });

  it("ignores a window nobody offered", async () => {
    renderApp(<GamesPage />, { route: "/games?back=400" });
    await screen.findAllByRole("table");

    // Not clamped to the cap: the backend would answer a clamped one with a
    // week of games under a picker reading something else. A typo gets the
    // default, and the picker says which one it got.
    expect(screen.getByLabelText("Since")).toHaveValue("2");
    expect(await screen.findByTestId("games-meta")).toHaveTextContent(
      "2 days back",
    );
  });

  it("keeps a league the window has no games for, and says why it's empty", async () => {
    const user = userEvent.setup();
    // What a link looks like a few days after it was sent. The filter is
    // still on and the window has moved past it.
    renderApp(<GamesPage />, { route: "/games?league=nhl" });

    // The picker has to keep offering the league it's set to. Built from the
    // loaded games alone, this select would have a value with no option --
    // which renders blank, and hides the reason the page is empty.
    expect(await screen.findByText(/No nhl games/)).toBeInTheDocument();
    expect(screen.getByLabelText("League")).toHaveValue("nhl");
    // An empty window and an emptied one are different pages, and a reader
    // who filtered three steps ago has no other way to tell them apart.
    expect(screen.getByText(/7 games in the other leagues/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Show all leagues/ }));
    expect(
      await screen.findByText(/North Carolina @ Duke/),
    ).toBeInTheDocument();
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

  it("says what became of a game with no result", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // Without this the row is a dash, and a reader waits all evening for a
    // score that was never coming.
    expect(await rowFor("Vermont @ UConn")).toContain("Cancelled");
  });

  it("shows a game under way as under way, not as a score", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // The season file is rewritten once a day, so its partial score is a
    // snapshot from whenever the job ran -- and it renders like a final.
    const row = await rowFor("Vermont @ Kansas");
    expect(row).toContain("In progress");
    expect(row).not.toMatch(/\d+–\d+/);
  });

  it("leaves an ordinary upcoming game a dash", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // "Scheduled" on every row of tonight's slate is noise: the tip-off
    // beside it has already said so.
    const row = await rowFor("Duke @ Houston");
    expect(row).toContain("—");
    expect(row).not.toContain("Scheduled");
  });

  it("still shows the score for a game saved before statuses existed", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // Most of the bucket. Final, but nothing recorded that -- and the score
    // is what the row is for either way.
    expect(await rowFor("Green Bay Packers @ Chicago Bears")).toContain(
      "24–17",
    );
  });

  it("summarizes the window above the tables", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    const meta = await screen.findByTestId("games-meta");
    expect(meta).toHaveTextContent("7 games");
    expect(meta).toHaveTextContent("2 days back");
  });

  it("decodes the shorthand under the tables", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // "home +4" in a column of spreads is not self-evident, and the title on
    // it is no help to anyone who can't hover.
    expect(screen.getByText(/home \+4/)).toBeInTheDocument();
  });

  it("drops that note when no row uses the shorthand", async () => {
    server.use(
      http.get("/api/games", () =>
        HttpResponse.json({
          days_back: 2,
          days_ahead: 1,
          since: "2026-08-20",
          until: "2026-08-23",
          games: [
            {
              league: "nfl",
              game_id: "g",
              day: "2026-08-22",
              start: "2026-08-23T01:00:00Z",
              home: "Chicago Bears",
              away: "Green Bay Packers",
              neutral: false,
              completed: false,
              status: "STATUS_SCHEDULED",
              home_score: null,
              away_score: null,
              market_spread: -3.5,
              prediction: null,
            },
          ],
        }),
      ),
    );
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // A league with no model has no number to disagree with the book, so
    // there is no shorthand on the page to explain.
    expect(screen.queryByText(/home \+4/)).toBeNull();
    expect(screen.getByText(/home team’s side/)).toBeInTheDocument();
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
              status: "STATUS_SCHEDULED",
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
    // go looking for. The one game here is unplayed, so neither mark is on
    // it and neither note belongs under it.
    expect(screen.queryByText(/already trained on/)).toBeNull();
    expect(screen.queryByText(/means that side covered/)).toBeNull();
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
