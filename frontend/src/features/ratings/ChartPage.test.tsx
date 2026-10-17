import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderApp } from "../../test/render";
import { ChartPage } from "./ChartPage";

const CHART = (league: string) => ({
  route: `/${league}/chart`,
  path: "/:league/chart",
});

describe("ChartPage", () => {
  it("plots offense against defense for a units model", async () => {
    renderApp(<ChartPage />, CHART("ncaafb"));
    const chart = await screen.findByRole("img");

    expect(screen.getByLabelText("X axis")).toHaveValue("offense");
    expect(screen.getByLabelText("Y axis")).toHaveValue("defense");
    expect(within(chart).getByText("Georgia")).toBeInTheDocument();
    // Alabama has no units, so it has no place on the plot.
    expect(within(chart).queryByText("Alabama")).toBeNull();
  });

  it("opens on rating against record for a model with no units", async () => {
    renderApp(<ChartPage />, CHART("mens"));
    await screen.findByRole("img");

    expect(screen.getByLabelText("X axis")).toHaveValue("record");
    expect(screen.getByLabelText("Y axis")).toHaveValue("rating");
    expect(
      within(screen.getByLabelText("X axis")).queryByText("Offense"),
    ).toBeNull();
  });

  it("lets either axis be any published column", async () => {
    const user = userEvent.setup();
    renderApp(<ChartPage />, CHART("ncaafb"));
    await screen.findByRole("img");

    await user.selectOptions(screen.getByLabelText("Y axis"), "defenseSuccess");

    expect(screen.getByRole("img")).toHaveAccessibleName(
      /Def SR allowed against Offense/,
    );
    expect(screen.getByText(/lower is better/)).toBeInTheDocument();
  });

  it("names the teams the filter matches and keeps the rest", async () => {
    const user = userEvent.setup();
    renderApp(<ChartPage />, CHART("ncaafb"));
    const chart = await screen.findByRole("img");
    const dots = chart.querySelectorAll("circle").length;

    await user.type(screen.getByLabelText("Filter teams"), "geo");

    await waitFor(() =>
      expect(chart.querySelectorAll(".scatter-label")).toHaveLength(1),
    );
    expect(chart.querySelectorAll("circle")).toHaveLength(dots);
  });
});
