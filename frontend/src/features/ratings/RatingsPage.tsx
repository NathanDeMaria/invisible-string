import { useCallback, useMemo, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router-dom";

import type { RootState } from "../../app/store";
import { useKeyboard } from "../keys/useKeyboard";
import { useGetLeaguesQuery, useGetRatingsQuery } from "../../services/api";
import { weekEnding } from "./movement";
import { RatingsTable } from "./RatingsTable";
import { modelSelected, searchChanged } from "./uiSlice";

export function RatingsPage() {
  const { league = "mens" } = useParams();
  const dispatch = useDispatch();
  const { model, search } = useSelector((s: RootState) => s.ui);

  const leagues = useGetLeaguesQuery();
  const ratings = useGetRatingsQuery({ league, model: model ?? undefined });

  // The filter and the top of the table, which hand focus to each other: `/`
  // to type, Down to step into the names it left, Up from the first of them
  // to go back to typing. A leaderboard is a thing you narrow and then walk,
  // and those are the two halves of doing that without a mouse.
  const filter = useRef<HTMLInputElement>(null);
  const firstRow = useRef<HTMLTableRowElement>(null);
  const toFilter = useCallback(() => filter.current?.focus(), []);

  useKeyboard({
    "/": () => filter.current?.focus(),
  });

  const models =
    leagues.data?.find((entry) => entry.league === league)?.models ?? [];

  const rows = useMemo(() => {
    const all = ratings.data?.ratings ?? [];
    const needle = search.trim().toLowerCase();
    return needle
      ? all.filter((row) => row.team.toLowerCase().includes(needle))
      : all;
  }, [ratings.data, search]);

  // Elo has no rating deviation. Decide from the data rather than from the
  // model name, so a new predictor class doesn't need a change here.
  const showRd = (ratings.data?.ratings ?? []).some((row) => row.rd != null);

  // Same rule for the two halves of a team: only the compound Glicko rates
  // them, and asking the rows rather than the model name means a league that
  // starts publishing one gets the columns without a change here. Measured
  // over the whole table rather than the filtered rows, so typing into the
  // search box can't take a column away mid-scroll.
  const showUnits = (ratings.data?.ratings ?? []).some(
    (row) => row.offense != null || row.defense != null,
  );

  if (ratings.isError) {
    return <p className="error">No ratings published for {league} yet.</p>;
  }

  return (
    <>
      <div className="controls">
        <input
          ref={filter}
          type="search"
          placeholder="Filter teams"
          value={search}
          aria-label="Filter teams"
          onChange={(e) => dispatch(searchChanged(e.target.value))}
          onKeyDown={(e) => {
            // Down leaves the box for the rows it just narrowed, and Enter
            // does the same -- a filter you have finished typing into has
            // nothing else to submit, and the teams are what you wanted.
            if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              firstRow.current?.focus();
            }
            // Escape empties the filter rather than only leaving it, which is
            // what a search field's Escape means everywhere else. A second
            // press, on an already-empty box, gives the page back the keys.
            if (e.key === "Escape") {
              e.preventDefault();
              if (search) dispatch(searchChanged(""));
              else e.currentTarget.blur();
            }
          }}
        />
        <select
          aria-label="Model"
          value={model ?? ""}
          onChange={(e) => dispatch(modelSelected(e.target.value || null))}
        >
          <option value="">
            Default{models.length > 0 ? ` (${defaultName(models)})` : ""}
          </option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      {ratings.data && (
        <p className="meta" data-testid="run-meta">
          {ratings.data.model} &middot; through{" "}
          {ratings.data.trained_through.last_game_date?.slice(0, 10) ??
            `${ratings.data.trained_through.season_year} season`}{" "}
          &middot; Brier {ratings.data.metrics.brier_score.toFixed(4)} &middot;
          margin MAE {ratings.data.metrics.margin_mae.toFixed(1)}
          <MarketComparison metrics={ratings.data.metrics} />
          <Since at={ratings.data.movement_since?.date} />
        </p>
      )}

      {ratings.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : (
        <RatingsTable
          rows={rows}
          league={league}
          showRd={showRd}
          showUnits={showUnits}
          since={ratings.data?.movement_since?.date ?? null}
          firstRowRef={firstRow}
          onExitTop={toFilter}
        />
      )}
    </>
  );
}

/**
 * What the Week column is a week *from*.
 *
 * Said once, above the table, rather than in the column heading: the heading
 * has room for one word, and "since Jul 31" is the part a reader needs only
 * once. Absent entirely when nothing has movement -- a model published before
 * the history existed, or the first week of a season, where a heading
 * promising a comparison would be the only thing on the page claiming one.
 */
function Since({ at }: { at?: string | null }) {
  const day = weekEnding(at);
  if (!day) return null;
  return <> &middot; week since {day}</>;
}

function defaultName(models: { name: string; is_default: boolean }[]): string {
  return models.find((m) => m.is_default)?.name ?? models[0].name;
}

/**
 * How the model's margin error compares to the closing line's, on the games
 * that had one.
 *
 * `margin_mae` on its own says very little: it's measured over every game with
 * a final score, which is a different and much larger population than the ~20%
 * a book priced. The number worth showing is the *gap* between
 * `spread_game_margin_mae` and `market_margin_mae`, which are the model's error
 * and the market's over the same games.
 *
 * Both are null for a league with no odds coverage, so this renders nothing
 * rather than a misleading zero.
 */
function MarketComparison({
  metrics,
}: {
  metrics: {
    spread_game_margin_mae?: number | null;
    market_margin_mae?: number | null;
  };
}) {
  const mine = metrics.spread_game_margin_mae;
  const market = metrics.market_margin_mae;
  if (mine == null || market == null) return null;

  // Positive means the model is further from the truth than the market is.
  const gap = mine - market;
  // Below a tenth of a point the rounded numbers would read as a dead heat
  // with a direction attached, which overstates what the comparison supports.
  if (Math.abs(gap) < 0.05) {
    return <> &middot; level with the closing line</>;
  }
  return (
    <>
      {" "}
      &middot; {Math.abs(gap).toFixed(1)} pts {gap > 0 ? "worse" : "better"}{" "}
      than the closing line
    </>
  );
}
