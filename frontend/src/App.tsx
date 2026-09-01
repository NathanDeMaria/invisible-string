import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { GamePage } from "./features/games/GamePage";
import { GamesPage } from "./features/games/GamesPage";
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
          {/* Neither of these is a league tab or a panel: a night's games
              span every league and job health belongs to none, so putting
              either in either nav would say they sit under a league. */}
          <div className="utilities">
            <NavLink to="/games" className="utility">
              Games
            </NavLink>
            <NavLink to="/jobs" className="utility">
              Job health
            </NavLink>
          </div>
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
              segment outranks a dynamic one, so neither of these is ever
              read as a league. */}
          <Route path="/games" element={<GamesPage />} />
          {/* Under /games rather than under the league tabs, because
              that is where it is reached from and what "back" should
              mean -- a game belongs to a night, and the nav above nests
              panels under a league. */}
          <Route path="/games/:league/:gameId" element={<GamePage />} />
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
