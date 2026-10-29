import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { glicko as ratingsFixture } from "../../test/handlers";
import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { RatingsPage } from "./RatingsPage";

const RATINGS_ROUTE = (league: string) => ({
  route: `/${league}/ratings`,
  path: "/:league/ratings",
});

const rowsInBody = () =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("RatingsPage", () => {
  it("renders ranked teams from the API", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");
    expect(rowsInBody()).toHaveLength(3);
    expect(rowsInBody()[0]).toHaveTextContent("Duke");
  });

  it("shows which model produced the numbers", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    expect(await screen.findByTestId("run-meta")).toHaveTextContent(
      "glicko_tuned",
    );
  });

  it("shows the RD column for a model that has one", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");
    expect(
      screen.getByRole("columnheader", { name: "RD" }),
    ).toBeInTheDocument();
  });

  it("hides the RD column when the model has no rating deviation", async () => {
    const user = userEvent.setup();
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");

    await user.selectOptions(screen.getByLabelText("Model"), "elo");

    await waitFor(() =>
      expect(screen.queryByRole("columnheader", { name: "RD" })).toBeNull(),
    );
  });

  it("shows the unit columns for a model that rates a team's halves", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
    await screen.findByText("Georgia");

    expect(
      screen.getByRole("columnheader", { name: "Off" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Def" }),
    ).toBeInTheDocument();
    // The best offense in this table isn't the top of it, so a bug that put
    // the team rating in both columns fails here rather than looking right.
    expect(rowsInBody()[0]).toHaveTextContent("1861.0");
    expect(rowsInBody()[1]).toHaveTextContent("1948.2");
  });

  it("hides the unit columns for a model that rates only the result", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");

    expect(screen.queryByRole("columnheader", { name: "Off" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Def" })).toBeNull();
  });

  it("dashes the unit cells for a team the model has no plays for", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
    await screen.findByText("Alabama");

    const alabama = rowsInBody()[2];
    expect(alabama).toHaveTextContent("1751.9");
    // Fourteen dashes: one per unit, success-rate and EPA column.
    // The row keeps its rating and says nothing about halves it has no
    // evidence for.
    expect(within(alabama).getAllByText("—")).toHaveLength(14);
  });

  it("shows each side's success rate where the model keeps one", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
    await screen.findByText("Georgia");

    expect(
      screen.getByRole("columnheader", { name: "Off SR" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Def SR" }),
    ).toBeInTheDocument();
    const georgia = rowsInBody()[0];
    expect(georgia).toHaveTextContent("51.1%");
    expect(georgia).toHaveTextContent("34.7%");
    // The deviation is in the title, in points of success rate.
    expect(within(georgia).getByText("51.1%")).toHaveAttribute(
      "title",
      "± 3.1 pts",
    );
  });

  it("places each stat among the league's teams under the value", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
    await screen.findByText("Georgia");

    // Georgia's offense is ahead of Ohio State's on success rate, and its
    // defense allows less, so both are the top of the two teams rated.
    const georgia = rowsInBody()[0];
    expect(within(georgia).getAllByText("100th")).toHaveLength(12);
    const ohioState = rowsInBody()[1];
    expect(within(ohioState).getAllByText("0th")).toHaveLength(12);
  });

  it("shows EPA per down for each side, in its own units", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
    await screen.findByText("Georgia");

    expect(
      screen.getByRole("columnheader", { name: "Off EPA" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Def EPA" }),
    ).toBeInTheDocument();
    const georgia = rowsInBody()[0];
    expect(within(georgia).getByText("+0.154")).toHaveAttribute(
      "title",
      "± 0.021",
    );
    expect(georgia).toHaveTextContent("−0.158");
  });

  it("shows the pass and run columns without being asked", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
    await screen.findByText("Georgia");

    for (const name of ["Pass SR", "Run SR", "Pass EPA", "Run EPA"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    expect(rowsInBody()[0]).toHaveTextContent("54.1%");
    expect(rowsInBody()[0]).toHaveTextContent("+0.234");
  });

  it("has no EPA or pass / run columns for a model without them", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");

    expect(screen.queryByRole("columnheader", { name: "Pass SR" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Off EPA" })).toBeNull();
  });

  it("shows the players' net, net with absences and pace for basketball", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");

    for (const name of ["Net", "Avail", "Pace"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    const [duke, houston, carolina] = rowsInBody();
    expect(houston).toHaveTextContent("+24.8");
    expect(houston).toHaveTextContent("+23.9");
    // Pace is neither good nor bad, so it gets no percentile.
    expect(
      within(houston).getByText("63.1").parentElement,
    ).not.toHaveTextContent(/\d(st|nd|rd|th)/);
    // Duke's row doesn't say who might be out, and North Carolina has none.
    expect(duke).toHaveTextContent("+27.3");
    expect(within(duke).getAllByText("—")).toHaveLength(1);
    expect(within(carolina).getAllByText("—")).toHaveLength(3);
  });

  it("has no players' columns for a model without them", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
    await screen.findByText("Georgia");

    expect(screen.queryByRole("columnheader", { name: "Net" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Pace" })).toBeNull();
  });

  it("hides the success-rate columns for a model without them", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");

    expect(screen.queryByRole("columnheader", { name: "Off SR" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Def SR" })).toBeNull();
  });

  it("keeps the unit columns while the search box narrows the table", async () => {
    const user = userEvent.setup();
    renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
    await screen.findByText("Georgia");

    // Filtering down to the one team with no units must not take the columns
    // away from under the reader: the question is what the *model* rates.
    await user.type(screen.getByLabelText("Filter teams"), "alab");
    await waitFor(() => expect(rowsInBody()).toHaveLength(1));
    expect(
      screen.getByRole("columnheader", { name: "Off" }),
    ).toBeInTheDocument();
  });

  it("leads with rank, rating and record", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");

    const headings = screen
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    // The sorted column's arrow is part of its text.
    expect(headings.slice(0, 4)).toEqual(["#▲", "Rating", "W–L", "Team"]);
    expect(within(rowsInBody()[0]).getAllByRole("cell")[2]).toHaveTextContent(
      /^\d+–\d+$/,
    );
  });

  describe("sorting", () => {
    // The arrow is hidden from the accessible name, so these stay exact.
    const heading = (name: string) => screen.getByRole("button", { name });
    const columnheader = (name: string) =>
      screen.getByRole("columnheader", { name });

    it("starts in the model's order", async () => {
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Duke");
      expect(columnheader("#")).toHaveAttribute("aria-sort", "ascending");
      expect(columnheader("Rating")).not.toHaveAttribute("aria-sort");
    });

    it("sorts on a clicked column best-first, and flips on a second click", async () => {
      const user = userEvent.setup();
      renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
      await screen.findByText("Georgia");

      // Ohio State has the better offense though Georgia leads the table.
      await user.click(heading("Off"));
      expect(rowsInBody()[0]).toHaveTextContent("Ohio State");
      expect(columnheader("Off")).toHaveAttribute("aria-sort", "descending");
      expect(columnheader("#")).not.toHaveAttribute("aria-sort");
      // Alabama has no plays on file, so it stays at the bottom.
      expect(rowsInBody()[2]).toHaveTextContent("Alabama");

      await user.click(heading("Off"));
      expect(rowsInBody()[0]).toHaveTextContent("Georgia");
      expect(columnheader("Off")).toHaveAttribute("aria-sort", "ascending");
      expect(rowsInBody()[2]).toHaveTextContent("Alabama");
    });

    it("sorts success rate allowed lowest-first", async () => {
      const user = userEvent.setup();
      renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
      await screen.findByText("Georgia");

      await user.click(heading("Def SR"));
      expect(rowsInBody()[0]).toHaveTextContent("Georgia");
      expect(columnheader("Def SR")).toHaveAttribute("aria-sort", "ascending");
    });

    it("keeps the model's rank on each row whatever the order", async () => {
      const user = userEvent.setup();
      renderApp(<RatingsPage />, RATINGS_ROUTE("ncaafb"));
      await screen.findByText("Georgia");

      await user.click(heading("Team"));
      const first = rowsInBody()[0];
      expect(first).toHaveTextContent("Alabama");
      expect(within(first).getAllByRole("cell")[0]).toHaveTextContent("3");
    });

    it("keeps the order across a change of model", async () => {
      const user = userEvent.setup();
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Duke");

      await user.click(heading("Team"));
      await user.selectOptions(screen.getByLabelText("Model"), "elo");

      await waitFor(() =>
        expect(screen.queryByRole("columnheader", { name: "RD" })).toBeNull(),
      );
      expect(columnheader("Team")).toHaveAttribute("aria-sort", "ascending");
    });
  });

  it("filters teams by the search box", async () => {
    const user = userEvent.setup();
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");

    await user.type(screen.getByLabelText("Filter teams"), "hou");

    await waitFor(() => expect(rowsInBody()).toHaveLength(1));
    expect(rowsInBody()[0]).toHaveTextContent("Houston");
  });

  describe("the week's movement", () => {
    /** The row for a team, as the table renders it. */
    const rowFor = (team: string) =>
      rowsInBody().find((row) => row.textContent?.includes(team));

    it("shows what the week did to each team", async () => {
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Duke");

      // Duke gained ground without changing places; Houston lost both.
      expect(rowFor("Duke")).toHaveTextContent("+24.2");
      expect(rowFor("Houston")).toHaveTextContent("-8.5");
    });

    it("points the arrow the way the team went", async () => {
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Houston");

      // Second from first is a place lost, whatever the rank integer did.
      expect(rowFor("Houston")).toHaveTextContent("▼1");
      // A team that held its place gets no arrow: there is nothing to point.
      expect(rowFor("Duke")?.textContent).not.toContain("▲");
      expect(rowFor("Duke")?.textContent).not.toContain("▼");
    });

    it("carries the record the week produced", async () => {
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Duke");
      expect(rowFor("Duke")).toHaveTextContent("2-0");
    });

    it("names the day it is a week since", async () => {
      // "Last week" is a claim the reader can't check. A date is one they can.
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      expect(await screen.findByTestId("run-meta")).toHaveTextContent(
        "week since Jul 31",
      );
    });

    it("decodes the shorthand in a title", async () => {
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Houston");
      expect(
        screen.getByTitle(/Down 8.5 points and down 1 place since Jul 31/),
      ).toBeInTheDocument();
    });

    it("drops the column for a model with no history", async () => {
      // Every model published before the artifact existed. A column of dashes
      // would imply a comparison the data can't make.
      const user = userEvent.setup();
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Duke");

      await user.selectOptions(screen.getByLabelText("Model"), "elo");

      await waitFor(() =>
        expect(screen.queryByRole("columnheader", { name: "Week" })).toBeNull(),
      );
      expect(screen.getByTestId("run-meta")).not.toHaveTextContent(
        "week since",
      );
    });

    it("leaves a team with nothing behind it blank", async () => {
      // Its first game was this week: there is no previous rating to
      // subtract, and a zero would claim there was one.
      server.use(
        http.get("/api/leagues/:league/ratings", () =>
          HttpResponse.json({
            ...ratingsFixture,
            ratings: ratingsFixture.ratings.map((row) =>
              row.team === "Houston" ? { ...row, movement: null } : row,
            ),
          }),
        ),
      );
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Houston");

      const cells = within(rowFor("Houston")!).getAllByRole("cell");
      expect(cells[cells.length - 1]).toHaveTextContent("—");
    });
  });

  it("says so when a league has no published ratings", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("womens"));
    expect(await screen.findByText(/No ratings published/)).toBeInTheDocument();
  });

  describe("fit quality in the header", () => {
    /** Overrides just the metrics on the ratings response. */
    const withMetrics = (extra: Record<string, number | null>) =>
      server.use(
        http.get("/api/leagues/:league/ratings", () =>
          HttpResponse.json({
            ...ratingsFixture,
            metrics: { ...ratingsFixture.metrics, ...extra },
          }),
        ),
      );

    it("shows the margin MAE alongside Brier", async () => {
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      const meta = await screen.findByTestId("run-meta");
      expect(meta).toHaveTextContent("Brier 0.1782");
      expect(meta).toHaveTextContent("margin MAE 9.4");
    });

    it("reports the gap when the model trails the closing line", async () => {
      // Fixture: 9.1 model vs 8.8 market on priced games.
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      expect(await screen.findByTestId("run-meta")).toHaveTextContent(
        "0.3 pts worse than the closing line",
      );
    });

    it("reports the gap the other way when it beats the line", async () => {
      const user = userEvent.setup();
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      await screen.findByText("Duke");

      await user.selectOptions(screen.getByLabelText("Model"), "elo");

      await waitFor(() =>
        expect(screen.getByTestId("run-meta")).toHaveTextContent(
          "0.2 pts better than the closing line",
        ),
      );
    });

    it("says level rather than picking a direction on a tie", async () => {
      withMetrics({ spread_game_margin_mae: 8.82, market_margin_mae: 8.8 });
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
      expect(await screen.findByTestId("run-meta")).toHaveTextContent(
        "level with the closing line",
      );
    });

    it("omits the comparison for a league with no odds coverage", async () => {
      // The womens fixture's real shape: nan mapped to null upstream, because
      // there was nothing to compare against.
      withMetrics({ spread_game_margin_mae: null, market_margin_mae: null });
      renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));

      const meta = await screen.findByTestId("run-meta");
      expect(meta).toHaveTextContent("margin MAE 9.4");
      expect(meta).not.toHaveTextContent("closing line");
    });
  });
});
