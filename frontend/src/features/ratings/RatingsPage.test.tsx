import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { glicko as ratingsFixture } from "../../test/handlers";
import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { RatingsPage } from "./RatingsPage";

const RATINGS_ROUTE = (league: string) => ({
  route: `/ratings/${league}`,
  path: "/ratings/:league",
});

const rowsInBody = () =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("RatingsPage", () => {
  it("renders ranked teams from the API", async () => {
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");
    expect(rowsInBody()).toHaveLength(2);
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

  it("filters teams by the search box", async () => {
    const user = userEvent.setup();
    renderApp(<RatingsPage />, RATINGS_ROUTE("mens"));
    await screen.findByText("Duke");

    await user.type(screen.getByLabelText("Filter teams"), "hou");

    await waitFor(() => expect(rowsInBody()).toHaveLength(1));
    expect(rowsInBody()[0]).toHaveTextContent("Houston");
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
