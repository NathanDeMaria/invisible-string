import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { JobsPage } from "./features/jobs/JobsPage";
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
        <div className="masthead">
          <h1>invisible string</h1>
          {/* Not a league tab and not a panel: job health belongs to no
              league, so putting it in either nav would say it does. */}
          <NavLink to="/jobs" className="utility">
            Job health
          </NavLink>
        </div>
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
          {/* Above `/:league` by route ranking, not by order: a static
              segment outranks a dynamic one, so /jobs is never a league. */}
          <Route path="/jobs" element={<JobsPage />} />
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
