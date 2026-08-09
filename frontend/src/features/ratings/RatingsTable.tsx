import type { TeamRow } from "../../services/api";

interface Props {
  rows: TeamRow[];
  /** Glicko has a rating deviation; Elo doesn't, so the column is dropped. */
  showRd: boolean;
}

export function RatingsTable({ rows, showRd }: Props) {
  if (rows.length === 0) {
    return <p className="empty">No teams match that search.</p>;
  }

  return (
    <table className="ratings">
      <thead>
        <tr>
          <th scope="col" className="num">
            #
          </th>
          <th scope="col">Team</th>
          <th scope="col" className="num">
            Rating
          </th>
          {showRd && (
            <th scope="col" className="num">
              RD
            </th>
          )}
          <th scope="col" className="num">
            W&ndash;L
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.team}>
            <td className="num rank">{row.rank}</td>
            <td>{row.team}</td>
            <td className="num">{row.rating.toFixed(1)}</td>
            {showRd && <td className="num">{row.rd?.toFixed(1) ?? "—"}</td>}
            <td className="num">
              {row.wins}&ndash;{row.losses}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
