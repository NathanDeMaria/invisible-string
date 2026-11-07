import { useMemo, useState } from "react";

import {
  useGetPlayerSeasonsQuery,
  useGetPlayersQuery,
} from "../../services/api";
import {
  activePlayers,
  BY_TOTAL,
  seasonLabel,
  sortPlayers,
  WITH_PLAYERS,
  type PlayerSort,
} from "../players/players";
import { PlayersTable } from "../players/PlayersTable";

/**
 * The team's players as they stand now, from the same file the Players page
 * reads, so it's usually already in hand. Always the current season, above the
 * page's season picker, which narrows only what's below it: no other season's
 * roster is "active".
 *
 * Nothing at all where there's nothing to say -- a league without player
 * ratings, a team from outside Division I, a file that didn't load. The rest
 * of the page stands without it.
 */
export function TeamPlayers({
  league,
  team,
}: {
  league: string;
  team: string;
}) {
  const rated = WITH_PLAYERS.has(league);
  const seasons = useGetPlayerSeasonsQuery(league, { skip: !rated });
  const season = seasons.data?.default_season ?? null;
  const players = useGetPlayersQuery(
    { league, season: season ?? 0 },
    { skip: season == null },
  );
  const [sort, setSort] = useState<PlayerSort>(BY_TOTAL);

  const rows = useMemo(
    () => sortPlayers(activePlayers(players.data?.players ?? [], team), sort),
    [players.data, team, sort],
  );

  if (rows.length === 0 || season == null) return null;

  return (
    <>
      <h3>Players</h3>
      <PlayersTable
        rows={rows}
        sort={sort}
        onSort={setSort}
        showTeam={false}
        caption={
          <>
            {seasonLabel(season)}
            {players.data?.as_of && <>, as of {players.data.as_of}</>}. Per 100
            possessions.
          </>
        }
      />
    </>
  );
}
