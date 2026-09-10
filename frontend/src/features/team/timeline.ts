/**
 * The arithmetic behind a team's rating timeline.
 *
 * Split out of the component for the reason `games/curve.ts` is: the chart is
 * a couple of `<path>`s and a lot of decisions about where things go, and the
 * decisions are what's worth testing. A rendered SVG can be inspected for
 * "there is a line"; it can't be asked whether the offseason is a gap.
 *
 * Three conventions run through all of it.
 *
 * **The x axis is snapshots, evenly spaced, not clock time.** Weeks inside a
 * season are a week apart, so within a season the two are the same axis. Across
 * an offseason they are not: eight months of nothing would take half the width
 * and squeeze every game into the margins.
 *
 * **The line breaks between seasons.** Nothing was played over the offseason;
 * the jump from a team's last week to its first is `pass_season` regressing it
 * toward its anchor. Drawing a segment across that would show a slide that no
 * game produced, and reading a slope off it would be reading a rollover rule.
 *
 * **The y axis is the rating, and it does not start at zero.** A rating scale
 * has no meaningful zero -- 1500 is the middle of it by construction -- so a
 * zero baseline would compress every season into a band at the top. It is the
 * one case where a truncated axis is the honest one, and the gridline labels
 * are what say so.
 */

import type { HistoryPoint } from "../../services/api";

export const VIEWBOX = { width: 640, height: 240 };

/**
 * The plot area inside the viewBox.
 *
 * The left gutter holds a four-digit rating; the bottom one holds a season
 * label and the dates at either end.
 */
export const PLOT = { left: 42, right: 14, top: 12, bottom: 34 };

/** Below this many points, each one gets a marker. See `RatingTimeline`. */
export const MARKER_LIMIT = 40;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function plotBox(): Box {
  return {
    x: PLOT.left,
    y: PLOT.top,
    width: VIEWBOX.width - PLOT.left - PLOT.right,
    height: VIEWBOX.height - PLOT.top - PLOT.bottom,
  };
}

/**
 * One season's run of points, and where it sits on the x axis.
 *
 * `from`/`to` are indices into the whole series, which is what makes the
 * season label sit over its own weeks rather than over the middle of the
 * chart.
 */
export interface Season {
  year: number;
  from: number;
  to: number;
  points: HistoryPoint[];
}

/**
 * The series split into seasons, in order.
 *
 * Split on the year changing rather than grouped by it: the points arrive
 * oldest-first, so a change of year is a boundary, and a team whose history
 * has a gap in the middle (a program that stopped and restarted) gets two runs
 * rather than one line drawn across the years it didn't play.
 */
export function seasons(points: HistoryPoint[]): Season[] {
  const out: Season[] = [];
  points.forEach((point, index) => {
    const last = out[out.length - 1];
    if (last && last.year === point.year && last.to === index - 1) {
      last.to = index;
      last.points.push(point);
      return;
    }
    out.push({ year: point.year, from: index, to: index, points: [point] });
  });
  return out;
}

export interface Bounds {
  low: number;
  high: number;
  /** The gap between gridlines, in rating points. */
  step: number;
}

/**
 * The y axis: a rounded range with room above and below the line.
 *
 * Rounded to a step that suits the span, so the gridlines land on numbers a
 * reader recognizes (1750, 1800) rather than on the extremes of this
 * particular team's season. The padding is what keeps the highest point off
 * the top edge, where a line that touches the frame reads as clipped.
 *
 * A flat series -- one point, or a team that hasn't moved -- still gets a
 * band, because a zero-height axis is a divide by zero and a line drawn
 * along the top of the plot.
 */
export function bounds(points: HistoryPoint[]): Bounds {
  const ratings = points.map((point) => point.rating);
  const low = ratings.length ? Math.min(...ratings) : 1500;
  const high = ratings.length ? Math.max(...ratings) : 1500;
  const step = stepFor(high - low);
  const padding = step / 2;
  return {
    low: Math.floor((low - padding) / step) * step,
    high: Math.ceil((high + padding) / step) * step,
    step,
  };
}

function stepFor(span: number): number {
  if (span <= 40) return 10;
  if (span <= 120) return 25;
  if (span <= 300) return 50;
  if (span <= 700) return 100;
  return 200;
}

/**
 * The gridline values, low to high.
 *
 * Four or five of them: enough to read a level off, few enough that the lines
 * stay behind the data rather than becoming a ladder in front of it.
 */
export function ticks(box: Bounds): number[] {
  const out: number[] = [];
  // A step chosen so this stays in single digits; the guard is for a series
  // whose span is enormous rather than for the normal case.
  for (let value = box.low; value <= box.high + 0.001; value += box.step) {
    out.push(Math.round(value));
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Where the nth of `count` points sits across the plot, as a fraction.
 *
 * A single point sits in the middle rather than at the left edge: with nothing
 * to compare it to there is no "across" for it to be at the start of.
 */
export function acrossThePlot(index: number, count: number): number {
  if (count <= 1) return 0.5;
  return index / (count - 1);
}

export function pointX(index: number, count: number, box: Box): number {
  return box.x + acrossThePlot(index, count) * box.width;
}

export function ratingY(rating: number, scale: Bounds, box: Box): number {
  const span = scale.high - scale.low || 1;
  return box.y + box.height - ((rating - scale.low) / span) * box.height;
}

/**
 * One season's line.
 *
 * Empty for a season of one point: a path with a single point draws nothing,
 * and the component puts a marker there instead so the week is still on the
 * chart rather than silently missing from it.
 */
export function linePath(
  season: Season,
  count: number,
  scale: Bounds,
  box: Box,
): string {
  if (season.points.length < 2) return "";
  return season.points
    .map((point, offset) => {
      const x = pointX(season.from + offset, count, box);
      const y = ratingY(point.rating, scale, box);
      return `${offset === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * The point nearest a fraction across the plot, or null outside it.
 *
 * Null rather than clamping: a pointer in the left gutter is not hovering the
 * first week, and a readout that says it is would be wrong in the one place a
 * reader is most likely to leave the pointer resting.
 */
export function nearest(fraction: number, count: number): number | null {
  if (count === 0 || fraction < -0.02 || fraction > 1.02) return null;
  const index = Math.round(fraction * (count - 1));
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * The chart said out loud, for a reader who gets the label rather than the
 * picture.
 *
 * Where it started, where it ended, and the span it covers -- which is the
 * sentence anyone describing this chart to somebody else would say.
 */
export function summary(team: string, points: HistoryPoint[]): string {
  if (points.length === 0) return `No rating history for ${team}`;
  const first = points[0];
  const last = points[points.length - 1];
  const direction =
    Math.abs(last.rating - first.rating) < 0.05
      ? "level at"
      : last.rating > first.rating
        ? "rising to"
        : "falling to";
  return (
    `${team}'s rating over ${points.length} weeks, ` +
    `from ${first.rating.toFixed(0)} in ${first.year} ` +
    `${direction} ${last.rating.toFixed(0)} in ${last.year}`
  );
}
