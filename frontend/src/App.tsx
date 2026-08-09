import { NavLink, Navigate, Route, Routes } from "react-router-dom";

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
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/ratings/mens" replace />} />
          <Route path="/ratings/:league" element={<RatingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
