import { useRef, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";

import { GamePage } from "./features/games/GamePage";
import { GamesPage } from "./features/games/GamesPage";
import { JobsPage } from "./features/jobs/JobsPage";
import { ShortcutsDialog } from "./features/keys/ShortcutsDialog";
import { useKeyboard } from "./features/keys/useKeyboard";
import { LeagueLayout } from "./features/league/LeagueLayout";
import { MatchupPage } from "./features/matchup/MatchupPage";
import { RatingsPage } from "./features/ratings/RatingsPage";
import { TeamPage } from "./features/team/TeamPage";
import { useGetLeaguesQuery } from "./services/api";

export function App() {
  const { data: leagues } = useGetLeaguesQuery();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);

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

  // Which league `r` and `m` mean. Every page that is about one says so
  // somewhere -- in the path under the league tabs, in the path of a game,
  // in the games page's filter -- and the ones that aren't about any (jobs,
  // an unfiltered slate) should send you back to the league you were last
  // looking at rather than to the default one.
  //
  // Written during render, like the games page's last-rendered day and for
  // the same reason: an effect would settle it a pass late, which here is a
  // keystroke that goes to the wrong league the first time it's pressed.
  const remembered = useRef("mens");
  const here = leagueIn(pathname, search);
  if (here) remembered.current = here;
  const league = remembered.current;

  // The section keys. Held off while the help sheet is open, which has only
  // one key of its own and shouldn't have every other one firing behind it.
  useKeyboard(
    {
      g: () => navigate("/games"),
      r: () => navigate(`/${league}/ratings`),
      m: () => navigate(`/${league}/matchup`),
      j: () => navigate("/jobs"),
      "?": () => setHelpOpen(true),
      // A league a press at a time, in the order the tabs are in. Only under
      // Ratings: on the games page the same digits pick the league *filter*,
      // which is that page's own binding, and on /jobs there is no league to
      // pick.
      ...(section === "ratings" ? leagueKeys(leagues, panel, navigate) : {}),
    },
    !helpOpen,
  );

  return (
    <div className="app">
      <header>
        <div className="titlebar">
          <h1>invisible string</h1>
          {/* The sheet is reachable by mouse too. A set of shortcuts whose
              only way in is one of the shortcuts is a set most readers never
              find out about. */}
          <button
            type="button"
            className="keys-hint"
            aria-haspopup="dialog"
            onClick={() => setHelpOpen(true)}
          >
            <kbd>?</kbd> Shortcuts
          </button>
        </div>
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
            {/* A team is a detail of its league, so it sits under the league's
                layout and keeps the panel nav that leads back to the
                leaderboard it was reached from. Encoded in the path rather
                than a query param: it names the page. */}
            <Route path="teams/:team" element={<TeamPage />} />
          </Route>
        </Routes>
      </main>

      {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

/**
 * The league a URL is about, or null where it is about none.
 *
 * The games page is two of those cases at once: a game's path names its
 * league, and the slate's `?league=` names the one being looked at. Both are
 * a league the reader is currently in, which is all this is asked for.
 */
function leagueIn(pathname: string, search: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "games") {
    return parts[1] ?? new URLSearchParams(search).get("league") ?? null;
  }
  if (!parts[0] || parts[0] === "jobs") return null;
  return parts[0];
}

/**
 * `1` through `9`, bound to the league tabs in the order they're drawn.
 *
 * The panel comes along for the ride, for the same reason the tabs carry it:
 * switching league while comparing two matchups should land on the matchup.
 * A digit past the end of the list binds to nothing rather than to the last
 * league, so a tenth press does nothing instead of something surprising.
 */
function leagueKeys(
  leagues: { league: string }[] | undefined,
  panel: string,
  go: (to: string) => void,
): Record<string, () => void> {
  const bindings: Record<string, () => void> = {};
  (leagues ?? []).slice(0, 9).forEach((entry, index) => {
    bindings[String(index + 1)] = () => go(`/${entry.league}/${panel}`);
  });
  return bindings;
}
