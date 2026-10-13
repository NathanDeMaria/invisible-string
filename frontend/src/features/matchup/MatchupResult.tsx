import type { PredictResponse } from "../../services/api";
import { NOTABLE_PUSH, SHOW_COVER_PROB, coverSide } from "../games/ats";
import { spread } from "../games/format";
import { favouriteLine } from "./spread";

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export function MatchupResult({
  prediction,
  line: stated = null,
}: {
  prediction: PredictResponse;
  /** The line the reader typed, from the home side, if they typed one. */
  line?: number | null;
}) {
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

      {stated != null && (
        <AgainstTheLine prediction={prediction} line={stated} />
      )}

      <p className="meta" data-testid="matchup-meta">
        {prediction.model} &middot; run {prediction.run_id}
        {prediction.neutral ? " · neutral site" : ""}
      </p>
    </div>
  );
}

/**
 * The line the reader typed, priced: cover, push and lose.
 *
 * The cover and lose numbers sit behind `SHOW_COVER_PROB`, for the reason
 * given there -- against real lines they are overconfident, so until
 * cassandra's market-aware version ships this names the likelier side
 * without a percentage. The push is shown either way: it comes from the
 * kernel's shape, not from the model's opinion of these two teams.
 *
 * A release with no margin kernel can't price a line at all, and says so
 * rather than leaving the reader wondering where the numbers went.
 */
function AgainstTheLine({
  prediction,
  line,
}: {
  prediction: PredictResponse;
  line: number;
}) {
  const { home, away, home_cover_prob, away_cover_prob, push_prob } =
    prediction;
  if (home_cover_prob == null || away_cover_prob == null) {
    return (
      <p className="meta" data-testid="matchup-cover">
        This release carries no margin kernel, so it can&rsquo;t price {home}{" "}
        {spread(line)}.
      </p>
    );
  }

  const push = push_prob ?? 0;
  const side = coverSide(home_cover_prob, away_cover_prob);

  return (
    <div data-testid="matchup-cover">
      {SHOW_COVER_PROB ? (
        <table>
          <tbody>
            <tr>
              <th scope="row">
                {home} covers {spread(line)}
              </th>
              <td>{pct(home_cover_prob)}</td>
            </tr>
            <tr>
              <th scope="row">Push</th>
              <td>{pct(push)}</td>
            </tr>
            <tr>
              <th scope="row">
                {away} covers {spread(-line)}
              </th>
              <td>{pct(away_cover_prob)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p>
          {side === null
            ? `At ${home} ${spread(line)}, the model has the two sides even.`
            : side === "home"
              ? `At ${home} ${spread(line)}, the model makes ${home} the likelier side to cover.`
              : `At ${home} ${spread(line)}, the model makes ${away} the likelier side to cover.`}
          {push >= NOTABLE_PUSH && (
            <> {pct(push)} of games like this land exactly on the number.</>
          )}
        </p>
      )}
      <p className="meta">
        The model&rsquo;s probabilities, not betting advice.
      </p>
    </div>
  );
}
