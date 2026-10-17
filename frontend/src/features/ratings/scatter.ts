/**
 * The arithmetic behind the ratings scatter: any two of the table's numbers,
 * one against the other, a dot per team.
 *
 * Split out of the component for the reason `team/timeline.ts` is -- the
 * decisions about where things go are what's worth testing, and a rendered
 * SVG can't be asked whether a better defense sits up or down.
 *
 * Two conventions run through it.
 *
 * **Better is up and to the right, on every axis.** A lower RD is the more
 * settled rating and a lower success rate allowed is the better defense, so
 * those axes run backwards. Offense against defense then reads the way a
 * reader expects: the top-right corner is the good-at-both teams, whatever
 * pair of columns is on the axes.
 *
 * **The axes are the data's range, not zero-based.** Most of these numbers
 * have no meaningful zero (a rating is centred on 1500 by construction), and
 * a dot plot encodes position rather than length, so a truncated axis loses
 * nothing. The gridlines are labelled, which is what says where it starts.
 */

import type { TeamRow } from "../../services/api";

export type Metric =
  | "rating"
  | "record"
  | "rd"
  | "offense"
  | "defense"
  | "offenseSuccess"
  | "defenseSuccess"
  | "week";

export interface MetricInfo {
  label: string;
  /** Lower is better, so the axis runs backwards. */
  reversed: boolean;
  format: (value: number) => string;
}

const points = (value: number) => value.toFixed(1);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const signed = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}`;

export const METRICS: Record<Metric, MetricInfo> = {
  rating: { label: "Rating", reversed: false, format: points },
  record: { label: "Win %", reversed: false, format: percent },
  rd: { label: "RD", reversed: true, format: points },
  offense: { label: "Offense", reversed: false, format: points },
  defense: { label: "Defense", reversed: false, format: points },
  offenseSuccess: { label: "Off SR", reversed: false, format: percent },
  defenseSuccess: { label: "Def SR allowed", reversed: true, format: percent },
  week: { label: "Week's move", reversed: false, format: signed },
};

/** What the page knows this model publishes -- the table's column flags. */
export interface Available {
  rd: boolean;
  units: boolean;
  success: boolean;
  week: boolean;
}

/** The metrics worth offering for this model, in the table's column order. */
export function availableMetrics(has: Available): Metric[] {
  return [
    "rating",
    "record",
    ...(has.rd ? (["rd"] as const) : []),
    ...(has.units ? (["offense", "defense"] as const) : []),
    ...(has.success ? (["offenseSuccess", "defenseSuccess"] as const) : []),
    ...(has.week ? (["week"] as const) : []),
  ];
}

/**
 * The pair a chart opens on: offense against defense where the model rates a
 * team's halves -- the question this chart was asked for -- and otherwise
 * the rating against the record, which every model has.
 */
export function defaultAxes(available: Metric[]): { x: Metric; y: Metric } {
  if (available.includes("offense") && available.includes("defense")) {
    return { x: "offense", y: "defense" };
  }
  return { x: "record", y: "rating" };
}

/**
 * A chosen metric, or the default where this model doesn't publish it.
 *
 * The choice is kept across a change of model, the way the table's sort is,
 * so the fallback happens here rather than by forgetting the choice: going
 * from a units model to Elo and back lands on the pair you picked.
 */
export function resolveAxis(
  chosen: Metric | null,
  available: Metric[],
  fallback: Metric,
): Metric {
  return chosen && available.includes(chosen) ? chosen : fallback;
}

export function metricValue(row: TeamRow, metric: Metric): number | null {
  switch (metric) {
    case "rating":
      return row.rating;
    case "record": {
      const played = row.wins + row.losses;
      return played === 0 ? null : row.wins / played;
    }
    case "rd":
      return row.rd ?? null;
    case "offense":
      return row.offense?.rating ?? null;
    case "defense":
      return row.defense?.rating ?? null;
    case "offenseSuccess":
      return row.success?.offense.rate ?? null;
    case "defenseSuccess":
      return row.success?.defense.rate ?? null;
    case "week":
      return row.movement?.rating ?? null;
  }
}

export interface Dot {
  row: TeamRow;
  x: number;
  y: number;
}

/**
 * The teams with a value on both axes. A team missing either one -- no plays
 * on file, no games played -- has no place on the plot, rather than a place
 * at zero it didn't earn.
 */
export function dots(rows: TeamRow[], x: Metric, y: Metric): Dot[] {
  const out: Dot[] = [];
  for (const row of rows) {
    const across = metricValue(row, x);
    const up = metricValue(row, y);
    if (across != null && up != null) out.push({ row, x: across, y: up });
  }
  return out;
}

export const VIEWBOX = { width: 640, height: 440 };

/** Room for the gridline labels on the left and bottom, and the axis titles. */
export const PLOT = { left: 54, right: 24, top: 12, bottom: 42 };

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

export interface Scale {
  low: number;
  high: number;
  step: number;
  reversed: boolean;
}

/**
 * One axis: a rounded range with room either side, on a step that lands the
 * gridlines on numbers a reader recognises.
 *
 * The step comes from the span rather than from a table per metric, because
 * the same metric spans 0.05 in one league and 0.3 in another.
 */
export function scale(values: number[], reversed: boolean): Scale {
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const step = niceStep((high - low) / 5 || Math.abs(low) / 5 || 1);
  return {
    low: Math.floor((low - step / 4) / step) * step,
    high: Math.ceil((high + step / 4) / step) * step,
    step,
    reversed,
  };
}

/** The nearest of 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice =
    unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return nice * power;
}

export function ticks(axis: Scale): number[] {
  const out: number[] = [];
  const count = Math.round((axis.high - axis.low) / axis.step);
  // Built from the count rather than by adding the step, so a 0.025 step
  // doesn't drift into labels like 0.42500000000000004.
  for (let i = 0; i <= Math.min(count, 12); i++) {
    out.push(Number((axis.low + i * axis.step).toPrecision(12)));
  }
  return out;
}

/**
 * A gridline's label: only the decimals the step needs, so a rating axis
 * reads 1600 rather than 1600.0 and a success-rate axis 42.5% where it steps
 * by 2.5.
 */
export function tickLabel(metric: Metric, value: number, step: number): string {
  const percent = metric === "record" || metric.endsWith("Success");
  const shown = percent ? value * 100 : value;
  const shownStep = percent ? step * 100 : step;
  const decimals = Math.max(0, -Math.floor(Math.log10(shownStep) + 1e-9));
  const places = Number.isInteger(Number(shownStep.toFixed(6)))
    ? 0
    : Math.max(decimals, 1);
  const text = Math.abs(shown).toFixed(places);
  const sign =
    metric === "week" && shown !== 0
      ? shown > 0
        ? "+"
        : "−"
      : shown < 0
        ? "−"
        : "";
  return `${sign}${text}${percent ? "%" : ""}`;
}

/** Where a value sits along an axis, as a fraction from the bad end. */
export function fraction(value: number, axis: Scale): number {
  const span = axis.high - axis.low || 1;
  const along = (value - axis.low) / span;
  return axis.reversed ? 1 - along : along;
}

export function toX(value: number, axis: Scale, box: Box): number {
  return box.x + fraction(value, axis) * box.width;
}

export function toY(value: number, axis: Scale, box: Box): number {
  return box.y + box.height - fraction(value, axis) * box.height;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The dot under the pointer: the nearest within `reach` viewBox units, or
 * null. A hit target bigger than the mark, because a 3-unit dot is a hard
 * thing to land a pointer on, and null past it so the readout doesn't name a
 * team the pointer is nowhere near.
 */
export function nearestDot(
  px: number,
  py: number,
  placed: { x: number; y: number }[],
  reach = 14,
): number | null {
  let best: number | null = null;
  let bestDistance = reach * reach;
  placed.forEach((point, index) => {
    const distance = (point.x - px) ** 2 + (point.y - py) ** 2;
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** Axis title, with the direction said where it runs backwards. */
export function axisTitle(metric: Metric): string {
  const info = METRICS[metric];
  return info.reversed ? `${info.label} (lower is better)` : info.label;
}

/** The chart said out loud, for a reader who gets the label, not the picture. */
export function summary(count: number, x: Metric, y: Metric): string {
  return `${METRICS[y].label} against ${METRICS[x].label} for ${count} teams`;
}
