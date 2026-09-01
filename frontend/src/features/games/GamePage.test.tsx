import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { GamePage } from "./GamePage";

/**
 * The fixture games this page is reached with. `g-1` is the finished NFL game
 * with play-by-play behind it; `g0` is a basketball game tonight, whose league
 * has no win probability fit at all.
 */
const at = (league: string, id: string) => ({
  route: `/games/${league}/${id}`,
  path: "/games/:league/:gameId",
});

describe("GamePage", () => {
  it("names the game and how it finished", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    expect(
      await screen.findByRole("heading", {
        name: /Green Bay Packers at Chicago Bears/,
      }),
    ).toBeInTheDocument();
    // The result, away-first like the matchup above it. Scoped to the line
    // that carries it: the same score is the last row of the table below.
    const result = screen.getByText(/Green Bay Packers won/).closest("p");
    expect(result).toHaveTextContent("24–17");
  });

  it("lists what the table had no room for", async () => {
    renderApp(<GamePage />, at("mens", "g0"));

    // The two ratings behind the win probability, which release said it, and
    // where endgame filed the game -- none of which fits in four columns.
    const ratings = (await screen.findByText("Ratings")).closest("div");
    expect(ratings).toHaveTextContent("1600 – 1500");
    expect(ratings).toHaveTextContent(/on glicko_tuned’s own scale/);

    const release = screen.getByText("Release").closest("div");
    expect(release).toHaveTextContent(/run r1/);

    expect(screen.getByText("Season").closest("div")).toHaveTextContent(
      "2026, week 3",
    );
  });

  it("says the model disagrees with the book, and which way", async () => {
    renderApp(<GamePage />, at("mens", "g0"));

    const disagreement = (await screen.findByText("Disagreement")).closest(
      "div",
    );
    // The book has Houston at -2.5 and the model at -3.7, so the model gives
    // the home side 1.2 more points than the book does.
    expect(disagreement).toHaveTextContent("Houston +1.2");
  });

  it("says when there is no model for the league", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    expect(
      await screen.findByText(/no published release for nfl/),
    ).toBeInTheDocument();
  });

  it("draws the curve for a football game with plays", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    const chart = await screen.findByRole("img", {
      name: /win probability across 9 snaps/,
    });
    expect(within(chart).getByText("even")).toBeInTheDocument();

    // One series, so no legend -- but the reader still has to be told which
    // end of the axis is which team, and a caption says it where a gutter
    // would have clipped it.
    const key = chart.closest("figure")?.querySelector(".wp-key");
    expect(key).toHaveTextContent(
      "Up is Chicago Bears, down is Green Bay Packers.",
    );
  });

  it("puts the game's numbers in a table as well as a picture", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    // One row per change of score, which is the part of a game worth reading
    // and the only way to get the numbers without a pointer.
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Q1 1:36");
    expect(rows[0]).toHaveTextContent("7–0");
    expect(rows[0]).toHaveTextContent("31%");
  });

  it("reads out the snap under the pointer", async () => {
    const user = userEvent.setup();
    renderApp(<GamePage />, at("nfl", "g-1"));

    const chart = await screen.findByRole("img", { name: /win probability/ });
    expect(screen.getByRole("status")).toHaveTextContent(/Hover the chart/);

    // jsdom gives every element a zero-size bounding rect, so the pointer's
    // place across the plot can't be computed from one -- stub it with the
    // viewBox's own width and the mapping is the real one.
    chart.getBoundingClientRect = () =>
      ({ left: 0, width: 640, top: 0, height: 220 }) as DOMRect;
    await user.pointer({
      target: chart,
      coords: { clientX: 320, clientY: 100 },
    });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/Q[1-4]/),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Chicago Bears \d+%/);
  });

  it("says which fit drew it, and what it was fit on", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    expect(await screen.findByText(/2023–2025/)).toBeInTheDocument();
    expect(screen.getByText(/Brier 0.159/)).toBeInTheDocument();
    // Which team id it took for home, since nothing in the play data says --
    // it is inferred from the scoring drives, and the page shows its work.
    expect(screen.getByText(/3 for Chicago Bears/)).toBeInTheDocument();
  });

  it("says how much of the game each side held", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    expect(
      await screen.findByText(/Green Bay Packers held 58% of the game/),
    ).toBeInTheDocument();
    // Not a win probability, and the page has to say so: it's an average over
    // the minutes, not a reading the model ever took.
    expect(
      screen.getByText(/share of the game held, not as a win probability/),
    ).toBeInTheDocument();
  });

  it("asks for no curve at all for a league with no fit", async () => {
    let asked = 0;
    server.use(
      http.get("/api/games/:league/:gameId/win-probability", () => {
        asked += 1;
        return HttpResponse.json({ detail: "no model" }, { status: 404 });
      }),
    );
    renderApp(<GamePage />, at("mens", "g0"));

    await screen.findByText("Ratings");
    expect(screen.queryByText("Win probability")).toBeNull();
    expect(asked).toBe(0);
  });

  it("says a football game with no play-by-play has none", async () => {
    // The fixture's other NFL row would do, but the finished one is the only
    // one with plays -- so stand a scheduled game in for it.
    server.use(
      http.get("/api/games/nfl/g-1", () =>
        HttpResponse.json({
          league: "nfl",
          game_id: "g-1",
          start: new Date().toISOString(),
          day: "2026-09-06",
          home: "Chicago Bears",
          away: "Green Bay Packers",
          neutral: false,
          completed: false,
          status: "STATUS_SCHEDULED",
          home_score: null,
          away_score: null,
          market_spread: null,
          prediction: null,
          season: 2026,
          week: 3,
          has_win_probability: true,
        }),
      ),
      http.get("/api/games/nfl/g-1/win-probability", () =>
        HttpResponse.json({
          league: "nfl",
          game_id: "g-1",
          home: "Chicago Bears",
          away: "Green Bay Packers",
          home_team_id: null,
          away_team_id: null,
          fit: {
            league: "nfl",
            run_id: "r",
            seasons: [2025],
            n_games: 1,
            brier_score: 0.1,
            log_loss: 0.4,
          },
          control: null,
          points: [],
          trained_on_this_season: false,
        }),
      ),
    );
    renderApp(<GamePage />, at("nfl", "g-1"));

    // A 200 with nothing to draw, not an error: most of a college week looks
    // like this, and so does every game before kickoff.
    expect(
      await screen.findByText(/No play-by-play for this game yet/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says a link that outlived the window did, rather than looking broken", async () => {
    renderApp(<GamePage />, at("nfl", "gone"));

    expect(await screen.findByText(/No such game/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Back to the games/ }),
    ).toHaveAttribute("href", "/games");
  });

  it("keeps a way back to the day the game was on", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    const back = await screen.findByRole("link", { name: "nfl" });
    expect(back.getAttribute("href")).toMatch(/^\/games\?day=.+&league=nfl$/);
  });
});
