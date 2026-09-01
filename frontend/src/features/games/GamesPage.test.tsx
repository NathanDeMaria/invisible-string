import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { isoDay } from "../../test/handlers";
import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { GamesPage } from "./GamesPage";

/**
 * The page shows one day, so almost every assertion is about a *particular*
 * day -- the fixture spreads its games from two days back to tomorrow, and
 * relative to now, since the page groups against a today it reads off the
 * clock.
 */
const on = (offset: number) => ({ route: `/games?day=${isoDay(offset)}` });

const heading = async () => {
  await screen.findByRole("heading", { level: 3 });
  return screen.getByRole("heading", { level: 3 }).textContent ?? "";
};

const rowFor = async (team: string) => {
  const cell = await screen.findByText(new RegExp(team));
  const row = cell.closest("tr");
  return row?.textContent ?? "";
};

const url = () => screen.getByTestId("location").textContent ?? "";

describe("GamesPage", () => {
  it("opens on today", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // The question a scoreboard answers is "what's on tonight", and the answer
    // used to be four days long with tonight's slate at the top of it.
    expect(await heading()).toBe("Today");
    expect(await screen.findByText(/Duke @ Houston/)).toBeInTheDocument();
    // Yesterday's games are somewhere to go, not something to scroll past.
    expect(screen.queryByText(/Green Bay Packers @ Chicago Bears/)).toBeNull();
  });

  it("steps back and forward a day at a time", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    await user.click(screen.getByLabelText("Previous day"));
    expect(await heading()).toBe("Yesterday");
    expect(
      await screen.findByText(/Green Bay Packers @ Chicago Bears/),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText("Next day"));
    expect(await heading()).toBe("Today");

    await user.click(screen.getByLabelText("Next day"));
    expect(await heading()).toBe("Tomorrow");
  });

  it("goes straight to a day from the calendar", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // Seven arrow presses is not a way to get to last Tuesday.
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: isoDay(-2) },
    });

    expect(
      await screen.findByText(/North Carolina @ Duke/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Day")).toHaveValue(isoDay(-2));
  });

  it("offers the calendar only the days the API answers for", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    // A cost cap rather than a retention one (§13.2), but the control should
    // grey out what the endpoint would refuse rather than let the page find
    // out afterwards.
    const field = await screen.findByLabelText("Day");
    expect(field).toHaveAttribute("min", isoDay(-7));
    expect(field).toHaveAttribute("max", isoDay(7));
  });

  it("spends the arrows at the horizon rather than hiding them", async () => {
    const { unmount } = renderApp(<GamesPage />, on(-7));
    await screen.findByRole("heading", { level: 3 });

    expect(screen.getByLabelText("Previous day")).toBeDisabled();
    expect(screen.getByLabelText("Next day")).toBeEnabled();
    unmount();

    renderApp(<GamesPage />, on(7));
    await screen.findByRole("heading", { level: 3 });
    expect(screen.getByLabelText("Next day")).toBeDisabled();
    expect(screen.getByLabelText("Previous day")).toBeEnabled();
  });

  it("keeps a way back to today, spent while you're on it", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, on(-2));
    await screen.findByRole("heading", { level: 3 });

    const today = screen.getByRole("button", { name: "Today" });
    expect(today).toBeEnabled();
    await user.click(today);

    expect(await heading()).toBe("Today");
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
  });

  it("puts the day and the league in the URL, so a slate can be linked", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    await user.click(screen.getByLabelText("Previous day"));
    await waitFor(() => expect(url()).toContain(`day=${isoDay(-1)}`));

    // The league picker offers the leagues playing that day, so it has to
    // have arrived before there's an "nfl" to choose.
    await screen.findByText(/Green Bay Packers @ Chicago Bears/);
    await user.selectOptions(screen.getByLabelText("League"), "nfl");
    await waitFor(() => expect(url()).toContain("league=nfl"));

    // The default is the absence of the parameter rather than a spelling of
    // it, so an unfiltered page today is still `/games`.
    await user.click(screen.getByLabelText("Next day"));
    await waitFor(() => expect(url()).not.toContain("day="));
  });

  it("ignores a day that isn't one", async () => {
    // The shape check alone would pass 2026-02-31, which Date rolls forward
    // to March rather than refusing.
    renderApp(<GamesPage />, { route: "/games?day=2026-02-31" });
    expect(await heading()).toBe("Today");
  });

  it("ignores a day past the horizon", async () => {
    // A link that outlived the week the API serves. Today is a better answer
    // to it than an empty page that looks like a broken one.
    renderApp(<GamesPage />, on(-30));
    expect(await heading()).toBe("Today");
    expect(screen.getByLabelText("Day")).toHaveValue(isoDay(0));
  });

  it("says a day with nothing on it is empty", async () => {
    server.use(
      http.get("/api/games", () =>
        HttpResponse.json({
          days_back: 0,
          days_ahead: 0,
          since: isoDay(0),
          until: isoDay(0),
          games: [],
        }),
      ),
    );
    renderApp(<GamesPage />, { route: "/games" });

    expect(await screen.findByText(/No games on this day/)).toBeInTheDocument();
    // And the arrows still work, because an empty Tuesday in July is a fact
    // about the schedule rather than a failure of the page.
    expect(screen.getByLabelText("Previous day")).toBeEnabled();
  });

  it("shows the model, the line and the result in one row", async () => {
    renderApp(<GamesPage />, on(-2));

    const row = await rowFor("North Carolina @ Duke");
    expect(row).toContain("-5.3"); // the model, from the home side
    expect(row).toContain("-4.5"); // the book, same convention
    expect(row).toContain("71–78"); // away first, like the matchup
    expect(row).toContain("Duke"); // who won
  });

  it("marks a prediction the model has already trained on", async () => {
    renderApp(<GamesPage />, on(-2));
    await screen.findAllByRole("table");

    // Releases are rebuilt nightly, so last night's result is usually already
    // in the ratings that "predicted" it. That's hindsight, not a forecast.
    const marker = screen.getByTitle(/already trained on this result/);
    expect(marker.closest("tr")?.textContent).toContain(
      "North Carolina @ Duke",
    );
  });

  it("marks a finished game the model got right against the line", async () => {
    renderApp(<GamesPage />, on(-2));
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
    renderApp(<GamesPage />, on(-1));
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
    // beside each other, and it used to be a subtraction the reader did: the
    // model has Houston laying 3.7 against a board of 2.5.
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
          days_back: 0,
          days_ahead: 0,
          since: isoDay(0),
          until: isoDay(0),
          games: [
            {
              league: "mens",
              game_id: "g",
              day: isoDay(0),
              start: new Date().toISOString(),
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

  it("says nothing where the model and the book don't disagree", async () => {
    renderApp(<GamesPage />, on(1));
    await screen.findAllByRole("table");

    // Tomorrow's game has a model number and no line. That isn't a
    // disagreement, and printing a zero on it would read as one.
    expect(await rowFor("Houston @ Kansas")).not.toMatch(/home \+|away \+/);
  });

  it("leaves a game with no line ungraded", async () => {
    renderApp(<GamesPage />, on(-1));
    await screen.findAllByRole("table");

    // Two finished games on this day, and only one of them is a verdict: the
    // nfl row has a line but no model to disagree with it.
    expect(screen.getAllByTitle(/The model liked/)).toHaveLength(1);
  });

  it("keeps the games of a league with no model", async () => {
    renderApp(<GamesPage />, on(-1));

    // No release published for the nfl, so no prediction -- but the score and
    // the line are still worth the row.
    const row = await rowFor("Green Bay Packers @ Chicago Bears");
    expect(row).toContain("17");
    expect(row).toContain("+6.5");
  });

  it("says nothing rather than zero where a number is missing", async () => {
    renderApp(<GamesPage />, on(1));

    // Tomorrow's game has no line on the board and no score. A 0 in either
    // column would read as a pick'em and a scoreless final.
    const row = await rowFor("Houston @ Kansas");
    expect(row).not.toMatch(/\b0\b/);
    expect(row).toContain("—");
  });

  it("filters by league without refetching", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, on(-1));
    await screen.findAllByRole("table");

    await user.selectOptions(screen.getByLabelText("League"), "nfl");

    await waitFor(() =>
      expect(screen.queryByText(/UConn @ South Carolina/)).toBeNull(),
    );
    // One day covers every league, so this is a filter over what's already
    // loaded.
    expect(
      screen.getByText(/Green Bay Packers @ Chicago Bears/),
    ).toBeInTheDocument();
  });

  it("keeps a league the day has no games for, and says why it's empty", async () => {
    const user = userEvent.setup();
    // What a filtered link looks like on a day that league didn't play.
    renderApp(<GamesPage />, { route: "/games?league=nhl" });

    // The picker has to keep offering the league it's set to. Built from the
    // loaded games alone, this select would have a value with no option --
    // which renders blank, and hides the reason the page is empty.
    expect(await screen.findByText(/No nhl games/)).toBeInTheDocument();
    expect(screen.getByLabelText("League")).toHaveValue("nhl");
    // An empty day and an emptied one are different pages, and a reader who
    // set that filter on another day has no other way to tell them apart.
    expect(screen.getByText(/2 games in the other leagues/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Show all leagues/ }));
    expect(await screen.findByText(/Duke @ Houston/)).toBeInTheDocument();
  });

  it("says what became of a game with no result", async () => {
    renderApp(<GamesPage />, on(-2));

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
    renderApp(<GamesPage />, on(-1));

    // Most of the bucket. Final, but nothing recorded that -- and the score
    // is what the row is for either way.
    expect(await rowFor("Green Bay Packers @ Chicago Bears")).toContain(
      "24–17",
    );
  });

  it("counts the day's games above the table", async () => {
    renderApp(<GamesPage />, { route: "/games" });

    const meta = await screen.findByTestId("games-meta");
    expect(meta).toHaveTextContent("2 games");
  });

  it("explains the sign convention and the dagger", async () => {
    renderApp(<GamesPage />, on(-2));
    await screen.findAllByRole("table");

    // Two spread columns in the market's convention are unreadable without
    // the sentence that says which side they're quoted from.
    expect(screen.getByText(/home team’s side/)).toBeInTheDocument();
    expect(screen.getByText(/already trained on/)).toBeInTheDocument();
  });

  it("decodes the shorthand under the table", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // "home +4" in a column of spreads is not self-evident, and the title on
    // it is no help to anyone who can't hover.
    expect(screen.getByText(/home \+4/)).toBeInTheDocument();
  });

  it("drops the notes for marks that aren't on the day", async () => {
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // Nothing today is finished, so neither the grade nor the dagger is on
    // the page -- and a footnote about a symbol that isn't there is one more
    // thing to go looking for.
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
