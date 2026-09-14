import type {
  LeagueDistributions,
  WinProbabilityResponse,
} from "../../services/api";
import { perPlay } from "./format";
import { percentileLabel, percentileOf } from "./percentile";
import { seasonRange } from "./curve";

interface Props {
  curve: WinProbabilityResponse;
  /**
   * The league's metric shapes, for saying where these numbers sit among
   * every other game. Undefined for a league with none published, and for the
   * moment before the request lands -- both of which drop the labels and
   * leave the table exactly as it was.
   */
  shapes?: LeagueDistributions;
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
export function EpaTable({ curve, shapes }: Props) {
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
            <td className="num">
              {perPlay(row.weighted)}
              {/* Under the number rather than in a column of its own, the way
                  the snap count carries its own denominator: it is the same
                  number said again in the league's terms, not a second
                  measurement. Only on this column -- the flat one is
                  explicitly the estimate of the *team* rather than of this
                  game, and a per-game percentile against it would be
                  answering a question the column isn't asking. */}
              <Percentile
                shapes={shapes}
                metric="epa_per_play"
                value={row.weighted}
              />
            </td>
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
 * Where one number sits in its league, as an ordinal.
 *
 * Renders nothing at all when it can't be placed -- no artifact for this
 * league, no distribution for this metric, no value to look up. That is the
 * ordinary case rather than the exceptional one (only football has these at
 * all), so the absence has to look like a table that was always this shape
 * rather than like something that failed to load.
 *
 * The population goes in the title. "83rd percentile" is a claim that means
 * nothing without what it is 83rd *of*, and the answer -- five seasons of
 * team-games -- is too long to print beside every number and too important to
 * drop.
 */
function Percentile({
  shapes,
  metric,
  value,
}: {
  shapes: LeagueDistributions | undefined;
  metric: string;
  value: number | null | undefined;
}) {
  const distribution = shapes?.metrics[metric];
  const label = percentileLabel(percentileOf(distribution?.values, value));
  if (!distribution || !label) return null;

  return (
    <span
      className="of"
      title={`${label} of ${distribution.n.toLocaleString()} ${distribution.unit}s, ${seasonRange(shapes.seasons)}`}
    >
      {label}
    </span>
  );
}
