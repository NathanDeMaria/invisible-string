import {
  Link,
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

  // Games and jobs span no league, or none in particular, so neither lives
  // under one -- they're sections in their own right, alongside ratings
  // rather than beneath it. Ratings is the odd one out: its own section is
  // every `/:league` route, not a fixed path, since the league (and panel)
  // stay in the URL rather than in this switch.
  const section = pathname.startsWith("/games")
    ? "games"
    : pathname === "/jobs"
      ? "jobs"
      : "ratings";

  return (
    <div className="app">
      <header>
        <h1>invisible string</h1>
        <nav aria-label="Section">
          <NavLink to="/games">Games</NavLink>
          <Link
            to={section === "ratings" ? pathname : "/mens/ratings"}
            className={section === "ratings" ? "active" : undefined}
          >
            Ratings
          </Link>
          <NavLink to="/jobs">Jobs</NavLink>
        </nav>
        {section === "ratings" && (
          <nav aria-label="League" className="panels">
            {(leagues ?? []).map((entry) => (
              <NavLink key={entry.league} to={`/${entry.league}/${panel}`}>
                {entry.league}
              </NavLink>
            ))}
          </nav>
        )}
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
