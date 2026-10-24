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
  | "offensePassSuccess"
  | "defensePassSuccess"
  | "offenseRunSuccess"
  | "defenseRunSuccess"
  | "offenseEpa"
  | "defenseEpa"
  | "offensePassEpa"
  | "defensePassEpa"
  | "offenseRunEpa"
  | "defenseRunEpa"
  | "week";

export interface MetricInfo {
  label: string;
  /** Lower is better, so the axis runs backwards. */
  reversed: boolean;
  format: (value: number) => string;
  /** The deviation a model published beside the value, in the value's units. */
  spread?: (sd: number) => string;
}

const points = (value: number) => value.toFixed(1);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const signed = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}`;

const points3 = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(3)}`;
const pts = (sd: number) => `± ${(sd * 100).toFixed(1)} pts`;
const epa = (sd: number) => `± ${sd.toFixed(3)}`;

export const METRICS: Record<Metric, MetricInfo> = {
  rating: { label: "Rating", reversed: false, format: points },
  record: { label: "Win %", reversed: false, format: percent },
  rd: { label: "RD", reversed: true, format: points },
  offense: { label: "Offense", reversed: false, format: points },
  defense: { label: "Defense", reversed: false, format: points },
  offenseSuccess: {
    label: "Off SR",
    reversed: false,
    format: percent,
    spread: pts,
  },
  defenseSuccess: {
    label: "Def SR allowed",
    reversed: true,
    format: percent,
    spread: pts,
  },
  offensePassSuccess: {
    label: "Off pass SR",
    reversed: false,
    format: percent,
    spread: pts,
  },
  defensePassSuccess: {
    label: "Def pass SR allowed",
    reversed: true,
    format: percent,
    spread: pts,
  },
  offenseRunSuccess: {
    label: "Off run SR",
    reversed: false,
    format: percent,
    spread: pts,
  },
  defenseRunSuccess: {
    label: "Def run SR allowed",
    reversed: true,
    format: percent,
    spread: pts,
  },
  offenseEpa: {
    label: "Off EPA/down",
    reversed: false,
    format: points3,
    spread: epa,
  },
  defenseEpa: {
    label: "Def EPA/down allowed",
    reversed: true,
    format: points3,
    spread: epa,
  },
  offensePassEpa: {
    label: "Off pass EPA",
    reversed: false,
    format: points3,
    spread: epa,
  },
  defensePassEpa: {
    label: "Def pass EPA allowed",
    reversed: true,
    format: points3,
    spread: epa,
  },
  offenseRunEpa: {
    label: "Off run EPA",
    reversed: false,
    format: points3,
    spread: epa,
  },
  defenseRunEpa: {
    label: "Def run EPA allowed",
    reversed: true,
    format: points3,
    spread: epa,
  },
  week: { label: "Week's move", reversed: false, format: signed },
};

/** What the page knows this model publishes -- the table's column flags. */
export interface Available {
  rd: boolean;
  units: boolean;
  success: boolean;
  /** Success rate by pass and by run, which the same models keep. */
  successSplit: boolean;
  /** EPA per down, whole and by pass and run. */
  epa: boolean;
  epaSplit: boolean;
  week: boolean;
}

/**
 * What the rows hold, by the rules the table's columns follow: asked of the
 * data rather than the model name, so a model that starts publishing a column
 * gets it without a change here. Measured over the whole table, so a filter
 * can't take a column away mid-scroll.
 */
export function availability(rows: TeamRow[], week: boolean): Available {
  return {
    rd: rows.some((row) => row.rd != null),
    units: rows.some((row) => row.offense != null || row.defense != null),
    success: rows.some((row) => row.success != null),
    successSplit: rows.some((row) => row.success?.passes || row.success?.runs),
    epa: rows.some((row) => row.epa != null),
    epaSplit: rows.some((row) => row.epa?.passes || row.epa?.runs),
    week,
  };
}

/** The pass / run columns, in the table's order. */
export const SUCCESS_SPLIT: Metric[] = [
  "offensePassSuccess",
  "defensePassSuccess",
  "offenseRunSuccess",
  "defenseRunSuccess",
];
export const EPA_SPLIT: Metric[] = [
  "offensePassEpa",
  "defensePassEpa",
  "offenseRunEpa",
  "defenseRunEpa",
];

/** The metrics worth offering for this model, in the table's column order. */
export function availableMetrics(has: Available): Metric[] {
  return [
    "rating",
    "record",
    ...(has.rd ? (["rd"] as const) : []),
    ...(has.units ? (["offense", "defense"] as const) : []),
    ...(has.success ? (["offenseSuccess", "defenseSuccess"] as const) : []),
    ...(has.epa ? (["offenseEpa", "defenseEpa"] as const) : []),
    ...(has.successSplit ? SUCCESS_SPLIT : []),
    ...(has.epaSplit ? EPA_SPLIT : []),
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

export interface Reading {
  value: number;
  /** The deviation the model published beside it, where it published one. */
  sd: number | null;
}

/** What a row holds for a metric, or null where the model publishes none. */
export function readMetric(row: TeamRow, metric: Metric): Reading | null {
  const some = (
    side: { rate?: number; epa?: number; sd: number } | undefined,
  ) =>
    side ? { value: (side.rate ?? side.epa) as number, sd: side.sd } : null;
  switch (metric) {
    case "rating":
      return { value: row.rating, sd: null };
    case "record": {
      const played = row.wins + row.losses;
      return played === 0 ? null : { value: row.wins / played, sd: null };
    }
    case "rd":
      return row.rd == null ? null : { value: row.rd, sd: null };
    case "offense":
      return row.offense
        ? { value: row.offense.rating, sd: row.offense.rd }
        : null;
    case "defense":
      return row.defense
        ? { value: row.defense.rating, sd: row.defense.rd }
        : null;
    case "offenseSuccess":
      return some(row.success?.offense);
    case "defenseSuccess":
      return some(row.success?.defense);
    case "offensePassSuccess":
      return some(row.success?.passes?.offense);
    case "defensePassSuccess":
      return some(row.success?.passes?.defense);
    case "offenseRunSuccess":
      return some(row.success?.runs?.offense);
    case "defenseRunSuccess":
      return some(row.success?.runs?.defense);
    case "offenseEpa":
      return some(row.epa?.offense);
    case "defenseEpa":
      return some(row.epa?.defense);
    case "offensePassEpa":
      return some(row.epa?.passes?.offense);
    case "defensePassEpa":
      return some(row.epa?.passes?.defense);
    case "offenseRunEpa":
      return some(row.epa?.runs?.offense);
    case "defenseRunEpa":
      return some(row.epa?.runs?.defense);
    case "week":
      return row.movement ? { value: row.movement.rating, sd: null } : null;
  }
}

export function metricValue(row: TeamRow, metric: Metric): number | null {
  return readMetric(row, metric)?.value ?? null;
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
