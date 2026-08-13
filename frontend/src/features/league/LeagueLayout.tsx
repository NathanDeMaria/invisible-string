import { NavLink, Outlet, useParams } from "react-router-dom";

/**
 * A league, and the panels you can look at it through.
 *
 * The nesting is the point: a league is the thing you pick first, and
 * leaderboard-vs-matchup is a view onto it. Flattening those into one row of
 * links made "mens" and "mens matchup" look like siblings when one contains the
 * other, and it grows badly -- every new panel multiplies by every league.
 *
 * The league stays in the URL rather than in redux so a panel switch keeps it,
 * and so both panels below can read it from `useParams` without either owning
 * it.
 */
export function LeagueLayout() {
  const { league = "mens" } = useParams();

  return (
    <section className="league">
      <h2>{league}</h2>

      <nav className="panels" aria-label="Panel">
        <NavLink to={`/${league}/ratings`}>Leaderboard</NavLink>
        <NavLink to={`/${league}/matchup`}>Matchup</NavLink>
      </nav>

      <Outlet />
    </section>
  );
}
