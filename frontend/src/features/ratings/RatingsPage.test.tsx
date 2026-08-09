import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderApp } from "../../test/render";
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
});
