import { useMemo, useState } from "react";

import { useGetGamesQuery, type GameRow } from "../../services/api";
import { GameTable } from "./GameTable";
import { count } from "../jobs/format";
import { dayLabel, dayRank, todayOf, zoneLabel } from "./format";

/**
 * How far back the page looks. Forward is fixed at tomorrow: two days of
 * scores and the next slate is the question this page answers, and a second
 * picker for the other direction would be chrome on a page whose point is a
 * quick scan.
 */
const WINDOWS = [1, 2, 3, 7];
const DEFAULT_BACK = 2;
const AHEAD = 1;

const ALL = "";

/**
 * What's on, and what happened.
 *
 * A top-level route rather than a league panel, for the reason `/jobs` is one
 * (DESIGN.md §12.5): the league tabs nest *panels under a league*, and this
 * page is every league at once. The league picker here filters what's already
 * loaded rather than refetching -- one window covers them all, so switching is
 * instant and hits nothing.
 *
 * Local state rather than a slice: nothing outside this page reads the window,
 * and a filter that outlived the page would mean coming back to a scoreboard
 * quietly hiding most of the games.
 */
export function GamesPage() {
  const [back, setBack] = useState(DEFAULT_BACK);
  const [league, setLeague] = useState(ALL);
  const games = useGetGamesQuery({ back, ahead: AHEAD });

  const all = useMemo(() => games.data?.games ?? [], [games.data]);
  const leagues = useMemo(
    () => [...new Set(all.map((game) => game.league))].sort(),
    [all],
  );
  const shown = useMemo(
    () => (league ? all.filter((game) => game.league === league) : all),
    [all, league],
  );

  const hindsight = shown.some((game) => game.prediction?.in_sample);
  const today = games.data ? todayOf(games.data) : undefined;
  const days = useMemo(() => byDay(shown, today), [shown, today]);

  return (
    <section className="games-page">
      <h2>Games</h2>

      <div className="controls">
        <label>
          Since
          <select
            aria-label="Since"
            value={back}
            onChange={(e) => setBack(Number(e.target.value))}
          >
            {WINDOWS.map((option) => (
              <option key={option} value={option}>
                {count(option, "day")} ago
              </option>
            ))}
          </select>
        </label>
        <label>
          League
          <select
            aria-label="League"
            value={league}
            onChange={(e) => setLeague(e.target.value)}
          >
            <option value={ALL}>All leagues</option>
            {leagues.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {games.isError ? (
        // Any failed request, not only the 502 the API raises for an
        // unreadable bucket -- so this says what happened rather than
        // guessing why, which sent the first debugging session after the
        // wrong upstream.
        <p className="error">
          Games are unavailable &mdash; the API didn&rsquo;t answer.
        </p>
      ) : games.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : days.length === 0 ? (
        <p className="empty">No games in this window.</p>
      ) : (
        <>
          <p className="meta" data-testid="games-meta">
            {count(shown.length, "game")} &middot; {count(back, "day")} back
            through tomorrow &middot; times {zoneLabel()}
          </p>
          {days.map(([day, dayGames]) => (
            <section key={day}>
              <h3>{today ? dayLabel(day, today) : day}</h3>
              <GameTable games={dayGames} />
            </section>
          ))}
          <p className="meta">
            Spreads are quoted from the home team&rsquo;s side, so -6.5 means
            the home side lays six and a half. The model column is each
            league&rsquo;s lowest-Brier release.
            {/* Only said when there's a dagger to explain: a footnote about a
                symbol that isn't on the page is one more thing to look for. */}
            {hindsight && (
              <>
                {" "}
                &dagger; marks a game whose result that release has already
                trained on, which makes the number hindsight rather than a
                forecast.
              </>
            )}{" "}
            Scores arrive with the nightly scrape, so a game that has just
            finished can still read as scheduled, and one being played now shows
            no score rather than a stale one. Games with nothing to report yet
            keep a dash; anything else &mdash; postponed, called off, under way
            &mdash; says so in the result column.
          </p>
        </>
      )}
    </section>
  );
}

/** Games grouped into days, in the order §13 puts them on the page. */
function byDay(games: GameRow[], today?: string): [string, GameRow[]][] {
  const grouped = new Map<string, GameRow[]>();
  for (const game of games) {
    const day = grouped.get(game.day);
    if (day) day.push(game);
    else grouped.set(game.day, [game]);
  }
  const days = [...grouped.entries()];
  if (!today) return days;
  return days.sort(([a], [b]) => dayRank(a, today) - dayRank(b, today));
}
