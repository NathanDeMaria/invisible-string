import type { GameRow } from "../../services/api";
import { probability, score, spread, statusLabel, tipoff } from "./format";

interface Props {
  games: GameRow[];
}

/**
 * One day's games: what's on, what the model says, what the market says, and
 * how it finished -- or, for a game with no result, what became of it.
 *
 * The two spread columns sit next to each other on purpose. Both are quoted
 * from the home team's side (DESIGN.md §13), so the gap between them is
 * readable straight off the row -- which is the only reason to put a model's
 * number beside a book's at all.
 */
export function GameTable({ games }: Props) {
  return (
    <table className="ratings games">
      <thead>
        <tr>
          <th scope="col">Game</th>
          <th scope="col" className="num">
            Model
          </th>
          <th scope="col" className="num">
            Line
          </th>
          <th scope="col" className="num">
            Result
          </th>
        </tr>
      </thead>
      <tbody>
        {games.map((game) => (
          <tr key={`${game.league}-${game.game_id}`}>
            <td>
              <span className="job-name">
                {game.away} {game.neutral ? "vs" : "@"} {game.home}
              </span>
              <span className="when">
                {game.league} &middot; {tipoff(game.start)}
              </span>
            </td>
            <td className="num">
              {game.prediction ? (
                <>
                  <span className="rate">
                    {spread(game.prediction.predicted_spread)}
                    {/* Releases are rebuilt nightly, so by the time a score
                        is on this page the model has usually trained on it.
                        Still worth showing, but not as a forecast. */}
                    {game.prediction.in_sample && (
                      <abbr
                        className="hindsight"
                        title="The model has already trained on this result"
                      >
                        †
                      </abbr>
                    )}
                  </span>
                  <span className="of">
                    {probability(game.prediction.home_win_prob)} home
                  </span>
                </>
              ) : (
                // A league with no published model, or a team this release
                // has never rated. The score and the line still earn the row.
                <span className="rate">&mdash;</span>
              )}
            </td>
            <td className="num">{spread(game.market_spread)}</td>
            <td className="num">
              {game.completed ? (
                <>
                  <span className="rate">
                    {score(game.away_score, game.home_score)}
                  </span>
                  <span className="of">{winner(game)}</span>
                </>
              ) : (
                // No score, and the useful part is *why* not. Most of these
                // are simply games that haven't been played, which the
                // tip-off beside them already says -- so those keep the dash,
                // and the ones a reader would otherwise wait on all evening
                // say what happened to them.
                <span className="rate quiet state">
                  {statusLabel(game.status) ?? <>&mdash;</>}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Who won, said out loud.
 *
 * The score reads away-first to match the matchup above it, which is one more
 * mapping than anyone should have to do to find out who won.
 */
function winner(game: GameRow): string {
  if (game.home_score == null || game.away_score == null) return "";
  if (game.home_score === game.away_score) return "tied";
  return game.home_score > game.away_score ? game.home : game.away;
}
