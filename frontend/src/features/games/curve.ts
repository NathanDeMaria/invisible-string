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
 *
 * **A point carries two probabilities**, and the second one is drawn on the
 * same axis as the first: `adjusted_win_prob` is the same snap with the
 * game's fifty-fifty balls split evenly rather than credited to whoever they
 * fell to. Two lines on one axis rather than two charts, because the whole
 * reading of it is the gap between them -- see `gapPath` and the rail under
 * the plot.
 */

import type {
  CurvePoint,
  GameControl,
  LuckyBounces,
  LuckySwing,
} from "../../services/api";

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
export const PLOT = { left: 34, right: 12, top: 10, bottom: 56 };
export const VIEWBOX = { width: 640, height: 248 };

/**
 * The rail of bounces under the plot: where its baseline sits, and how tall
 * the biggest tick on it gets.
 *
 * Under the chart rather than on it. A bounce is a thing that happened at a
 * moment, not a value on the win probability axis, and drawing it as a mark
 * on the line would make it look like one -- the tick shares the plot's x
 * axis and nothing else. Up is a break that went the home team's way, down is
 * one that went the other, which is the same direction the curve above means.
 */
export const RAIL = { height: 14, floor: 0.02 };

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

/** One snap's place in the plot, on the curve that happened. */
export function place(point: CurvePoint): Point {
  return placeAt(point, point.home_win_prob);
}

/** The same snap on the curve with its bounces split. */
export function placeAdjusted(point: CurvePoint): Point {
  return placeAt(point, point.adjusted_win_prob);
}

/**
 * A snap's x, and the y of whichever of its two probabilities is being drawn.
 *
 * The two curves share an axis and a time, so they share this: a second
 * placement function would be the same arithmetic with one field swapped, and
 * the field is the only thing that differs between the lines.
 */
export function placeAt(point: CurvePoint, probability: number): Point {
  const box = plotBox();
  return {
    x: box.x + acrossTheGame(point) * box.width,
    y: box.y + (1 - probability) * box.height,
  };
}

/**
 * The rail's baseline, in viewBox units.
 *
 * Below the quarter labels rather than inside the plot, and close enough to
 * them that the two read as one axis: the rail's whole meaning is the x it
 * shares with the curve, and a band of empty space between them would make it
 * a second chart.
 */
export function railY(): number {
  return VIEWBOX.height - 22;
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
  return pathThrough(points, place);
}

/**
 * The other line: the same snaps with each bounce replaced by the average of
 * its two branches, and every later point carrying the difference forward.
 *
 * Drawn from the same points as the realized line rather than from a second
 * series, because that is what it is -- the API sends both numbers on one
 * snap precisely so the two can never come apart here.
 */
export function adjustedLinePath(points: CurvePoint[]): string {
  return pathThrough(points, placeAdjusted);
}

function pathThrough(
  points: CurvePoint[],
  at: (point: CurvePoint) => Point,
): string {
  if (points.length === 0) return "";
  return points
    .map((point, index) => {
      const { x, y } = at(point);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * The band between the two curves, as one closed path.
 *
 * The gap is the whole point of drawing them together -- it is the win
 * probability the bounces are holding up -- so it gets a wash rather than
 * being left as white space between two strokes. Down one line and back along
 * the other, which closes cleanly whichever line is on top and however often
 * they cross.
 */
export function gapPath(points: CurvePoint[]): string {
  if (points.length === 0) return "";
  const back = [...points]
    .reverse()
    .map((point) => {
      const { x, y } = placeAdjusted(point);
      return `L${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return `${linePath(points)} ${back} Z`;
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

/** One bounce, placed on the rail under the plot. */
export interface Tick {
  swing: LuckySwing;
  point: CurvePoint;
  x: number;
  /** Signed: up the rail for a break the home team got, down for the away. */
  height: number;
}

/**
 * The bounces, placed on the rail: where each one happened, and how big it
 * was against the biggest one in this game.
 *
 * Scaled to the game rather than to a fixed axis, because the alternative is
 * an axis whose top is a number nobody has a feel for -- a full turnover swing
 * is worth wildly different amounts in the first quarter and the fourth. What
 * the rail is for is "which of these were the big ones, and when", and that is
 * a comparison inside one game. `RAIL.floor` is what stops a game of trivial
 * bounces from drawing them at full height: below it, the ticks stay small
 * because they were small.
 *
 * A swing whose play isn't on the curve is dropped rather than placed at
 * zero. It shouldn't happen -- upstream only prices a bounce that is a snap
 * with something after it -- and inventing an x for one would be a mark on
 * the rail at a moment the game wasn't at.
 */
export function railTicks(points: CurvePoint[], swings: LuckySwing[]): Tick[] {
  const biggest = Math.max(
    RAIL.floor,
    ...swings.map((swing) => Math.abs(swing.home_delta)),
  );
  const byPlay = new Map(points.map((point) => [point.play_id, point]));
  const ticks: Tick[] = [];
  for (const swing of swings) {
    const point = byPlay.get(swing.play_id);
    if (!point) continue;
    ticks.push({
      swing,
      point,
      x: place(point).x,
      height: (swing.home_delta / biggest) * RAIL.height,
    });
  }
  return ticks;
}

/**
 * What a bounce is called, in the page's words rather than the wire's.
 *
 * An unknown kind is spelled out rather than dropped: `kind` is a string on
 * the wire precisely because upstream may name a fifth coin one day, and a
 * row that renders blank would be worse than one that reads oddly.
 */
export function kindLabel(kind: string): string {
  const known: Record<string, string> = {
    fumble_lost: "Fumble lost",
    fumble_kept: "Fumble recovered",
    pass_defended_interception: "Interception",
    pass_defended_incomplete: "Pass broken up",
  };
  return known[kind] ?? kind.replace(/_/g, " ");
}

/**
 * The pair of control numbers as a sentence, or null when there's nothing to
 * compare.
 *
 * Three things it is careful about. It is said about the *home team* both
 * times, which is what makes it a comparison -- `GameControl` names both
 * sides, so a sentence that switched teams between the two numbers would read
 * as a swing that isn't there. It is phrased as a share held rather than as a
 * win probability: 58% doesn't say they were ever 58% to win, it says that
 * averaged over the minutes, that's where the model had them. And it states
 * the minutes, because regulation is all either number covers -- college
 * overtime has no clock to weight by, so a game that went to one is averaged
 * over less than sixty.
 */
export function adjustedControlLabel(
  control: GameControl | null | undefined,
  adjusted: GameControl | null | undefined,
  home: string,
): string | null {
  if (!control || !adjusted) return null;
  const minutes = Math.round(control.seconds / 60);
  return (
    `${home} held ${percent(control.home)} of the game, ` +
    `and ${percent(adjusted.home)} of it with the fifty-fifty balls split ` +
    `evenly, over ${minutes} minutes of regulation clock`
  );
}

/**
 * What the bounces were worth to each side, or null when nothing bounced.
 *
 * Deliberately not phrased as a share: the two totals are win probability in
 * the units the curve is drawn in, and they do not sum to anything. "Worth
 * 0.13 of win probability" is clumsier than "13%" and it is the honest
 * version -- a percentage here would be read as a share of the game, which is
 * the number two lines up.
 */
export function luckLabel(
  luck: LuckyBounces | null | undefined,
  home: string,
  away: string,
): string | null {
  if (!luck || luck.swings.length === 0) return null;
  return (
    `The bounces were worth ${luck.home.toFixed(2)} of win probability to ` +
    `${home} and ${luck.away.toFixed(2)} to ${away}`
  );
}

/** A share of the game, rounded the way the sentences above read it. */
function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}
