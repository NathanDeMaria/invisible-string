import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../../App";
import { renderApp } from "../../test/render";
import { GamesPage } from "../games/GamesPage";
import { RatingsPage } from "../ratings/RatingsPage";
import { TeamPage } from "../team/TeamPage";

const at = () => screen.getByTestId("location").textContent ?? "";

const RATINGS = { route: "/mens/ratings", path: "/:league/ratings" };

const bodyRows = () =>
  within(screen.getAllByRole("table")[0]).getAllByRole("row").slice(1);

describe("section keys", () => {
  it("takes a letter to each section", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/mens/ratings" });
    await screen.findByText("Duke");

    await user.keyboard("g");
    await waitFor(() => expect(at()).toBe("/games"));

    await user.keyboard("j");
    await waitFor(() => expect(at()).toBe("/jobs"));

    await user.keyboard("m");
    await waitFor(() => expect(at()).toBe("/mens/matchup"));

    await user.keyboard("r");
    await waitFor(() => expect(at()).toBe("/mens/ratings"));
  });

  it("remembers which league you were in", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/womens/ratings" });
    await screen.findByRole("link", { name: "womens" });

    // Jobs is about no league at all, so the way back has to be remembered
    // rather than read off the URL -- otherwise `r` from here means "mens",
    // which is not the league anyone was looking at.
    await user.keyboard("j");
    await waitFor(() => expect(at()).toBe("/jobs"));

    await user.keyboard("r");
    await waitFor(() => expect(at()).toBe("/womens/ratings"));
  });

  it("takes the league from the game you are looking at", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/games/nfl/g1nfl" });
    await screen.findByRole("heading", {
      level: 3,
      name: /Minnesota Vikings at Detroit Lions/,
    });

    await user.keyboard("r");
    await waitFor(() => expect(at()).toBe("/nfl/ratings"));
  });

  it("switches league by number, keeping the panel", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/mens/matchup" });
    await screen.findByRole("link", { name: "womens" });

    // Third tab, and the matchup comes with it -- the same rule the tabs
    // themselves follow.
    await user.keyboard("3");
    await waitFor(() => expect(at()).toBe("/womens/matchup"));
  });

  it("leaves the digits to the games page, which has its own", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/games" });
    await screen.findByText(/Duke @ Houston/);

    await user.keyboard("1");

    // A league filter, not a league tab: the slate stays put.
    await waitFor(() => expect(at()).toBe("/games?league=mens"));

    await user.keyboard("0");
    await waitFor(() => expect(at()).toBe("/games"));
  });

  it("is quiet while you are typing", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/mens/ratings" });
    await screen.findByText("Duke");

    const filter = screen.getByLabelText("Filter teams");
    await user.click(filter);
    await user.keyboard("georgia");

    expect(filter).toHaveValue("georgia");
    expect(at()).toBe("/mens/ratings");
  });

  it("leaves chords to the browser", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/mens/ratings" });
    await screen.findByText("Duke");

    // Ctrl-G is find-again, not "go to games".
    await user.keyboard("{Control>}g{/Control}");

    expect(at()).toBe("/mens/ratings");
  });
});

describe("the shortcuts sheet", () => {
  it("opens on ? and closes on Escape", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/mens/ratings" });
    await screen.findByText("Duke");

    await user.keyboard("?");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Job health")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens from the header, for anyone who doesn't know the key yet", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/mens/ratings" });

    await user.click(screen.getByRole("button", { name: /shortcuts/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("holds the other keys while it's up", async () => {
    const user = userEvent.setup();
    renderApp(<App />, { route: "/mens/ratings" });
    await screen.findByText("Duke");

    await user.keyboard("?");
    await screen.findByRole("dialog");
    await user.keyboard("g");

    // Navigating out from behind a modal leaves the reader on a page they
    // can't see, with a sheet over it describing the one they left.
    expect(at()).toBe("/mens/ratings");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("walking a table", () => {
  it("goes from the filter into the rows and back", async () => {
    const user = userEvent.setup();
    renderApp(<RatingsPage />, RATINGS);
    await screen.findByText("Duke");

    await user.keyboard("/");
    const filter = screen.getByLabelText("Filter teams");
    expect(filter).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(bodyRows()[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(bodyRows()[1]).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(bodyRows()[0]).toHaveFocus();

    // Up from the top is the way back to typing, so narrowing and scanning
    // are one gesture rather than two.
    await user.keyboard("{ArrowUp}");
    expect(filter).toHaveFocus();
  });

  it("reaches the ends of the list in one press", async () => {
    const user = userEvent.setup();
    renderApp(<RatingsPage />, RATINGS);
    await screen.findByText("Duke");

    bodyRows()[0].focus();
    await user.keyboard("{End}");
    expect(bodyRows()[bodyRows().length - 1]).toHaveFocus();

    await user.keyboard("{Home}");
    expect(bodyRows()[0]).toHaveFocus();
  });

  it("opens the team the row is about", async () => {
    const user = userEvent.setup();
    renderApp(<RatingsPage />, RATINGS);
    await screen.findByText("Duke");

    bodyRows()[0].focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(at()).toBe("/mens/teams/Duke"));
  });

  it("empties the filter on Escape rather than only leaving it", async () => {
    const user = userEvent.setup();
    renderApp(<RatingsPage />, RATINGS);
    await screen.findByText("Duke");

    const filter = screen.getByLabelText("Filter teams");
    await user.click(filter);
    await user.keyboard("duke{Escape}");

    expect(filter).toHaveValue("");
    expect(filter).toHaveFocus();
  });

  it("leaves one tab stop per row, not two", async () => {
    renderApp(<RatingsPage />, RATINGS);
    await screen.findByText("Duke");

    // The row is the stop; the link inside it is out of the order. Two stops
    // a row would double the length of a 360-team leaderboard to tab past.
    expect(bodyRows()[0]).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("link", { name: "Duke" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("walks a team's own list of games the same way", async () => {
    const user = userEvent.setup();
    renderApp(<TeamPage />, {
      route: "/mens/teams/Duke",
      path: "/:league/teams/:team",
    });
    const table = await screen.findByRole("table", { name: /Newest first/ });
    const rows = within(table).getAllByRole("row").slice(1);

    rows[2].focus();
    await user.keyboard("{Enter}");

    // Carrying the season, like the link in the cell: without it the games
    // API can only answer for the fortnight around today.
    await waitFor(() => expect(at()).toBe("/games/mens/401710101?season=2026"));
  });

  it("walks a slate of games the same way", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findByText(/Duke @ Houston/);

    bodyRows()[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(bodyRows()[1]).toHaveFocus();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(at()).toMatch(/^\/games\/[^/]+\/.+/));
  });
});

describe("the games page's own keys", () => {
  it("steps a day with the arrows and comes back with t", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
        "Yesterday",
      ),
    );

    await user.keyboard("t");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
        "Today",
      ),
    );
  });

  it("still steps the day from inside the table", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    // Up and down belong to the rows there; left and right never did.
    bodyRows()[0].focus();
    await user.keyboard("{ArrowLeft}");

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
        "Yesterday",
      ),
    );
  });

  it("leaves the day field's own arrows alone", async () => {
    const user = userEvent.setup();
    renderApp(<GamesPage />, { route: "/games" });
    await screen.findAllByRole("table");

    const field = screen.getByLabelText("Day");
    await user.click(field);
    await user.keyboard("{ArrowLeft}");

    // Inside a date input the arrows move between its parts, which is the
    // one place stepping the whole page would be wrong.
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Today",
    );
  });
});
