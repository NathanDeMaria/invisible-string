import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { LeagueLayout } from "./features/league/LeagueLayout";
import { MatchupPage } from "./features/matchup/MatchupPage";
import { RatingsPage } from "./features/ratings/RatingsPage";
import { useGetLeaguesQuery } from "./services/api";

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
