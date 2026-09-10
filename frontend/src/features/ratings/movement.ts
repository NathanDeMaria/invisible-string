/**
 * What the week did to a team, in the words the column has room for.
 *
 * The API sends three numbers and the week it measured them against
 * (`app.movement`); this is the judgement about which of them to say. Kept out
 * of the component for the reason `games/format.ts` is: every function here
 * decides when *not* to speak -- a team that didn't move, one that didn't
 * play, a rating that rounds to nothing -- and those are worth testing
 * directly rather than through a rendered table.
 *
 * Nothing here is coloured. Green and red mean "verdict" everywhere else on
 * this site (a failing job, a number that beat the line), and a rating going
 * up is not a verdict -- it's a direction, which is what the arrow is for.
 */

import type { Movement } from "../../services/api";

/** The zone the site states dates in -- see `games/format.ts`. */
const GAME_TZ = "America/Chicago";

/**
 * A rating change, signed and rounded to the tenth the column prints.
 *
 * A change that rounds to nothing gets no sign: "+0.0" and "-0.0" are the same
 * week, and a sign on either implies a direction the number doesn't support.
 * That case is a real one rather than a rounding curiosity -- it's every team
 * that didn't play.
 */
export function ratingMove(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(rounded) < 0.05) return "0.0";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(1)}`;
}

/** Which way a team moved on the table, or null if it held its place. */
export interface Places {
  /** Positive: places gained. */
  count: number;
  up: boolean;
  /** Readable in greyscale and by a reader who doesn't see the colour. */
  glyph: string;
}

export function placeMove(value: number): Places | null {
  if (value === 0) return null;
  return {
    count: Math.abs(value),
    up: value > 0,
    glyph: value > 0 ? "▲" : "▼",
  };
}

/**
 * The week's record, or null for a team that didn't play.
 *
 * "0-0" is not the same statement as no games: it would read as a week that
 * happened and went nowhere. A team on a bye has nothing to report.
 */
export function record(wins: number, losses: number): string | null {
  if (wins === 0 && losses === 0) return null;
  return `${wins}-${losses}`;
}

/**
 * The whole cell said out loud, for the title that carries it.
 *
 * A cell of arrows and deltas is a shorthand, and every shorthand on this site
 * carries the sentence that decodes it -- see `ats.ts`.
 */
export function movementTitle(movement: Movement, since: string): string {
  const parts: string[] = [];
  const points = Math.abs(Math.round(movement.rating * 10) / 10);
  if (points < 0.05) {
    parts.push("Unchanged");
  } else {
    parts.push(
      `${movement.rating > 0 ? "Up" : "Down"} ${points.toFixed(1)} points`,
    );
  }

  const places = placeMove(movement.rank);
  if (places) {
    const noun = places.count === 1 ? "place" : "places";
    parts.push(`${places.up ? "up" : "down"} ${places.count} ${noun}`);
  }

  const played = record(movement.wins, movement.losses);
  const week = weekEnding(since);
  const tail = week ? ` since ${week}` : "";
  return played
    ? `${parts.join(" and ")}${tail}, going ${played}`
    : `${parts.join(" and ")}${tail}`;
}

/**
 * The day the comparison week ended, as a date rather than "last week".
 *
 * In US Central, the zone this site states every other date in: the value is
 * an instant (the last game of that week), and formatting it in the reader's
 * own zone would put the same week on two different days depending on where
 * they opened the page.
 */
export function weekEnding(since: string | null | undefined): string {
  if (!since) return "";
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: GAME_TZ,
  });
}
