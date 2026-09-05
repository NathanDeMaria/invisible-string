import type { WinProbabilityResponse } from "../../services/api";
import { biggestPlays, clockLabel } from "./curve";
import { perPlay } from "./format";

interface Props {
  curve: WinProbabilityResponse;
}

/**
 * What each offense did with the ball, in points per snap.
 *
 * The one number on this page that isn't about who won. Both control numbers
 * measure the game -- who was ahead of it, and who would have been with the
 * bounces split -- and this measures the football: expected points added per
 * snap, which is what a team did with the ball whatever the scoreboard said
 * about it. They genuinely disagree, and the disagreement is most of what
 * there is to say about a team that keeps winning close ones.
 *
 * **Two numbers per offense, side by side, because they answer different
 * questions.** Both average the same snaps and differ only in whether garbage
 * time is weighted out. The weighted one describes *this game* -- the closest
 * a whole-game number gets to what a team did while it was still in doubt --
 * and the flat one is the better estimate of *the team*, which is the column
 * to read if you're adding games up. Upstream measured the split and found no
 * setting that does both jobs, so the page shows both rather than picking one
 * and hiding the other.
 *
 * **Away first**, like the score and the matchup above it.
 *
 * **The sample is a column, not a footnote.** A game is ~130 snaps and a
 * blowout is fewer than that once the weighting is done with it, so "64 snaps,
 * 34 of them live" is part of the number rather than a caveat on it -- the
 * same job `GameControl.seconds` does for the pair above.
 */
export function EpaTable({ curve }: Props) {
  const epa = curve.epa;
  if (!epa) return null;
  const rows = [
    {
      team: curve.away,
      weighted: epa.away,
      flat: epa.away_unweighted,
      plays: epa.away_plays,
      weight: epa.away_weight,
    },
    {
      team: curve.home,
      weighted: epa.home,
      flat: epa.home_unweighted,
      plays: epa.home_plays,
      weight: epa.home_weight,
    },
  ];
  return (
    <table className="ratings wp-table epa-table">
      <caption className="sr-only">
        Each offense&rsquo;s expected points added per snap, weighted by how
        much the game was still in doubt and flat
      </caption>
      <thead>
        <tr>
          <th scope="col">Offense</th>
          <th scope="col" className="num">
            While it mattered
          </th>
          <th scope="col" className="num">
            Every snap
          </th>
          <th scope="col" className="num">
            Snaps
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.team}>
            <th scope="row">{row.team}</th>
            <td className="num">{perPlay(row.weighted)}</td>
            <td className="num quiet">{perPlay(row.flat)}</td>
            <td className="num">
              {row.plays}
              {/* What the weighted column is actually an average over. Not
                  a whole number, because a snap in a decided game counts for
                  a fraction of one rather than for none. */}
              <span className="of">{row.weight.toFixed(1)} live</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The snaps that moved expected points the most, which is the argument behind
 * the averages.
 *
 * The same job the scoring table does for the curve: a number nobody can
 * check is a number the page is asserting, and a game's worth of snaps is far
 * too many rows to be that check. So it is the short list, ranked on the
 * bounded number the averages are actually made of.
 *
 * **The bound is shown biting, not hidden.** A play the clip moved carries
 * its raw number underneath, so a reader looking at "+3.00" can see it was a
 * 70-yard touchdown worth five and a bit -- which is the whole argument for
 * bounding at all, and not something to make them take on trust.
 *
 * "Worth" is what the situation was worth to the offense before the snap, in
 * points on the scoreboard -- a first and ten at your own 25 is about a
 * point, first and goal at the 2 is about six -- and the EPA beside it is what
 * the snap did to that number.
 */
export function BigPlaysTable({ curve }: Props) {
  const plays = biggestPlays(curve.points, curve.epa?.plays ?? []);
  if (plays.length === 0) return null;
  return (
    <table className="ratings wp-table epa-table">
      <caption className="sr-only">
        The snaps that moved expected points the most, biggest first
      </caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Offense</th>
          <th scope="col" className="num">
            Worth
          </th>
          <th scope="col" className="num">
            EPA
          </th>
        </tr>
      </thead>
      <tbody>
        {plays.map(({ play, point }) => (
          <tr key={play.play_id}>
            <td>{clockLabel(point)}</td>
            <td>{play.offense_is_home ? curve.home : curve.away}</td>
            <td className="num quiet">{perPlay(play.expected_points)}</td>
            <td className="num">
              {perPlay(play.bounded)}
              {play.bounded !== play.epa && (
                <span className="of">{perPlay(play.epa)} unbounded</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
