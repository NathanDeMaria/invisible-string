/**
 * The arithmetic behind the win probability chart.
 *
 * Split out of the component for the reason `format.ts` and `ats.ts` are: the
 * chart is one `<path>` and a lot of decisions about where things go, and the
 * decisions are what's worth testing. A rendered SVG can be inspected for
 * "there is a line"; it can't be asked whether Q3 starts where it should.
 *
 * Two conventions run through all of it.
 *
 * **The y axis is the home team's win probability**, 1 at the top. That is
 * what the API sends and what the point above the x axis means, so the away
 * team's chart is the same chart read from the bottom -- which is why the
 * axis is labelled with both team names rather than with a legend.
 *
 * **The x axis is elapsed regulation time**, not play number. Snaps are not
 * evenly spaced in time -- a two-minute drill is fifteen of them and a quarter
 * of grinding is thirty -- and a chart that spaced them evenly would stretch
 * the frantic end of a game across half the width. It is the same weighting
 * `game_control` uses, and for the same reason.
 */

import type { CurvePoint, GameControl } from "../../services/api";

/** Four fifteen-minute quarters, which is what the x axis spans. */
export const REGULATION_SECONDS = 3600;
export const PERIOD_SECONDS = 900;

/**
 * The plot area inside the viewBox.
 *
 * The left gutter holds one word -- see `WinProbabilityChart` for why the two
 * team names are a caption rather than axis labels. Sizing it for a team name
 * would mean sizing it for "North Carolina State", and clipping it is what
 * happens when you size it for "Duke".
 */
export const PLOT = { left: 34, right: 12, top: 10, bottom: 22 };
export const VIEWBOX = { width: 640, height: 220 };

/**
 * Seconds of regulation gone by the time of a snap.
 *
 * Overtime is pinned at the end rather than run past it: the API sends
 * `seconds_remaining: 0` for every overtime snap, because college overtime has
 * no clock at all to place them on. So they stack on the right-hand edge,
 * which is honest -- the model has no time feature there either -- rather than
 * inventing an axis for them.
 */
export function elapsed(point: CurvePoint): number {
  return REGULATION_SECONDS - point.seconds_remaining;
}

/** Where a snap sits across the plot, 0 at kickoff and 1 at the final whistle. */
export function acrossTheGame(point: CurvePoint): number {
  return elapsed(point) / REGULATION_SECONDS;
}

export interface Point {
  x: number;
  y: number;
}

/** The plot area in viewBox units. */
export function plotBox() {
  return {
    x: PLOT.left,
    y: PLOT.top,
    width: VIEWBOX.width - PLOT.left - PLOT.right,
    height: VIEWBOX.height - PLOT.top - PLOT.bottom,
  };
}

/** One snap's place in the plot. */
export function place(point: CurvePoint): Point {
  const box = plotBox();
  return {
    x: box.x + acrossTheGame(point) * box.width,
    y: box.y + (1 - point.home_win_prob) * box.height,
  };
}

/** The y of a win probability, for the reference lines. */
export function probabilityY(probability: number): number {
  const box = plotBox();
  return box.y + (1 - probability) * box.height;
}

/** The x of a moment in the game, for the quarter separators. */
export function secondsX(seconds: number): number {
  const box = plotBox();
  return box.x + (seconds / REGULATION_SECONDS) * box.width;
}

/**
 * The curve as an SVG path.
 *
 * Straight segments, not a spline: a win probability holds its value until the
 * next snap changes it, and smoothing would draw the model easing into a
 * touchdown it learned about all at once. Empty for no points, which renders
 * as no path rather than as a broken one.
 */
export function linePath(points: CurvePoint[]): string {
  if (points.length === 0) return "";
  return points
    .map((point, index) => {
      const { x, y } = place(point);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

/** The same line closed down to the 50% rule, so the area can be filled. */
export function areaPath(points: CurvePoint[]): string {
  if (points.length === 0) return "";
  const first = place(points[0]);
  const last = place(points[points.length - 1]);
  const middle = probabilityY(0.5);
  return `M${first.x.toFixed(1)} ${middle.toFixed(1)} ${linePath(points).slice(1)} L${last.x.toFixed(1)} ${middle.toFixed(1)} Z`;
}

/**
 * The snaps where the scoreboard had just changed.
 *
 * Scores on a `CurvePoint` are the score *before* the snap, so the first point
 * carrying a new total is the first snap after the score -- which is exactly
 * where the model's number has already moved. Those are the moments worth a
 * mark on the line and a row in the table under it; every other snap is the
 * curve drifting.
 */
export function scoreChanges(points: CurvePoint[]): CurvePoint[] {
  const changes: CurvePoint[] = [];
  let home = 0;
  let away = 0;
  for (const point of points) {
    if (point.home_score !== home || point.away_score !== away) {
      changes.push(point);
      home = point.home_score;
      away = point.away_score;
    }
  }
  return changes;
}

/**
 * The snap nearest a fraction across the plot, for the crosshair.
 *
 * Nearest in *time*, which is what the reader is pointing at -- the points
 * bunch up wherever the clock stopped, so the nearest by index would jump
 * around under the pointer in exactly the places a reader looks hardest.
 */
export function nearest(points: CurvePoint[], fraction: number): number | null {
  if (points.length === 0) return null;
  const wanted = Math.min(1, Math.max(0, fraction)) * REGULATION_SECONDS;
  let best = 0;
  let closest = Infinity;
  points.forEach((point, index) => {
    const distance = Math.abs(elapsed(point) - wanted);
    if (distance < closest) {
      closest = distance;
      best = index;
    }
  });
  return best;
}

/**
 * What a snap is called: "Q3 7:22", or "OT" once the clock stops meaning
 * anything.
 *
 * Overtime gets no clock because the model isn't reading one -- college
 * overtime has no clock, and the API sends every overtime snap with the same
 * `seconds_remaining`. Printing a period clock beside a point that isn't
 * placed by it would be the chart claiming more than it knows.
 */
export function clockLabel(point: CurvePoint): string {
  if (point.period > 4)
    return point.period > 5 ? `OT${point.period - 4}` : "OT";
  const minutes = Math.floor(point.clock_seconds / 60);
  const seconds = point.clock_seconds % 60;
  return `Q${point.period} ${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Game control as a sentence, or null when there's nothing to say.
 *
 * Deliberately not phrased as a win probability. 0.68 doesn't say the home
 * team was ever 68% to win; it says that averaged over the minutes, that's
 * where the model had them -- so the words are "spent ... of the game ahead",
 * and the minutes it covers are stated because overtime isn't in them.
 */
export function controlLabel(
  control: GameControl | null | undefined,
  home: string,
  away: string,
): string | null {
  if (!control) return null;
  const ahead = control.home >= control.away ? home : away;
  const share = Math.max(control.home, control.away);
  const minutes = Math.round(control.seconds / 60);
  return `${ahead} held ${Math.round(share * 100)}% of the game, over ${minutes} minutes of regulation clock`;
}

/**
 * The seasons a fit was trained on, as a range where they're contiguous.
 *
 * Twenty years spelled out is a paragraph nobody reads, and "2006–2025" is
 * the same claim. A gap is worth showing rather than smoothing over, so a
 * non-contiguous list falls back to the list.
 */
export function seasonRange(seasons: number[]): string {
  if (seasons.length === 0) return "no seasons";
  const sorted = [...seasons].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (sorted.length === 1) return String(first);
  if (last - first + 1 === sorted.length) return `${first}–${last}`;
  return sorted.join(", ");
}
