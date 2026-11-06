import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderApp } from "../../test/render";
import { PlayersPage } from "./PlayersPage";

const ROUTE = (league: string) => ({
  route: `/${league}/players`,
  path: "/:league/players",
});

const names = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);

describe("PlayersPage", () => {
  it("opens on the current season, floor applied, best first", async () => {
    renderApp(<PlayersPage />, ROUTE("mens"));
    await screen.findByText("Pat Star");
    expect(screen.getByLabelText("Season")).toHaveValue("2026");
    expect(names()).toEqual(["Pat Star", "New Guyproj"]);
    expect(screen.getByTestId("players-meta")).toHaveTextContent("2 players");
  });

  it("moves the floor", async () => {
    const user = userEvent.setup();
    renderApp(<PlayersPage />, ROUTE("mens"));
    await screen.findByText("Pat Star");
    const floor = screen.getByLabelText(/Min share/);
    await user.clear(floor);
    await user.type(floor, "50");
    expect(names()).toEqual(["Pat Star"]);
  });

  it("switches seasons", async () => {
    const user = userEvent.setup();
    renderApp(<PlayersPage />, ROUTE("mens"));
    await screen.findByText("Pat Star");
    await user.selectOptions(screen.getByLabelText("Season"), "2025");
    expect(await screen.findByText("Old Hand")).toBeInTheDocument();
    expect(screen.queryByText("New Guy")).toBeNull();
  });

  it("sorts on a heading", async () => {
    const user = userEvent.setup();
    renderApp(<PlayersPage />, ROUTE("mens"));
    await screen.findByText("Pat Star");
    await user.click(screen.getByRole("button", { name: "Total" }));
    expect(names()).toEqual(["New Guyproj", "Pat Star"]);
    expect(screen.getByRole("columnheader", { name: /Total/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("says so for a league with no players", async () => {
    renderApp(<PlayersPage />, ROUTE("nfl"));
    expect(
      await screen.findByText(/No player ratings for nfl/),
    ).toBeInTheDocument();
  });
});
