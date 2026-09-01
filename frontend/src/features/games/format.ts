/**
 * The formatting decisions the games page makes more than once.
 *
 * Pulled out of the components for the reason the jobs page's are: each one is
 * a judgement about what to say when the honest answer is "we don't know", and
 * those are worth testing directly rather than through a rendered table.
 *
 * Every date function here takes days as `YYYY-MM-DD` strings, which is what
 * the API sends. They are never fed to `new Date(day)`: that parses a bare
 * date as UTC midnight, which formats as the *previous* day everywhere west of
 * Greenwich -- the exact off-by-one this page would be least able to survive.
 */

const MS_PER_DAY = 86_400_000;

/**
 * A spread, from the home team's side.
 *
 * Same convention on both of the page's spread columns, which is what lets
 * them be read against each other: negative means the home team is favoured,
 * so `-6.5` is "home lays six and a half".
 *
 * A line inside half a point of zero is a pick'em, and says so -- "0" and
 * "-0.0" both read as a missing number rather than as an even game.
 */
export function spread(value: number | null | undefined): string {
  if (value == null) return "—";
  if (Math.abs(value) < 0.05) return "PK";
  const rounded = Math.round(value * 10) / 10;
  const magnitude = Number.isInteger(rounded)
    ? String(Math.abs(rounded))
    : Math.abs(rounded).toFixed(1);
  return `${rounded > 0 ? "+" : "-"}${magnitude}`;
}

/**
 * A margin in points, unsigned.
 *
 * Rounded exactly like `spread()`, so a gap stated in these terms is the gap
 * between the two spread columns *as the page prints them* rather than as it
 * stores them -- a reader who subtracts the two numbers themselves should get
 * this one back.
 */
export function points(value: number): string {
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A win probability, rounded to the point where the extra digits are noise. */
export function probability(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

/**
 * The final score, in the order the matchup above it reads: away first.
 *
 * Both scores or neither. A game the scrape hasn't returned yet carries no
 * score at all rather than a zero, and half a score is a bug, not a result.
 */
export function score(
  away: number | null | undefined,
  home: number | null | undefined,
): string {
  if (away == null || home == null) return "—";
  return `${away}–${home}`;
}

/**
 * What to say in the Result column for a game with no result.
 *
 * The season files carry the games ESPN hasn't finished as well as the ones it
 * has, so most rows in the window have no score -- and `completed` on its own
 * can't tell a game that is on tonight from one that was called off. `status`
 * is ESPN's own `status.type.name`, passed through verbatim by the API for the
 * reason endgame declines to enumerate it upstream: it is a value ESPN sends,
 * not a parameter anyone sends it.
 *
 * So the mapping lives here rather than in a union type, and it is open at the
 * bottom: a status nobody has seen before is rendered from its own name rather
 * than swallowed. Returns null for the states with nothing to add, which is
 * where the em dash stays.
 */
const STATE_LABELS: Record<string, string> = {
  STATUS_IN_PROGRESS: "In progress",
  STATUS_END_PERIOD: "In progress",
  STATUS_HALFTIME: "Halftime",
  STATUS_DELAYED: "Delayed",
  STATUS_RAIN_DELAY: "Delayed",
  STATUS_SUSPENDED: "Suspended",
  STATUS_POSTPONED: "Postponed",
  STATUS_CANCELED: "Cancelled",
  STATUS_FORFEIT: "Forfeit",
  // ESPN calls a game final; the scrape found no score on either side of it
  // and recorded it unplayed, without rewriting the status to agree. That
  // disagreement is the whole content of the row -- there is no result to
  // show and there never will be, which is not the same as "not yet".
  STATUS_FINAL: "No result",
  STATUS_FINAL_OVERTIME: "No result",
};

/**
 * The states worth no words: the game simply hasn't happened yet.
 *
 * "" is a game saved before endgame carried a status, which is most of the
 * bucket and all of it finished -- so it only reaches here on a row that is
 * already saying nothing.
 */
const QUIET_STATES = new Set(["", "STATUS_SCHEDULED", "STATUS_PRE"]);

/**
 * The label for an unfinished game's Result cell, or null for the em dash.
 *
 * Nullish is a dash too, like every other formatter here: the field is
 * required on the wire, and a row that lost it is still a row.
 */
export function statusLabel(status: string | null | undefined): string | null {
  if (status == null || QUIET_STATES.has(status)) return null;
  const known = STATE_LABELS[status];
  if (known) return known;
  return unknownLabel(status);
}

/**
 * A status this page has never seen, said out loud anyway.
 *
 * `STATUS_BAD_WEATHER` reads as "Bad weather" -- which is worse than a real
 * label and much better than a dash, since the alternative is a row that
 * silently claims a game is merely upcoming when ESPN said something else
 * about it. Anything not shaped like one of ESPN's names is passed through
 * untouched rather than mangled.
 */
function unknownLabel(status: string): string {
  if (!status.startsWith("STATUS_")) return status;
  const words = status.slice("STATUS_".length).replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The zone the whole page is stated in: the one endgame's jobs think in, and
 * the one the backend cuts days on (DESIGN.md §13).
 */
const GAME_TZ = "America/Chicago";

/**
 * Tip-off, in the same zone the day headings are.
 *
 * Deliberately not the reader's own zone. The days are grouped in US Central,
 * so a local clock puts a 9pm game under "Today" and labels it 2:00 AM for
 * anyone east of it -- a page that contradicts itself. One zone, named on
 * every row, is the version that can't.
 */
export function tipoff(start: string, timeZone: string = GAME_TZ): string {
  const at = new Date(start);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

/**
 * What to call that zone right now -- "CDT" or "CST".
 *
 * Said once, above the tables, rather than stamped on every row: eleven copies
 * of it is noise, and on a phone it was enough to wrap the column. Read off
 * the formatter rather than hardcoded, so the page doesn't claim daylight time
 * in January.
 */
export function zoneLabel(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone: GAME_TZ,
    timeZoneName: "short",
  }).formatToParts(at);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "CT";
}

/** A `YYYY-MM-DD` day as a Date at local midnight -- see the module note. */
function localMidnight(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/** The inverse: a local Date back to the `YYYY-MM-DD` the API speaks. */
function isoDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Today, in the zone the games are filed under.
 *
 * The page asks the API for a day as an offset from today, so it has to know
 * what today is *before* it has asked anything -- which rules out deriving it
 * from a response. Read through `Intl` in `GAME_TZ` rather than off the local
 * clock's own date: a reader in Auckland is a day ahead of the boundary these
 * games are cut on, and would otherwise open the page on tomorrow.
 *
 * What's left is a trust in the reader's *clock*, where before there was none.
 * A clock wrong by hours across midnight opens the page a day off -- and says
 * which day it opened on, in the picker and in the heading, which is the part
 * that makes it recoverable rather than confusing.
 */
export function todayCentral(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: GAME_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) =>
    parts.find((piece) => piece.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The day `delta` days from `day`, which is what the arrows move by. */
export function shiftDay(day: string, delta: number): string {
  const at = localMidnight(day);
  at.setDate(at.getDate() + delta);
  return isoDay(at);
}

/**
 * A `YYYY-MM-DD` out of a query string, or null if it isn't one.
 *
 * The shape check isn't enough on its own: `2026-02-31` matches it and isn't a
 * date, and `Date` rolls it forward to March rather than refusing. So the
 * answer is the round trip -- a day that doesn't come back unchanged was never
 * a day, and gets the same treatment as a missing one.
 */
export function parseDay(raw: string | null | undefined): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return isoDay(localMidnight(raw)) === raw ? raw : null;
}

/** Whole days from `from` to `day`; negative for a day in the past. */
export function daysBetween(from: string, day: string): number {
  return Math.round(
    (localMidnight(day).getTime() - localMidnight(from).getTime()) / MS_PER_DAY,
  );
}

/**
 * A day heading.
 *
 * The three days either side of today get their names, because "Yesterday" is
 * how anyone reading this page thinks about last night's scores. Everything
 * else gets a date, since "3 days ago" is arithmetic the reader shouldn't have
 * to do.
 */
export function dayLabel(day: string, today: string): string {
  const delta = daysBetween(today, day);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  return localMidnight(day).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}
