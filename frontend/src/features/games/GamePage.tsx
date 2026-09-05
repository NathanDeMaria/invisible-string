import { Link, useParams } from "react-router-dom";

import {
  useGetGameQuery,
  useGetWinProbabilityQuery,
  type GameDetail,
} from "../../services/api";
import { atsCall, atsTitle, edgeTitle, modelEdge } from "./ats";
import {
  adjustedControlLabel,
  epaLabel,
  luckLabel,
  seasonRange,
} from "./curve";
import { EpaTable } from "./Epa";
import {
  points as pointsOf,
  probability,
  score,
  spread,
  statusLabel,
  tipoff,
  zoneLabel,
} from "./format";
import {
  LuckyPlaysTable,
  ScoringTable,
  WinProbabilityChart,
} from "./WinProbabilityChart";

/**
 * One game, and everything this app has on it.
 *
 * The games table is a scoreboard -- four columns, a row a second to scan --
 * so the things it can't fit end up here: the two ratings behind the model's
 * number, which release said it, the week of the season the game belongs to,
 * and the shape of the game itself.
 *
 * **Two requests, not one** (DESIGN.md §16). The facts about the game come
 * from the season files and the curve comes from a parquet object under a
 * different prefix, and one being slow, missing or unreadable must not take
 * the other down. So the chart is its own query, asked only for a league that
 * has a fit, and its absence is a paragraph rather than an error.
 *
 * **Reached from the table, and linked back to the day it was on.** A game
 * page nobody can leave is a dead end, and "back" isn't the answer for a link
 * somebody sent you.
 */
export function GamePage() {
  const { league = "", gameId = "" } = useParams();
  const game = useGetGameQuery({ league, gameId });
  const detail = game.data;

  // Skipped until the game says a fit exists for its league -- only football
  // has one, and asking for a basketball game's curve is a request that can
  // only 404.
  const curve = useGetWinProbabilityQuery(
    { league, gameId },
    { skip: !detail?.has_win_probability },
  );

  if (game.isLoading) return <p className="loading">Loading&hellip;</p>;

  if (game.isError || !detail) {
    // A 404 here is the ordinary case rather than a broken page: the API
    // serves the week either side of today, so a link older than that has
    // outlived the window rather than pointed at nothing.
    return (
      <section className="game-page">
        <h2>Game</h2>
        <p className="error">
          No such game &mdash; the API serves the week either side of today, so
          a link older than that has outlived it.{" "}
          <Link to="/games">Back to the games.</Link>
        </p>
      </section>
    );
  }

  const ats = atsCall(detail);
  const edge = modelEdge(detail);
  const state = statusLabel(detail.status);

  return (
    <section className="game-page">
      <h2>Game</h2>

      <h3 className="game-title">
        {detail.away} {detail.neutral ? "vs" : "at"} {detail.home}
      </h3>
      <p className="meta">
        <Link to={`/games?day=${detail.day}&league=${detail.league}`}>
          {detail.league}
        </Link>{" "}
        &middot; {tipoff(detail.start)} {zoneLabel()} &middot;{" "}
        {detail.completed ? "Final" : (state ?? "Scheduled")}
        {detail.neutral && <> &middot; neutral site</>}
      </p>

      {/* The result, or the reason there isn't one. Big, because on a
          finished game it is the thing the page is about -- and on an
          unfinished one the absence is, which is why the state gets the same
          line rather than a footnote. */}
      <p className="line">
        {detail.completed ? (
          <>
            {score(detail.away_score, detail.home_score)}{" "}
            <span className="of">{winner(detail)}</span>
          </>
        ) : (
          <span className="quiet">{state ?? "Not played yet"}</span>
        )}
      </p>

      <dl className="facts">
        <div>
          <dt>The line</dt>
          <dd>
            {spread(detail.market_spread)}
            <span className="of">
              from {detail.home}&rsquo;s side, so negative means the home team
              lays the points
            </span>
          </dd>
        </div>

        {detail.prediction ? (
          <>
            <div>
              <dt>The model</dt>
              <dd>
                {spread(detail.prediction.predicted_spread)}
                {ats && (
                  <abbr className={`ats ${ats.result}`} title={atsTitle(ats)}>
                    {{ hit: "✓", miss: "✗", push: "=" }[ats.result]}
                  </abbr>
                )}
                <span className="of">
                  {probability(detail.prediction.home_win_prob)} {detail.home}
                  {detail.prediction.in_sample && (
                    <> &mdash; a result this release has already trained on</>
                  )}
                </span>
              </dd>
            </div>
            {edge && (
              <div>
                <dt>Disagreement</dt>
                <dd>
                  {edge.pick} +{pointsOf(edge.points)}
                  <span className="of">{edgeTitle(edge)}</span>
                </dd>
              </div>
            )}
            <div>
              <dt>Ratings</dt>
              <dd>
                {Math.round(detail.prediction.home_rating)} &ndash;{" "}
                {Math.round(detail.prediction.away_rating)}
                <span className="of">
                  {detail.home} and {detail.away}, on {detail.prediction.model}
                  &rsquo;s own scale
                </span>
              </dd>
            </div>
            <div>
              <dt>Release</dt>
              <dd>
                {detail.prediction.model}
                <span className="of">
                  run {detail.prediction.run_id} &mdash; the league&rsquo;s
                  lowest-Brier release
                </span>
              </dd>
            </div>
          </>
        ) : (
          <div>
            <dt>The model</dt>
            <dd>
              &mdash;
              <span className="of">
                no published release for {detail.league}, or one that has never
                rated these teams
              </span>
            </dd>
          </div>
        )}

        {detail.season !== null && detail.week !== null && (
          <div>
            <dt>Season</dt>
            <dd>
              {detail.season}, week {detail.week}
              <span className="of">
                where endgame filed this game, and where its play-by-play lives
              </span>
            </dd>
          </div>
        )}
      </dl>

      {detail.has_win_probability && (
        <>
          <h3>Win probability</h3>
          {curve.isLoading && <p className="loading">Loading&hellip;</p>}
          {curve.isError && (
            <p className="error">
              The play-by-play didn&rsquo;t load, so there&rsquo;s no curve for
              this game.
            </p>
          )}
          {curve.data &&
            (curve.data.points.length === 0 ? (
              // The normal case for most of a college week, and for every
              // game that hasn't kicked off. Not an error, and it says which
              // of the two it is as far as it can tell.
              <p className="empty">
                No play-by-play for this game
                {detail.completed
                  ? " — ESPN has none, or the week hasn’t been processed yet."
                  : " yet — it hasn’t been played."}
              </p>
            ) : (
              <>
                <WinProbabilityChart curve={curve.data} />
                <p className="meta">
                  {adjustedControlLabel(
                    curve.data.control,
                    curve.data.adjusted_control,
                    curve.data.home,
                  )}
                  . Read either as a share of the game held, not as a win
                  probability: they are the average of the lines above, weighted
                  by how long each reading stood.
                </p>
                <p className="meta">
                  {luckLabel(
                    curve.data.luck,
                    curve.data.home,
                    curve.data.away,
                  ) ??
                    "Nothing in this game turned on a bounce the model can price"}
                  . That is a total of win probability rather than a share, so
                  the two sides don&rsquo;t add up to anything &mdash; it says
                  how big the breaks were, where the pair above says what the
                  game looks like without them.
                  {!curve.data.records_defended_passes && (
                    <>
                      {" "}
                      This game&rsquo;s play-by-play doesn&rsquo;t record the
                      passes a defender got to, so only the fumbles are split
                      here: charging a defense for the interceptions it made
                      without crediting the balls it got a hand on would be
                      worse than leaving them both alone.
                    </>
                  )}
                </p>
                <ScoringTable curve={curve.data} />
                <LuckyPlaysTable curve={curve.data} />
                <p className="meta">
                  Drawn by the-lucky-ones&rsquo; {curve.data.fit.league} fit,
                  run {curve.data.fit.run_id} &mdash; fit on{" "}
                  {seasonRange(curve.data.fit.seasons)} (
                  {curve.data.fit.n_games.toLocaleString()} games), Brier{" "}
                  {curve.data.fit.brier_score.toFixed(3)} on games it was held
                  out of.
                  {curve.data.trained_on_this_season && (
                    <>
                      {" "}
                      That range includes this game&rsquo;s season, so the fit
                      has seen games like this one &mdash; though not
                      necessarily this one, which it may have held out.
                    </>
                  )}{" "}
                  Which side is home is inferred from the scoring drives, since
                  nothing in the play data says: {
                    curve.data.home_team_id
                  } for {curve.data.home}.
                </p>

                {curve.data.epa && (
                  <>
                    <h3>EPA per play</h3>
                    <p className="meta">
                      {epaLabel(
                        curve.data.epa,
                        curve.data.home,
                        curve.data.away,
                      )}
                      . Expected points added is what a snap did to the value of
                      the situation &mdash; the one number here that
                      doesn&rsquo;t care who won, which is why it can disagree
                      with the shares above.
                    </p>
                    <EpaTable curve={curve.data} />
                    <p className="meta">
                      The first column weights each snap by how much the game
                      was still in doubt, so it describes <em>this game</em>;
                      the second counts every snap once, which is the one to add
                      up across a season. Both cap a single snap at three points
                      either way, so a pick-six is the biggest play of the game
                      rather than five of them. Neither is a share: they are two
                      averages over two different sets of snaps, in points, so
                      they don&rsquo;t add up to anything and both offenses can
                      be positive in a game where everybody moved the ball.
                    </p>
                    {curve.data.expected_points_fit && (
                      <p className="meta">
                        Priced by the-lucky-ones&rsquo;{" "}
                        {curve.data.expected_points_fit.league} expected points
                        fit, run {curve.data.expected_points_fit.run_id} &mdash;
                        a second fit from the one that drew the curve, on{" "}
                        {seasonRange(curve.data.expected_points_fit.seasons)} (
                        {curve.data.expected_points_fit.n_games.toLocaleString()}{" "}
                        games). It misses the next score by{" "}
                        {curve.data.expected_points_fit.mean_absolute_error.toFixed(
                          1,
                        )}{" "}
                        points on an average snap, which is large on purpose
                        &mdash; the next score is 7 or 0 or &minus;3 and the fit
                        says 2.1. That is why the numbers above are per-play
                        averages and not per-play claims.
                      </p>
                    )}
                  </>
                )}
              </>
            ))}
        </>
      )}
    </section>
  );
}

/** Who won, said out loud -- away-first, like the score beside it. */
function winner(game: GameDetail): string {
  if (game.home_score == null || game.away_score == null) return "";
  if (game.home_score === game.away_score) return "tied";
  return `${game.home_score > game.away_score ? game.home : game.away} won`;
}
