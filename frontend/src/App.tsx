import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";

import { LeagueLayout } from "./features/league/LeagueLayout";
import { MatchupPage } from "./features/matchup/MatchupPage";
import { RatingsPage } from "./features/ratings/RatingsPage";
import { useGetLeaguesQuery } from "./services/api";

/**
 * Keeps the old flat URLs working. `/ratings/mens` was linkable for a while --
 * the deploy smoke test still asks for it -- and a redirect is cheaper than
 * finding out later which bookmarks broke.
 */
function LegacyRedirect({ panel }: { panel: "ratings" | "matchup" }) {
  const { league = "mens" } = useParams();
  return <Navigate to={`/${league}/${panel}`} replace />;
}

export function App() {
  const { data: leagues } = useGetLeaguesQuery();
  const { pathname } = useLocation();

  // Changing league keeps the panel you were looking at. Sending someone
  // comparing two leagues' matchups back to the leaderboard every time would
  // make the outer tabs feel like they discard your place rather than move it.
  const panel = pathname.endsWith("/matchup") ? "matchup" : "ratings";

  return (
    <div className="app">
      <header>
        <h1>invisible string</h1>
        <nav aria-label="League">
          {(leagues ?? []).map((entry) => (
            <NavLink key={entry.league} to={`/${entry.league}/${panel}`}>
              {entry.league}
            </NavLink>
          ))}
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/mens/ratings" replace />} />

          {/* Declared before the /:league branch so a stale link can't be read
              as a league named "ratings". */}
          <Route
            path="/ratings/:league"
            element={<LegacyRedirect panel="ratings" />}
          />
          <Route
            path="/matchup/:league"
            element={<LegacyRedirect panel="matchup" />}
          />

          <Route path="/:league" element={<LeagueLayout />}>
            <Route index element={<Navigate to="ratings" replace />} />
            <Route path="ratings" element={<RatingsPage />} />
            <Route path="matchup" element={<MatchupPage />} />
          </Route>
        </Routes>
      </main>
    </div>
  );
}
