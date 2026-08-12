import { NavLink, Navigate, Route, Routes } from "react-router-dom";

import { MatchupPage } from "./features/matchup/MatchupPage";
import { RatingsPage } from "./features/ratings/RatingsPage";
import { useGetLeaguesQuery } from "./services/api";

export function App() {
  const { data: leagues } = useGetLeaguesQuery();

  return (
    <div className="app">
      <header>
        <h1>invisible string</h1>
        <nav>
          {(leagues ?? []).map((entry) => (
            <NavLink key={entry.league} to={`/ratings/${entry.league}`}>
              {entry.league}
            </NavLink>
          ))}
          {(leagues ?? []).map((entry) => (
            <NavLink
              key={`matchup-${entry.league}`}
              to={`/matchup/${entry.league}`}
            >
              {entry.league} matchup
            </NavLink>
          ))}
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/ratings/mens" replace />} />
          <Route path="/ratings/:league" element={<RatingsPage />} />
          <Route path="/matchup/:league" element={<MatchupPage />} />
        </Routes>
      </main>
    </div>
  );
}
