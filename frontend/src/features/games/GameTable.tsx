import type { GameRow } from "../../services/api";
import { type AtsResult, atsCall, atsTitle, edgeTitle, modelEdge } from "./ats";
import {
  points,
  probability,
  score,
  spread,
  statusLabel,
  tipoff,
} from "./format";

/**
 * The mark a finished game's line earns the model.
 *
 * A glyph and a colour, not a colour alone: the three read apart in
 * greyscale, in either theme, and to anyone who doesn't see the green. Each
 * carries the full sentence in its title, and the note under the tables says
 * what they are -- a marker nobody can decode is worse than no marker.
 */
const ATS_MARK: Record<AtsResult, string> = {
  hit: "✓",
  miss: "✗",
  push: "=",
};

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
 * number beside a book's at all. That gap is stated under the book's number
 * rather than left as a subtraction, and once the game is final it has an
 * answer: the mark beside the model's number is it.
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
        {games.map((game) => {
          // The grade belongs to the model's number rather than to the score:
          // it is a judgement on the gap between the two spread columns, and
          // that gap is the model's, not the game's.
          const ats = atsCall(game);
          // The same disagreement the mark grades, said before there's
          // anything to grade -- which is the state most of this page is in.
          const edge = modelEdge(game);
          return (
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
                      {/* Releases are rebuilt nightly, so by the time a
                          score is on this page the model has usually trained
                          on it. Still worth showing, but not as a forecast. */}
                      {game.prediction.in_sample && (
                        <abbr
                          className="hindsight"
                          title="The model has already trained on this result"
                        >
                          †
                        </abbr>
                      )}
                      {/* Whether that number beat the one beside it, once
                          there's a result to say so. A game with no line, no
                          result, or a model that agrees with the book gets
                          no mark -- see `atsCall`. */}
                      {ats && (
                        <abbr
                          className={`ats ${ats.result}`}
                          title={atsTitle(ats)}
                        >
                          {ATS_MARK[ats.result]}
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
              <td className="num">
                <span className="rate">{spread(game.market_spread)}</span>
                {/* How far the model's number is from this one, and which
                    side that favours. "home +4" is the model giving the home
                    team four points more than the book does -- the same
                    shorthand as the "63% home" beside it, and the sign means
                    what it means in the columns above: points *to* that side.
                    The note under the tables decodes it. */}
                {edge && (
                  <span className="of">
                    <abbr className="edge" title={edgeTitle(edge)}>
                      {edge.home ? "home" : "away"} +{points(edge.points)}
                    </abbr>
                  </span>
                )}
              </td>
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
          );
        })}
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
