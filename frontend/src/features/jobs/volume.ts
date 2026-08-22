import type { OddsDay } from "../../services/api";

export interface LeagueOdds {
  league: string;
  /** Objects written across the whole window, not just the newest day. */
  pulls: number;
  bytes: number;
  latestAt: string | null;
  /** Entries in the newest pull. Null when it couldn't be opened. */
  latestRecords: number | null;
  /** Newest day first, for the sparkline-ish per-day counts. */
  days: OddsDay[];
}

/**
 * The volume endpoint answers per league *per day*; the table shows one row
 * per league.
 *
 * Rolling up here rather than in the API keeps the per-day numbers available
 * -- "13 pulls a day all week, and 2 today" is the shape of an odds job that
 * has quietly stopped, and it's invisible in a weekly total.
 */
export function byLeague(odds: OddsDay[]): LeagueOdds[] {
  const leagues = new Map<string, LeagueOdds>();

  for (const day of odds) {
    const entry = leagues.get(day.league) ?? {
      league: day.league,
      pulls: 0,
      bytes: 0,
      latestAt: null,
      latestRecords: null,
      days: [],
    };

    entry.pulls += day.pulls;
    entry.bytes += day.bytes;
    entry.days.push(day);
    if (day.latest_at && (!entry.latestAt || day.latest_at > entry.latestAt)) {
      entry.latestAt = day.latest_at;
      // Only the newest pull in the window is opened and counted, so the
      // record count travels with the timestamp it belongs to rather than
      // being picked up from whichever day happened to have one.
      entry.latestRecords = day.latest_records ?? null;
    }
    leagues.set(day.league, entry);
  }

  for (const entry of leagues.values()) {
    entry.days.sort((a, b) => b.day.localeCompare(a.day));
  }

  return [...leagues.values()].sort((a, b) => a.league.localeCompare(b.league));
}
