import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { predictionFor } from "../../test/handlers";
import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { MatchupPage } from "./MatchupPage";
import { favouriteLine } from "./spread";

const MATCHUP_ROUTE = (query = "") => ({
  route: `/mens/matchup${query}`,
  path: "/:league/matchup",
});

/** Replaces the predict handler for one test. */
const respondWith = (body: Record<string, unknown>) =>
  server.use(
    http.get("/api/predict", () =>
      HttpResponse.json({
        ...predictionFor({ home: "Duke", away: "Kansas" }),
        ...body,
      }),
    ),
  );

describe("favouriteLine", () => {
  /**
   * The sign rule in isolation. `predicted_spread` is from the *home* team's
   * side, negative meaning home is favoured -- so the favourite is whoever the
   * sign points at, and the number is always shown negative next to them.
   *
   * Attaching a spread to the wrong team reads perfectly naturally, which is
   * why this is a unit test as well as a rendered one.
   */
  const line = (spread: number | null) =>
    favouriteLine({
      ...predictionFor({ home: "Duke", away: "Kansas" }),
      predicted_spread: spread,
    });

  it("names the home team when the spread is negative", () => {
    expect(line(-6.5)).toBe("Duke -6.5");
  });

  it("names the away team when the spread is positive", () => {
    expect(line(6.5)).toBe("Kansas -6.5");
  });

  it("never shows the favourite receiving points", () => {
    for (const spread of [-14.2, -0.6, 0.6, 14.2]) {
      expect(line(spread)).toMatch(/ -\d/);
    }
  });

  it("says pick'em rather than rendering a signed zero", () => {
    expect(line(0)).toBe("Pick'em");
    expect(line(-0.04)).toBe("Pick'em");
  });

  it("has nothing to say without a calibration", () => {
    expect(line(null)).toBeNull();
  });
});

describe("MatchupPage", () => {
  it("asks for two teams before predicting anything", async () => {
    renderApp(<MatchupPage />, MATCHUP_ROUTE());
    await screen.findByLabelText("Home team");
    expect(screen.queryByTestId("matchup-result")).toBeNull();
  });

  it("only offers teams the release actually rates", async () => {
    renderApp(<MatchupPage />, MATCHUP_ROUTE());
    const select = await screen.findByLabelText("Home team");
    await waitFor(() =>
      expect(
        within(select).getByRole("option", { name: "Duke" }),
      ).toBeInTheDocument(),
    );
    // The pickers can't offer a team /api/predict would 404 on.
    expect(
      within(select).queryByRole("option", { name: "Belmont" }),
    ).toBeNull();
  });

  it("predicts from a shareable URL without any clicking", async () => {
    renderApp(<MatchupPage />, MATCHUP_ROUTE("?home=Duke&away=Houston"));
    const line = await screen.findByTestId("matchup-line");
    expect(line).toHaveTextContent("Duke -");
  });

  it("puts the picks in the URL so the matchup can be linked", async () => {
    const user = userEvent.setup();
    renderApp(<MatchupPage />, MATCHUP_ROUTE());

    // The options arrive with the ratings response, so the select exists
    // before it has anything in it. findAll, because both pickers offer Duke.
    await screen.findAllByRole("option", { name: "Duke" });
    await user.selectOptions(screen.getByLabelText("Home team"), "Duke");
    await user.selectOptions(screen.getByLabelText("Away team"), "Houston");

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "home=Duke&away=Houston",
      ),
    );
    expect(await screen.findByTestId("matchup-result")).toBeInTheDocument();
  });

  it("puts the neutral-site toggle in the URL too", async () => {
    const user = userEvent.setup();
    renderApp(<MatchupPage />, MATCHUP_ROUTE("?home=Duke&away=Houston"));

    await user.click(await screen.findByLabelText("Neutral site"));

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("neutral=1"),
    );
  });

  it("shows both win probabilities", async () => {
    renderApp(<MatchupPage />, MATCHUP_ROUTE("?home=Duke&away=Houston"));
    const result = await screen.findByTestId("matchup-result");
    expect(result).toHaveTextContent("Duke");
    expect(result).toHaveTextContent("Houston");
    expect(result.textContent).toMatch(/\d+\.\d%/);
  });

  it("marks home and away, and drops that at a neutral site", async () => {
    const { unmount } = renderApp(
      <MatchupPage />,
      MATCHUP_ROUTE("?home=Duke&away=Houston"),
    );
    expect(await screen.findByTestId("matchup-result")).toHaveTextContent(
      "(home)",
    );
    unmount();

    renderApp(
      <MatchupPage />,
      MATCHUP_ROUTE("?home=Duke&away=Houston&neutral=1"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("matchup-result")).not.toHaveTextContent(
        "(home)",
      ),
    );
  });

  it("says which release answered", async () => {
    renderApp(<MatchupPage />, MATCHUP_ROUTE("?home=Duke&away=Houston"));
    expect(await screen.findByTestId("matchup-meta")).toHaveTextContent(
      "glicko_tuned",
    );
  });

  it("refuses a team playing itself instead of asking the API", async () => {
    renderApp(<MatchupPage />, MATCHUP_ROUTE("?home=Duke&away=Duke"));
    expect(await screen.findByText(/two different teams/)).toBeInTheDocument();
    expect(screen.queryByTestId("matchup-result")).toBeNull();
  });

  it("says so when a release carries no margin calibration", async () => {
    respondWith({ predicted_spread: null });
    renderApp(<MatchupPage />, MATCHUP_ROUTE("?home=Duke&away=Kansas"));
    expect(await screen.findByTestId("matchup-line")).toHaveTextContent(
      /no margin calibration/i,
    );
  });

  it("surfaces an API error rather than rendering nothing", async () => {
    server.use(
      http.get("/api/predict", () =>
        HttpResponse.json({ detail: "nope" }, { status: 404 }),
      ),
    );
    renderApp(<MatchupPage />, MATCHUP_ROUTE("?home=Duke&away=Kansas"));
    expect(await screen.findByText(/Couldn.t predict/)).toBeInTheDocument();
  });
});
