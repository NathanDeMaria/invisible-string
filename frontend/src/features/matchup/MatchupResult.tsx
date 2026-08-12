import type { PredictResponse } from "../../services/api";
import { favouriteLine } from "./spread";

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export function MatchupResult({ prediction }: { prediction: PredictResponse }) {
  const line = favouriteLine(prediction);

  return (
    <div className="matchup" data-testid="matchup-result">
      <p className="line" data-testid="matchup-line">
        {line ?? "No spread — this release carries no margin calibration."}
      </p>

      <table>
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col">Win probability</th>
            <th scope="col">Rating</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">
              {prediction.away} {prediction.neutral ? "" : "(away)"}
            </th>
            <td>{pct(prediction.away_win_prob)}</td>
            <td>{prediction.away_rating.toFixed(1)}</td>
          </tr>
          <tr>
            <th scope="row">
              {prediction.home} {prediction.neutral ? "" : "(home)"}
            </th>
            <td>{pct(prediction.home_win_prob)}</td>
            <td>{prediction.home_rating.toFixed(1)}</td>
          </tr>
        </tbody>
      </table>

      <p className="meta" data-testid="matchup-meta">
        {prediction.model} &middot; run {prediction.run_id}
        {prediction.neutral ? " · neutral site" : ""}
      </p>
    </div>
  );
}
