import { useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { useKeyboard } from "../keys/useKeyboard";
import {
  useGetPlayerSeasonsQuery,
  useGetPlayersQuery,
} from "../../services/api";
import {
  BY_TOTAL,
  DEFAULT_FLOOR,
  filterPlayers,
  seasonLabel,
  sortPlayers,
  type PlayerSort,
} from "./players";
import { PlayersTable } from "./PlayersTable";

/**
 * About 3,500 players clear the floor in a season, and a leaderboard is read
 * from the top. Drawing the rest only when asked keeps a re-sort instant.
 */
const FIRST_ROWS = 250;

export function PlayersPage() {
  const { league = "mens" } = useParams();
  // The season lives in the URL, so a link to last year stays last year; no
  // parameter means whichever is current when it's opened.
  const [params, setParams] = useSearchParams();
  const seasons = useGetPlayerSeasonsQuery(league);
  const season =
    Number(params.get("season")) || seasons.data?.default_season || null;
  const players = useGetPlayersQuery(
    { league, season: season ?? 0 },
    { skip: season == null },
  );

  const [search, setSearch] = useState("");
  const [floor, setFloor] = useState(DEFAULT_FLOOR);
  const [sort, setSort] = useState<PlayerSort>(BY_TOTAL);
  const [all, setAll] = useState(false);

  const filter = useRef<HTMLInputElement>(null);
  useKeyboard({ "/": () => filter.current?.focus() });

  const rows = useMemo(
    () =>
      sortPlayers(
        filterPlayers(players.data?.players ?? [], search, floor),
        sort,
      ),
    [players.data, search, floor, sort],
  );
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);

  if (seasons.isError || players.isError) {
    return <p className="error">Couldn&rsquo;t load the players.</p>;
  }
  if (seasons.isLoading) return <p className="loading">Loading&hellip;</p>;
  if (!seasons.data?.seasons.length) {
    return <p className="empty">No player ratings for {league} yet.</p>;
  }

  return (
    <>
      <div className="controls">
        <input
          ref={filter}
          type="search"
          placeholder="Filter by player or team"
          aria-label="Filter by player or team"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label>
          Season
          <select
            value={season ?? ""}
            onChange={(e) => {
              const picked = Number(e.target.value);
              setParams(
                picked === seasons.data?.default_season
                  ? {}
                  : { season: String(picked) },
              );
            }}
          >
            {[...seasons.data.seasons].reverse().map((option) => (
              <option key={option} value={option}>
                {seasonLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min share of team minutes (%)
          <input
            type="number"
            min={0}
            max={100}
            value={floor}
            onChange={(e) => setFloor(Number(e.target.value) || 0)}
          />
        </label>
      </div>

      <p className="meta" data-testid="players-meta">
        {rows.length.toLocaleString()} players
        {players.data?.as_of && <> &middot; as of {players.data.as_of}</>}{" "}
        &middot; points per 100 possessions
      </p>

      {players.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : rows.length === 0 ? (
        <p className="empty">No players match that.</p>
      ) : (
        <PlayersTable rows={shown} sort={sort} onSort={setSort} />
      )}

      {!all && rows.length > FIRST_ROWS && (
        <button type="button" className="show-all" onClick={() => setAll(true)}>
          Show all {rows.length.toLocaleString()}
        </button>
      )}
    </>
  );
}
