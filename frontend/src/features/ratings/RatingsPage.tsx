import { useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router-dom";

import type { RootState } from "../../app/store";
import { useGetLeaguesQuery, useGetRatingsQuery } from "../../services/api";
import { RatingsTable } from "./RatingsTable";
import { modelSelected, searchChanged } from "./uiSlice";

export function RatingsPage() {
  const { league = "mens" } = useParams();
  const dispatch = useDispatch();
  const { model, search } = useSelector((s: RootState) => s.ui);

  const leagues = useGetLeaguesQuery();
  const ratings = useGetRatingsQuery({ league, model: model ?? undefined });

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

  if (ratings.isError) {
    return <p className="error">No ratings published for {league} yet.</p>;
  }

  return (
    <>
      <div className="controls">
        <input
          type="search"
          placeholder="Filter teams"
          value={search}
          aria-label="Filter teams"
          onChange={(e) => dispatch(searchChanged(e.target.value))}
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
          &middot; Brier {ratings.data.metrics.brier_score.toFixed(4)}
        </p>
      )}

      {ratings.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : (
        <RatingsTable rows={rows} showRd={showRd} />
      )}
    </>
  );
}

function defaultName(models: { name: string; is_default: boolean }[]): string {
  return models.find((m) => m.is_default)?.name ?? models[0].name;
}
