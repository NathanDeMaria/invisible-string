import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { useGetGamesQuery, type GameRow } from "../../services/api";
import { atsCall, modelEdge } from "./ats";
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
 * Both filters live in the query string, for the reason the matchup page's
 * pickers do (§13.4): "tonight's nfl slate" is a thing to send someone, and
 * the URL is the only state a link can carry. Not redux, which was the other
 * candidate and the wrong one -- a filter that outlived the page would mean
 * coming back to a scoreboard quietly hiding most of the games, whereas one
 * that lives in the URL is visible in the URL.
 */
export function GamesPage() {
  const [params, setParams] = useSearchParams();
  const back = windowOf(params.get("back"));
  const league = params.get("league") ?? ALL;
  const games = useGetGamesQuery({ back, ahead: AHEAD });

  // Replace rather than push, like the matchup page: narrowing a filter is
  // adjusting the view you're on, not moving to another one, and a history
  // entry per keystroke of the picker makes Back mean nothing.
  const update = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === null) merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged, { replace: true });
  };

  const all = useMemo(() => games.data?.games ?? [], [games.data]);
  // The leagues in the window, plus whichever one is selected even when the
  // window holds none of its games. Dropping it would leave the select with a
  // value it has no option for -- which renders blank, and hides the reason
  // the page below it is empty.
  const leagues = useMemo(
    () =>
      [
        ...new Set([
          ...all.map((game) => game.league),
          ...(league ? [league] : []),
        ]),
      ].sort(),
    [all, league],
  );
  const shown = useMemo(
    () => (league ? all.filter((game) => game.league === league) : all),
    [all, league],
  );

  const hindsight = shown.some((game) => game.prediction?.in_sample);
  const priced = shown.some((game) => modelEdge(game) !== null);
  const graded = shown.some((game) => atsCall(game) !== null);
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
            onChange={(e) => update({ back: e.target.value })}
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
            onChange={(e) => update({ league: e.target.value || null })}
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
        // Two different empty pages, and saying so is the whole point: a
        // window with games in it that the league filter has hidden is not an
        // evening with nothing on, and a reader who narrowed the window three
        // steps ago has no other way to tell them apart.
        <p className="empty">
          {league && all.length > 0 ? (
            <>
              No {league} games in this window &mdash;{" "}
              {count(all.length, "game")} in the other leagues.{" "}
              <button
                type="button"
                className="as-link"
                onClick={() => update({ league: null })}
              >
                Show all leagues
              </button>
            </>
          ) : (
            "No games in this window."
          )}
        </p>
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
            {/* Said only when some row has a gap to explain. The rule itself
                is worth spelling out: the model never names a side, so which
                one it picked is something the page inferred from the two
                numbers rather than something the model said. */}
            {priced && (
              <>
                {" "}
                Under the book&rsquo;s number is how far the model&rsquo;s is
                from it, and which side that favours &mdash; &ldquo;home
                +4&rdquo; is the model giving the home team four points more
                than the book does. That side is the model&rsquo;s pick, in the
                only sense it has one: it names a number, not a team.
              </>
            )}
            {/* Only once a game on the page has actually been graded -- a
                footnote about a mark that isn't there is one more thing to go
                looking for, and the same is true of the dagger below it. */}
            {graded && (
              <>
                {" "}
                Once a game is final that pick has an answer, and the mark
                beside the model&rsquo;s number is it: &#10003; means that side
                covered, &#10007; that it didn&rsquo;t, and = that the game
                landed exactly on the number.
              </>
            )}
            {hindsight && (
              <>
                {" "}
                &dagger; marks a game whose result that release has already
                trained on, which makes the number &mdash; and any mark beside
                it &mdash; hindsight rather than a forecast.
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

/**
 * The window a `?back=` names, or the default.
 *
 * Anything that isn't one of the offered windows falls back rather than being
 * clamped or passed through: a hand-edited `?back=400` is a typo, and the
 * backend would answer a clamped one with a week of games under a picker
 * reading something else.
 */
function windowOf(raw: string | null): number {
  const value = Number(raw);
  return WINDOWS.includes(value) ? value : DEFAULT_BACK;
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
