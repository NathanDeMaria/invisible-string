import type { TeamRow } from "../../services/api";
import { teamMetrics, type Standing } from "./teamMetrics";

interface Props {
  rows: TeamRow[];
  away: string;
  home: string;
  model: string;
}

/**
 * The two teams' ratings-table numbers, each with its place in the league.
 *
 * Away first, like the score and the other tables on this page. Null when
 * neither team has a metric, so a game between teams the model doesn't rate
 * has no empty grid.
 */
export function TeamMetrics({ rows, away, home, model }: Props) {
  const metrics = teamMetrics(rows, away, home);
  if (metrics.length === 0) return null;
  return (
    <>
      <h3>Team ratings</h3>
      <table className="ratings wp-table team-metrics">
        <caption className="sr-only">
          Each team&rsquo;s value on {model}&rsquo;s ratings, and its rank among
          the teams the model rates
        </caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col" className="num">
              {away}
            </th>
            <th scope="col" className="num">
              {home}
            </th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.label}>
              <th scope="row">{metric.label}</th>
              <Cell standing={metric.away} />
              <Cell standing={metric.home} />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Cell({ standing }: { standing: Standing | null }) {
  if (!standing) {
    return (
      <td className="num">
        <span className="quiet">&mdash;</span>
      </td>
    );
  }
  return (
    <td className="num">
      {standing.value}
      <span className="of">
        #{standing.rank} of {standing.of}
      </span>
    </td>
  );
}
