import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderApp } from "../../test/render";
import { SettingsPage } from "./SettingsPage";

const SETTINGS_ROUTE = (league: string) => ({
  route: `/${league}/settings`,
  path: "/:league/settings",
});

describe("SettingsPage", () => {
  it("shows a section per model in the league", async () => {
    renderApp(<SettingsPage />, SETTINGS_ROUTE("mens"));
    expect(
      await screen.findByRole("heading", { name: /glicko_tuned/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^elo$/ })).toBeInTheDocument();
  });

  it("marks the league's default model", async () => {
    renderApp(<SettingsPage />, SETTINGS_ROUTE("mens"));
    const heading = await screen.findByRole("heading", {
      name: /glicko_tuned/,
    });
    expect(heading).toHaveTextContent("default");

    const eloHeading = screen.getByRole("heading", { name: /^elo$/ });
    expect(eloHeading).not.toHaveTextContent("default");
  });

  it("names the predictor class and run behind each model", async () => {
    renderApp(<SettingsPage />, SETTINGS_ROUTE("mens"));
    await screen.findByText("glicko_tuned");
    expect(screen.getByText(/GlickoPredictor/)).toHaveTextContent("run r1");
  });

  it("lists each model's params, humanized", async () => {
    renderApp(<SettingsPage />, SETTINGS_ROUTE("mens"));
    await screen.findByText("glicko_tuned");
    const section = screen
      .getByRole("heading", { name: /glicko_tuned/ })
      .closest("section")!;

    expect(within(section).getByText("scoring method")).toBeInTheDocument();

    const row = within(section).getByText("home advantage").closest("tr")!;
    expect(within(row).getByRole("cell")).toHaveTextContent("95");
  });

  it("only lists models for the requested league", async () => {
    renderApp(<SettingsPage />, SETTINGS_ROUTE("womens"));
    await screen.findByText("glicko_tuned");
    expect(screen.queryByText("elo")).not.toBeInTheDocument();
  });

  it("says so when a league has no published models", async () => {
    renderApp(<SettingsPage />, SETTINGS_ROUTE("nfl"));
    expect(await screen.findByText(/No models published/)).toBeInTheDocument();
  });
});
