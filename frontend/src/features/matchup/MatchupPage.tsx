import { useParams, useSearchParams } from "react-router-dom";

import { usePredictQuery, useGetRatingsQuery } from "../../services/api";
import { MatchupResult } from "./MatchupResult";

/**
 * "What if these two played?"
 *
 * The selections live in the query string rather than in redux, because a
 * matchup is a shareable, linkable thing (DESIGN.md section 3) -- the URL is
 * the state, so a link reproduces exactly what someone was looking at. RTK
 * Query caches each combination, so flipping back to a previous pair is
 * instant and hits nothing.
 */
export function MatchupPage() {
  const { league = "mens" } = useParams();
  const [params, setParams] = useSearchParams();

  const home = params.get("home") ?? "";
  const away = params.get("away") ?? "";
  const neutral = params.get("neutral") === "1";

  // The ratings response is also the team list: it names exactly the teams
  // this release can predict, so the pickers can't offer one the API would
  // 404 on.
  const ratings = useGetRatingsQuery({ league });
  const teams = (ratings.data?.ratings ?? []).map((row) => row.team);

  const prediction = usePredictQuery(
    { league, home, away, neutral },
    { skip: !home || !away || home === away },
  );

  const update = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === null) merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged, { replace: true });
  };

  return (
    <>
      <div className="controls">
        <label>
          Home
          <select
            aria-label="Home team"
            value={home}
            onChange={(e) => update({ home: e.target.value || null })}
          >
            <option value="">Pick a team</option>
            {teams.map((team) => (
              <option key={team} value={team}>
                {team}
              </option>
            ))}
          </select>
        </label>

        <label>
          Away
          <select
            aria-label="Away team"
            value={away}
            onChange={(e) => update({ away: e.target.value || null })}
          >
            <option value="">Pick a team</option>
            {teams.map((team) => (
              <option key={team} value={team}>
                {team}
              </option>
            ))}
          </select>
        </label>

        <label>
          <input
            type="checkbox"
            checked={neutral}
            aria-label="Neutral site"
            onChange={(e) => update({ neutral: e.target.checked ? "1" : null })}
          />
          Neutral site
        </label>
      </div>

      {home && away && home === away && (
        <p className="error">Pick two different teams.</p>
      )}

      {prediction.isError && (
        <p className="error">Couldn&rsquo;t predict that matchup.</p>
      )}

      {prediction.data && <MatchupResult prediction={prediction.data} />}
    </>
  );
}
