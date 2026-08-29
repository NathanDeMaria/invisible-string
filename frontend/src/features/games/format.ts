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

/**
 * Where a day sorts on the page: today, then forward, then backwards.
 *
 * Not simple chronological order, in either direction. Today is what the page
 * is for, so it goes first and tomorrow's slate follows it; the finished days
 * run backwards underneath, which is the direction anything time-ordered is
 * read. Purely chronological would bury tonight's games under two days of box
 * scores, and reverse-chronological would put tomorrow above them.
 */
export function dayRank(day: string, today: string): number {
  const delta = daysBetween(today, day);
  return delta >= 0 ? delta : 1000 - delta;
}

/**
 * The day "today" was when the window was cut, in the zone the backend counts
 * days in.
 *
 * Derived from the response rather than from the browser's clock: the window
 * is cut in US Central (DESIGN.md §13), and a reader in another zone asking
 * their own clock would label the wrong group "Today" for part of the day.
 */
export function todayOf(window: { until: string; days_ahead: number }): string {
  const day = localMidnight(window.until);
  day.setDate(day.getDate() - window.days_ahead);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}
