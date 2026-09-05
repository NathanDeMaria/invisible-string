import type { WinProbabilityResponse } from "../../services/api";
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
