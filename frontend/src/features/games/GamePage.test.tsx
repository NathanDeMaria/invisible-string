import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { winProbability } from "../../test/handlers";
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
    // and the only way to get the numbers without a pointer. The scoring
    // table is the first of the two under the chart; the bounces are the
    // second.
    const [table] = await screen.findAllByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Q1 1:36");
    expect(rows[0]).toHaveTextContent("7–0");
    expect(rows[0]).toHaveTextContent("31%");
    // And the same snap on the other curve, so the table carries the pair the
    // chart draws rather than half of it.
    expect(rows[0]).toHaveTextContent("31%31%");
  });

  it("lists the plays the game turned on a bounce", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    const tables = await screen.findAllByRole("table");
    const rows = within(tables[1]).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    // Both branches, so the number is checkable rather than asserted: what
    // the model made of the snap that followed, and of the one that would
    // have.
    expect(rows[0]).toHaveTextContent("Fumble lost");
    expect(rows[0]).toHaveTextContent("50%");
    expect(rows[0]).toHaveTextContent("26%");
    // Named rather than signed: a signed number on a two-team page is a
    // convention the reader has to hold.
    expect(rows[0]).toHaveTextContent("0.12 Chicago Bears");
    expect(rows[1]).toHaveTextContent("0.03 Green Bay Packers");
  });

  it("draws a tick per bounce, on a rail under the plot", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    const chart = await screen.findByRole("img", { name: /win probability/ });
    const ticks = chart.querySelectorAll(".wp-tick");
    expect(ticks).toHaveLength(2);
    // Up for a break the home team got, down for one the away team got --
    // the same direction the curve above means.
    const [first, second] = Array.from(ticks);
    expect(Number(first.getAttribute("y2"))).toBeLessThan(
      Number(first.getAttribute("y1")),
    );
    expect(Number(second.getAttribute("y2"))).toBeGreaterThan(
      Number(second.getAttribute("y1")),
    );
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

  it("says how much of the game the home team held, both ways", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    // Both numbers about the same team, because the pair is a comparison:
    // what happened, and what happened on purpose.
    expect(
      await screen.findByText(
        /Chicago Bears held 42% of the game, and 37% of it with the fifty-fifty balls split evenly/,
      ),
    ).toBeInTheDocument();
    // Not a win probability, and the page has to say so: it's an average over
    // the minutes, not a reading the model ever took.
    expect(
      screen.getByText(/share of the game held, not as a win probability/),
    ).toBeInTheDocument();
  });

  it("says what the bounces were worth, and that it isn't a share", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    expect(
      await screen.findByText(
        /worth 0.12 of win probability to Chicago Bears and 0.03 to Green Bay Packers/,
      ),
    ).toBeInTheDocument();
    // The two totals don't sum to anything, and a page that let them read as
    // a split would be claiming something the number doesn't say.
    expect(
      screen.getByText(/total of win probability rather than a share/),
    ).toBeInTheDocument();
  });

  it("says when a game's feed only records half the coin", async () => {
    // Which is most of an NCAAFB week: whether a broken-up pass is written
    // down follows the venue. The fumbles are still split; the interceptions
    // are left alone, and the page says which it did.
    server.use(
      http.get("/api/games/:league/:gameId/win-probability", () =>
        HttpResponse.json({
          ...winProbability,
          records_defended_passes: false,
        }),
      ),
    );
    renderApp(<GamePage />, at("nfl", "g-1"));

    expect(
      await screen.findByText(/only the fumbles are split here/),
    ).toBeInTheDocument();
  });

  it("says so when nothing in a game turned on a bounce", async () => {
    server.use(
      http.get("/api/games/:league/:gameId/win-probability", () =>
        HttpResponse.json({
          ...winProbability,
          luck: { home: 0, away: 0, swings: [] },
          adjusted_control: winProbability.control,
        }),
      ),
    );
    renderApp(<GamePage />, at("nfl", "g-1"));

    expect(
      await screen.findByText(/Nothing in this game turned on a bounce/),
    ).toBeInTheDocument();
  });

  it("says who played better, and that it can disagree with the shares", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    // The fixture is a game the two averages disagree about, which is the
    // case the pair is on the page for: Chicago while it was still a game,
    // Green Bay over the whole thing.
    expect(
      await screen.findByText(
        /While the game was still in doubt, Chicago Bears by 0.20 points a snap; over every snap, Green Bay Packers by 0.80 points a snap/,
      ),
    ).toBeInTheDocument();
    // Neither number is a share, and the page has to say so with two shares
    // sitting a paragraph above it.
    expect(
      screen.getByText(/they don’t add up to anything/),
    ).toBeInTheDocument();
  });

  it("gives each offense both numbers and the snaps behind them", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    const table = (await screen.findByText("While it mattered")).closest(
      "table",
    );
    const bears = within(table!).getByRole("row", { name: /Chicago Bears/ });
    // Weighted, flat, and what the weighted one is actually an average over.
    expect(bears).toHaveTextContent("+0.37");
    expect(bears).toHaveTextContent("-0.39");
    expect(bears).toHaveTextContent("2.9 live");
  });

  it("names the second fit, and says what its size means", async () => {
    renderApp(<GamePage />, at("nfl", "g-1"));

    // Its own provenance, not the curve's: two files that move separately.
    const fit = (await screen.findByText(/expected points fit/)).closest("p");
    expect(fit).toHaveTextContent("2022–2025");
    // The error is large by construction, and saying so is what stops the
    // averages above from being read as a claim about any one snap.
    expect(fit).toHaveTextContent(/misses the next score by 3.8 points/);
    expect(fit).toHaveTextContent(/per-play averages and not per-play claims/);
  });

  it("says nothing about EPA for a game it has none for", async () => {
    // A game with no play-by-play has no snaps to average, and a pair of
    // zeroes would read as two offenses that played exactly to expectation.
    server.use(
      http.get("/api/games/:league/:gameId/win-probability", () =>
        HttpResponse.json({ ...winProbability, epa: null }),
      ),
    );
    renderApp(<GamePage />, at("nfl", "g-1"));

    await screen.findByText(/Win probability/);
    expect(screen.queryByText("EPA per play")).toBeNull();
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
