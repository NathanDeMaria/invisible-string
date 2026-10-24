/**
 * Where each team stands among the league's teams on a column.
 *
 * Not `games/percentile.ts`, which places one game's number among five seasons
 * of games from a published distribution. This is the league's own table read
 * sideways: of the teams the model rates on this metric, what share is this
 * one ahead of. "0.512" doesn't say whether that is good; "91st" does.
 *
 * Direction comes from `METRICS`, so a lower success rate allowed is a higher
 * percentile, and ties share the middle of their run rather than the better
 * place -- the same call the game page's percentile makes.
 */

import type { TeamRow } from "../../services/api";
import { METRICS, readMetric, type Metric } from "./scatter";

/** The sorted values of one metric across the table. */
export type Population = number[];

export function population(rows: TeamRow[], metric: Metric): Population {
  const values: number[] = [];
  for (const row of rows) {
    const reading = readMetric(row, metric);
    if (reading) values.push(reading.value);
  }
  return values.sort((a, b) => a - b);
}

/**
 * The percentile of `value`, 0 to 100, or null where there is no one to
 * compare with: a population of one has no middle.
 */
export function leaguePercentile(
  all: Population,
  value: number,
  metric: Metric,
): number | null {
  if (all.length < 2) return null;
  let below = 0;
  let equal = 0;
  for (const other of all) {
    if (other < value) below += 1;
    else if (other === value) equal += 1;
  }
  const above = all.length - below - equal;
  // The teams this one is ahead of, counting half of any it ties with.
  const beaten = METRICS[metric].reversed ? above : below;
  return ((beaten + (equal - 1) / 2) / (all.length - 1)) * 100;
}
