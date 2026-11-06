import { useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { useKeyboard } from "../keys/useKeyboard";
import { useGetPlayersQuery, type PlayerRow } from "../../services/api";
import {
  BY_TOTAL,
  DEFAULT_FLOOR,
  filterPlayers,
  nextSort,
  perGame,
  seasonLabel,
  sortPlayers,
  type PlayerSort,
  type PlayerSortKey,
} from "./players";

/**
 * About 3,500 players clear the floor in a season, and a leaderboard is read
 * from the top. Drawing the rest only when asked keeps a re-sort instant.
 */
const FIRST_ROWS = 250;

const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;

export function PlayersPage() {
  const { league = "mens" } = useParams();
  // The season lives in the URL, so a link to last year stays last year; no
  // parameter means whichever is current when it's opened.
  const [params, setParams] = useSearchParams();
  const asked = Number(params.get("season")) || undefined;
  const players = useGetPlayersQuery({ league, season: asked });

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

  if (players.isError) {
    return <p className="error">Couldn&rsquo;t load the players.</p>;
  }
  if (players.isLoading) return <p className="loading">Loading&hellip;</p>;
  if (!players.data?.seasons.length) {
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
            value={players.data.season ?? ""}
            onChange={(e) => {
              const season = Number(e.target.value);
              setParams(
                season === players.data?.default_season
                  ? {}
                  : { season: String(season) },
              );
            }}
          >
            {[...players.data.seasons].reverse().map((season) => (
              <option key={season} value={season}>
                {seasonLabel(season)}
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
        {players.data.as_of && <> &middot; as of {players.data.as_of}</>}{" "}
        &middot; points per 100 possessions
      </p>

      {rows.length === 0 ? (
        <p className="empty">No players match that.</p>
      ) : (
        <div className="table-scroll">
          <table className="ratings players">
            <thead>
              <tr>
                <Header
                  column="player"
                  label="Player"
                  text
                  className="team"
                  sort={sort}
                  on={setSort}
                />
                <Header column="total" label="Total" sort={sort} on={setSort} />
                <Header
                  column="total_sd"
                  label={
                    <abbr title="How sure the total is: one standard deviation">
                      ±
                    </abbr>
                  }
                  sort={sort}
                  on={setSort}
                />
                <Header column="offense" label="Off" sort={sort} on={setSort} />
                <Header column="defense" label="Def" sort={sort} on={setSort} />
                <Header
                  column="vs_team"
                  label={
                    <abbr title="The total without the fifth of it that's his team's rating">
                      vs Team
                    </abbr>
                  }
                  sort={sort}
                  on={setSort}
                />
                <Header
                  column="team"
                  label="Team"
                  text
                  sort={sort}
                  on={setSort}
                />
                <Header column="games" label="G" sort={sort} on={setSort} />
                <Header column="starts" label="GS" sort={sort} on={setSort} />
                <Header
                  column="per_game"
                  label={<abbr title="Minutes a game">MPG</abbr>}
                  sort={sort}
                  on={setSort}
                />
                <Header
                  column="share"
                  label={
                    <abbr title="Share of the team's minutes on the floor; projected for someone yet to play">
                      Share
                    </abbr>
                  }
                  sort={sort}
                  on={setSort}
                />
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <Row key={`${row.athlete_id}-${row.team_id}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!all && rows.length > FIRST_ROWS && (
        <button type="button" className="show-all" onClick={() => setAll(true)}>
          Show all {rows.length.toLocaleString()}
        </button>
      )}
    </>
  );
}

function Row({ row }: { row: PlayerRow }) {
  const minutes = perGame(row);
  return (
    <tr className={row.projected ? "projected" : undefined}>
      <td className="team">
        {row.player ?? "Unnamed"}
        {row.projected && (
          <abbr
            className="tag"
            title="Hasn't played: rated on his prior, at projected minutes"
          >
            proj
          </abbr>
        )}
      </td>
      <td className="num">{signed(row.total)}</td>
      <td className="num">{row.total_sd.toFixed(1)}</td>
      <td className="num" title={`± ${row.offense_sd.toFixed(1)}`}>
        {signed(row.offense)}
      </td>
      <td className="num" title={`± ${row.defense_sd.toFixed(1)}`}>
        {signed(row.defense)}
      </td>
      <td className="num">{signed(row.vs_team)}</td>
      <td>{row.team ?? ""}</td>
      <td className="num">{row.projected ? "" : (row.games ?? "")}</td>
      <td className="num">{row.projected ? "" : (row.starts ?? "")}</td>
      <td className="num">{minutes == null ? "" : minutes.toFixed(1)}</td>
      <td className="num">
        {row.share == null ? "" : `${(row.share * 100).toFixed(0)}%`}
      </td>
    </tr>
  );
}

function Header({
  column,
  label,
  text = false,
  className,
  sort,
  on,
}: {
  column: PlayerSortKey;
  label: ReactNode;
  /** A column of words rather than numbers, aligned to the left. */
  text?: boolean;
  className?: string;
  sort: PlayerSort;
  on: (next: PlayerSort) => void;
}) {
  const active = sort.key === column;
  return (
    <th
      scope="col"
      className={
        [text ? null : "num", className].filter(Boolean).join(" ") || undefined
      }
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <button
        type="button"
        className="sort"
        onClick={() => on(nextSort(sort, column))}
      >
        {label}
        {active && (
          <span className="arrow" aria-hidden="true">
            {sort.direction === "asc" ? "▲" : "▼"}
          </span>
        )}
      </button>
    </th>
  );
}
