import { useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { useGetGamesQuery, type GameRow } from "../../services/api";
import { atsCall, modelEdge } from "./ats";
import { GameTable } from "./GameTable";
import { byLeagueThenRating } from "./order";
import { count } from "../jobs/format";
import {
  dayLabel,
  daysBetween,
  parseDay,
  shiftDay,
  todayCentral,
  zoneLabel,
} from "./format";

/**
 * How far either side of today the API will answer for -- the backend's
 * `MAX_DAYS_BACK` and `MAX_DAYS_AHEAD` (DESIGN.md §13.2), which are a cost cap
 * rather than a retention one. The picker is bounded by them rather than left
 * to offer days the endpoint would refuse.
 */
const MAX_BACK = 7;
const MAX_AHEAD = 7;

/** One day's games, and which day they are -- what the page renders from. */
interface Day {
  day: string;
  games: GameRow[];
}

const ALL = "";

/**
 * What's on, and what happened.
 *
 * A top-level route rather than a league panel, for the reason `/jobs` is one
 * (DESIGN.md §12.5): the league tabs nest *panels under a league*, and this
 * page is every league at once. The league picker here filters what's already
 * loaded rather than refetching -- one day covers them all, so switching is
 * instant and hits nothing.
 *
 * **One day at a time** (§13.4). A scoreboard's question is "what's on
 * tonight", and the answer to it was previously four days long, with tonight's
 * slate as the first of four tables to scroll past. So the page opens on
 * today, and the days either side of it are somewhere to *go* -- an arrow at a
 * time, or straight to a date -- rather than something to read through.
 *
 * Both the day and the league live in the query string, for the reason the
 * matchup page's pickers do: a slate is a thing to send someone, and the URL
 * is the only state a link carries.
 */
export function GamesPage() {
  const [params, setParams] = useSearchParams();
  const today = todayCentral();
  const day = dayIn(params.get("day"), today);
  const offset = daysBetween(today, day);
  const league = params.get("league") ?? ALL;

  // One day, asked for as the offset the endpoint takes -- it has no `day=`,
  // and it counts from its own today. Today itself is `back=0&ahead=0`, which
  // is the cheapest window it can build and is now what the page opens on.
  // A day further out costs the days in between, which is the price of not
  // adding a parameter; nothing here can ask for more than the old picker's
  // widest window did.
  const games = useGetGamesQuery({
    back: offset < 0 ? -offset : 0,
    ahead: offset > 0 ? offset : 0,
  });

  // Replace rather than push, like the matchup page: stepping through days is
  // adjusting the view you're on, not moving to another one, and a history
  // entry per arrow press makes Back mean nothing.
  const update = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === null) merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged, { replace: true });
  };

  const goTo = (value: string) => update({ day: dayParam(value, today) });

  // Whether the response in hand actually answers the day being asked about.
  //
  // It often doesn't, and `data` alone can't tell you: while a new day is in
  // flight RTK Query keeps serving the *previous* one's response, which is
  // the difference between `isFetching` and `isLoading`. Filtering that by
  // the new day finds nothing -- which is how stepping to a day used to
  // flash "No games on this day" before the games arrived.
  //
  // The window it was read for is what settles it, and settles it better than
  // tracking which request is outstanding would: a response fetched for
  // yesterday covers today too (the window is anchored on today either way),
  // so stepping forward renders from it immediately instead of waiting on a
  // request for games already in hand.
  const answers =
    games.data && day >= games.data.since && day <= games.data.until
      ? games.data
      : null;

  // The window can hold days either side of the one being shown, so the day
  // is a filter here and not just a request.
  const arrived = useMemo(
    () =>
      answers
        ? { day, games: answers.games.filter((game) => game.day === day) }
        : null,
    [answers, day],
  );

  // The last day that actually rendered. A day the cache hasn't got is a new
  // query with no data, and blanking the page to a one-word "Loading" for it
  // loses the reader's place on every arrow press. So the day being left
  // stays up, greyed and marked busy, until the next one is here -- which
  // also means the page never changes height under a click.
  //
  // Written during render on purpose: an effect would need a second pass to
  // put it back, and that pass is the flash this exists to avoid.
  const shown = useRef<Day | null>(null);
  if (arrived) shown.current = arrived;
  const view = arrived ?? shown.current;
  // Real content, from a day that is no longer the one the picker is on.
  const stale = arrived === null && view !== null;

  // Memoized because the two derivations below key off it, and `view` is
  // itself stable: `arrived` is memoized, and the fallback is a ref's value.
  const all = useMemo(() => view?.games ?? [], [view]);
  // The leagues playing that day, plus whichever one is selected even when
  // none of its games are. Dropping it would leave the select with a value it
  // has no option for -- which renders blank, and hides the reason the page
  // below it is empty.
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
  // League, then the best team in the game -- see `order.ts`. Sorted here
  // rather than by the API, which has no ratings in front of it and orders a
  // window the only way a window can be ordered: by time.
  const listed = useMemo(
    () =>
      byLeagueThenRating(league ? all.filter((g) => g.league === league) : all),
    [all, league],
  );

  const hindsight = listed.some((game) => game.prediction?.in_sample);
  const priced = listed.some((game) => modelEdge(game) !== null);
  const graded = listed.some((game) => atsCall(game) !== null);

  return (
    <section className="games-page">
      <h2>Games</h2>

      <div className="controls">
        {/* One value, three controls, so they read as one thing. The arrows
            are what a reader moving through a week actually uses, so they sit
            beside the field rather than behind the calendar's popover. */}
        <div className="field">
          <label htmlFor="games-day">Day</label>
          <div className="stepper">
            <button
              type="button"
              className="step arrow"
              aria-label="Previous day"
              disabled={offset <= -MAX_BACK}
              onClick={() => goTo(shiftDay(day, -1))}
            >
              &lsaquo;
            </button>
            <input
              id="games-day"
              type="date"
              value={day}
              // The horizon, stated to the control rather than only enforced
              // after the fact: the native picker greys out what the API
              // can't answer for, which is a better refusal than a page that
              // silently snaps back to today.
              min={shiftDay(today, -MAX_BACK)}
              max={shiftDay(today, MAX_AHEAD)}
              onChange={(e) => goTo(e.target.value)}
            />
            <button
              type="button"
              className="step arrow"
              aria-label="Next day"
              disabled={offset >= MAX_AHEAD}
              onClick={() => goTo(shiftDay(day, 1))}
            >
              &rsaquo;
            </button>
            {/* Held disabled rather than hidden, like the arrows at the
                horizon: a control that comes and goes is harder to find than
                one that is sometimes spent. */}
            <button
              type="button"
              className="step"
              disabled={offset === 0}
              onClick={() => goTo(today)}
            >
              Today
            </button>
          </div>
        </div>
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
      ) : (
        <>
          {/* Something is moving for as long as the request is out. The page
              below it may be a whole day's games or nothing at all, and either
              way this is what separates "still coming" from "that's the
              answer". */}
          {games.isFetching && (
            <>
              <div className="loading-bar" aria-hidden="true" />
              <p className="sr-only" role="status">
                Loading games&hellip;
              </p>
            </>
          )}

          {view === null ? (
            // The first load, and the only time there is nothing to keep up.
            <p className="loading">Loading&hellip;</p>
          ) : (
            <div className={stale ? "stale" : undefined} aria-busy={stale}>
              {/* The day in words, which the date field can't say:
                  "Yesterday" is how anyone reading last night's scores thinks
                  about them. Labelled from the day on screen rather than the
                  one in the picker -- while a new day loads those differ, and
                  the greyed table below belongs to the older one. */}
              <h3>{dayLabel(view.day, today)}</h3>

              {listed.length === 0 ? (
                // Two different empty pages, and saying so is the whole point: a
                // day with games on it that the league filter has hidden is not a
                // day with nothing on, and a reader who set that filter on
                // another day has no other way to tell them apart.
                <p className="empty">
                  {league && all.length > 0 ? (
                    <>
                      No {league} games on this day &mdash;{" "}
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
                    "No games on this day."
                  )}
                </p>
              ) : (
                <>
                  <p className="meta" data-testid="games-meta">
                    {count(listed.length, "game")} &middot; times {zoneLabel()}
                  </p>
                  <GameTable games={listed} />
                  <p className="meta">
                    Spreads are quoted from the home team&rsquo;s side, so -6.5
                    means the home side lays six and a half. The model column is
                    each league&rsquo;s lowest-Brier release.
                    {/* Said only when some row has a gap to explain. The rule
                    itself is worth spelling out: the model never names a
                    side, so which one it picked is something the page
                    inferred from the two numbers rather than something the
                    model said. */}
                    {priced && (
                      <>
                        {" "}
                        Under the book&rsquo;s number is how far the
                        model&rsquo;s is from it, and which side that favours
                        &mdash; &ldquo;home +4&rdquo; is the model giving the
                        home team four points more than the book does. That side
                        is the model&rsquo;s pick, in the only sense it has one:
                        it names a number, not a team.
                      </>
                    )}
                    {/* Only once a game on the page has actually been graded -- a
                    footnote about a mark that isn't there is one more thing to
                    go looking for, and the same is true of the dagger below
                    it. */}
                    {graded && (
                      <>
                        {" "}
                        Once a game is final that pick has an answer, and the
                        mark beside the model&rsquo;s number is it: &#10003;
                        means that side covered, &#10007; that it didn&rsquo;t,
                        and = that the game landed exactly on the number.
                      </>
                    )}
                    {hindsight && (
                      <>
                        {" "}
                        &dagger; marks a game whose result that release has
                        already trained on, which makes the number &mdash; and
                        any mark beside it &mdash; hindsight rather than a
                        forecast.
                      </>
                    )}{" "}
                    Scores arrive with the nightly scrape, so a game that has
                    just finished can still read as scheduled, and one being
                    played now shows no score rather than a stale one. Games
                    with nothing to report yet keep a dash; anything else
                    &mdash; postponed, called off, under way &mdash; says so in
                    the result column.
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The day a `?day=` names, or today.
 *
 * Today for anything the API can't answer: a value that isn't a date, and a
 * date outside the week either side it serves. The second one is a link that
 * outlived its horizon rather than a typo, and today is a better answer to it
 * than an empty page that looks like a broken one.
 */
function dayIn(raw: string | null, today: string): string {
  const day = parseDay(raw);
  if (day === null) return today;
  const delta = daysBetween(today, day);
  if (delta < -MAX_BACK || delta > MAX_AHEAD) return today;
  return day;
}

/**
 * What `?day=` should say, or null to leave it off.
 *
 * The default is the absence of the parameter rather than a spelling of it, so
 * the page's own URL stays `/games` -- and a cleared date field is a way back
 * to today rather than a page with no day at all.
 */
function dayParam(value: string, today: string): string | null {
  const day = parseDay(value);
  return day === null || day === today ? null : day;
}
