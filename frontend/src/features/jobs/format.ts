/**
 * The small formatting decisions the job dashboard makes more than once.
 *
 * Pulled out of the components because each one is a judgement call about
 * what to say when the honest answer is "not much" -- and those are worth
 * testing on their own rather than through a rendered table.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, at the coarsest granularity that's still useful.
 *
 * A job that runs hourly and one that runs daily share this column, so the
 * unit changes rather than the number growing: "4m", "3h", "2d".
 *
 * A timestamp in the future reads as "just now" instead of "-3m". Small clock
 * differences between the container and the browser are normal, and a negative
 * age looks like a bug in the data rather than in the clock.
 */
export function ago(at: string | null | undefined, now = Date.now()): string {
  if (!at) return "never";
  const seconds = (now - new Date(at).getTime()) / 1000;
  if (Number.isNaN(seconds)) return "never";
  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  return `${Math.floor(seconds / DAY)}d ago`;
}

/**
 * Bytes, at three significant figures or so.
 *
 * The seasons table is the one place this appears, and DESIGN.md §12.4 is
 * emphatic that size is a proxy for volume and not a count -- so this is
 * deliberately a size ("18.5 MB"), never dressed up as a number of games.
 */
export function size(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * A success rate, or a dash when nothing finished in the window.
 *
 * `null` is not zero (DESIGN.md §12.3): a job that hasn't finished a run yet
 * and a job that failed every attempt are different states, and rendering both
 * as "0%" would hide the difference behind the scariest reading of it.
 */
export function percent(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** Plural without the "(s)". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
