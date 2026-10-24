/**
 * Where each team in a game stands on the ratings table's own numbers.
 *
 * The same columns the leaderboard sorts on, read for two teams: the value,
 * and the place it earns among every team the model rates. "1612" doesn't say
 * whether that is good; "3rd of 134" does. Rank counts only teams that have
 * the metric, and a tie shares the better place, so two teams on the same
 * number never read as one ahead of the other.
 *
 * Direction comes from `METRICS`, the one place that knows a lower success
 * rate allowed is the better defense.
 */

import type { TeamRow } from "../../services/api";
import { leaguePercentile } from "../ratings/percentiles";
import { METRICS, metricValue, type Metric } from "../ratings/scatter";
import { percentileLabel } from "./percentile";

/** The metrics a game page reads, in the table's order. */
const SHOWN: Metric[] = [
  "rating",
  "offense",
  "defense",
  "offenseSuccess",
  "defenseSuccess",
  "offenseEpa",
  "defenseEpa",
  "offensePassSuccess",
  "defensePassSuccess",
  "offensePassEpa",
  "defensePassEpa",
  "offenseRunSuccess",
  "defenseRunSuccess",
  "offenseRunEpa",
  "defenseRunEpa",
];

export interface Standing {
  value: string;
  rank: number;
  of: number;
  /** Among the same teams, "91st", or null for a league of one. */
  percentile: string | null;
}

export interface MetricRow {
  label: string;
  away: Standing | null;
  home: Standing | null;
}

/**
 * One row per metric the model publishes for at least one of the two teams.
 * Empty when neither team is on the table (a retired franchise, a release that
 * never rated them), so the caller can drop the section rather than print a
 * grid of dashes.
 */
export function teamMetrics(
  rows: TeamRow[],
  away: string,
  home: string,
): MetricRow[] {
  const awayRow = rows.find((row) => row.team === away);
  const homeRow = rows.find((row) => row.team === home);
  const out: MetricRow[] = [];
  for (const metric of SHOWN) {
    const info = METRICS[metric];
    const all = rows
      .map((row) => metricValue(row, metric))
      .filter((value): value is number => value != null);
    const sorted = [...all].sort((a, b) => a - b);
    const stand = (row: TeamRow | undefined): Standing | null => {
      const value = row && metricValue(row, metric);
      if (value == null) return null;
      const better = all.filter((other) =>
        info.reversed ? other < value : other > value,
      ).length;
      return {
        value: info.format(value),
        rank: better + 1,
        of: all.length,
        percentile: percentileLabel(leaguePercentile(sorted, value, metric)),
      };
    };
    const standings = { away: stand(awayRow), home: stand(homeRow) };
    if (standings.away || standings.home) {
      out.push({ label: info.label, ...standings });
    }
  }
  return out;
}
