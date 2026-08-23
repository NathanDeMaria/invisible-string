import type { OddsDay, SeasonObject } from "../../services/api";
import { ago, size } from "./format";
import { byLeague } from "./volume";

interface Props {
  odds: OddsDay[];
  seasons: SeasonObject[];
  days: number;
}

/**
 * What the jobs actually brought back.
 *
 * Two tables rather than one, because the two halves aren't the same kind of
 * number and shouldn't be columns of each other (DESIGN.md §12.4). Odds are
 * counted; seasons are measured.
 */
export function DataVolume({ odds, seasons, days }: Props) {
  const leagues = byLeague(odds);

  return (
    <>
      <h3>Odds pulled</h3>
      {leagues.length === 0 ? (
        <p className="empty">No odds objects in this window.</p>
      ) : (
        <table className="ratings jobs">
          <thead>
            <tr>
              <th scope="col">League</th>
              <th scope="col" className="num">
                Pulls / {days}d
              </th>
              <th scope="col" className="num">
                Latest pull
              </th>
            </tr>
          </thead>
          <tbody>
            {leagues.map((entry) => (
              <tr key={entry.league}>
                <td>{entry.league}</td>
                <td className="num">{entry.pulls}</td>
                <td className="num">
                  {/* Zero records is a real answer and gets said out loud: an
                      odds job in the offseason succeeds every hour and brings
                      back nothing, and only this column can tell you. */}
                  <span className="rate">
                    {entry.latestRecords == null
                      ? "—"
                      : `${entry.latestRecords} odds`}
                  </span>
                  <span className="of">{ago(entry.latestAt)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Games pulled</h3>
      {seasons.length === 0 ? (
        <p className="empty">No season objects.</p>
      ) : (
        <table className="ratings jobs">
          <thead>
            <tr>
              <th scope="col">Season</th>
              <th scope="col" className="num">
                Games / {days}d
              </th>
              <th scope="col" className="num">
                Size
              </th>
              <th scope="col" className="num">
                Written
              </th>
            </tr>
          </thead>
          <tbody>
            {seasons.map((season) => (
              <tr key={season.key}>
                <td>
                  <span className="job-name">
                    {season.league} {season.year}
                  </span>
                  <span className="reason quiet">{season.artifact}</span>
                </td>
                <td className="num">
                  {/* Null for the CSVs beside each season, and for a file
                      that couldn't be read -- both of which still have a
                      size and a timestamp worth showing. */}
                  {season.games_in_window == null ? (
                    <span className="rate">&mdash;</span>
                  ) : (
                    <>
                      <span className="rate">{season.games_in_window}</span>
                      <span className="of">
                        {season.games_today ?? 0} today
                      </span>
                    </>
                  )}
                </td>
                <td className="num">{size(season.bytes)}</td>
                <td className="num">{ago(season.last_modified)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="meta">
        Games are counted by date out of the season file, and only completed
        ones: the file also carries the rest of the schedule, so an empty scrape
        would otherwise look like a full one. The CSVs beside each season are
        possession and box-score rows rather than games, so they show size
        alone.
      </p>
    </>
  );
}
