import { useMemo, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router-dom";

import type { RootState } from "../../app/store";
import { useKeyboard } from "../keys/useKeyboard";
import { useGetRatingsQuery } from "../../services/api";
import { ModelSelect } from "./ModelSelect";
import { RatingsScatter } from "./RatingsScatter";
import {
  METRICS,
  availableMetrics,
  defaultAxes,
  resolveAxis,
  type Metric,
} from "./scatter";
import { chartAxisSelected, searchChanged } from "./uiSlice";

/**
 * The leaderboard's numbers as a picture: any two of its columns against
 * each other, a dot per team.
 *
 * A panel of its own beside the leaderboard rather than a mode of it, but
 * reading the same redux state -- the model and the filter carry over in
 * both directions, so flipping between the two compares like with like.
 */
export function ChartPage() {
  const { league = "mens" } = useParams();
  const dispatch = useDispatch();
  const { model, search, chartX, chartY } = useSelector((s: RootState) => s.ui);
  const ratings = useGetRatingsQuery({ league, model: model ?? undefined });

  const filter = useRef<HTMLInputElement>(null);
  useKeyboard({ "/": () => filter.current?.focus() });

  const all = ratings.data?.ratings ?? [];

  // The axes offer what the leaderboard's columns show, by the same rules:
  // asked of the rows, not the model name.
  const metrics = availableMetrics({
    rd: all.some((row) => row.rd != null),
    units: all.some((row) => row.offense != null || row.defense != null),
    success: all.some((row) => row.success != null),
    week: ratings.data?.movement_since?.date != null,
  });
  const fallback = defaultAxes(metrics);
  const x = resolveAxis(chartX, metrics, fallback.x);
  const y = resolveAxis(chartY, metrics, fallback.y);

  // The filter picks teams out rather than leaving the rest off: a dot is
  // read against the league around it, which a filtered plot would drop.
  const matched = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return null;
    return new Set(
      (ratings.data?.ratings ?? [])
        .filter((row) => row.team.toLowerCase().includes(needle))
        .map((row) => row.team),
    );
  }, [ratings.data, search]);

  if (ratings.isError) {
    return <p className="error">No ratings published for {league} yet.</p>;
  }

  return (
    <>
      <div className="controls">
        <input
          ref={filter}
          type="search"
          placeholder="Highlight teams"
          value={search}
          aria-label="Filter teams"
          onChange={(e) => dispatch(searchChanged(e.target.value))}
          onKeyDown={(e) => {
            // As on the leaderboard: Escape empties the box, and a second
            // press gives the page back the keys.
            if (e.key === "Escape") {
              e.preventDefault();
              if (search) dispatch(searchChanged(""));
              else e.currentTarget.blur();
            }
          }}
        />
        <ModelSelect league={league} />
      </div>
      <div className="controls axis-pickers">
        <AxisPicker
          label="X axis"
          value={x}
          options={metrics}
          onChange={(metric) =>
            dispatch(chartAxisSelected({ axis: "x", metric }))
          }
        />
        <AxisPicker
          label="Y axis"
          value={y}
          options={metrics}
          onChange={(metric) =>
            dispatch(chartAxisSelected({ axis: "y", metric }))
          }
        />
      </div>

      {ratings.data && (
        <p className="meta" data-testid="run-meta">
          {ratings.data.model} &middot; through{" "}
          {ratings.data.trained_through.last_game_date?.slice(0, 10) ??
            `${ratings.data.trained_through.season_year} season`}
        </p>
      )}

      {ratings.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : (
        <RatingsScatter
          rows={all}
          league={league}
          x={x}
          y={y}
          matched={matched}
        />
      )}
    </>
  );
}

function AxisPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Metric;
  options: Metric[];
  onChange: (metric: Metric) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Metric)}
      >
        {options.map((metric) => (
          <option key={metric} value={metric}>
            {METRICS[metric].label}
          </option>
        ))}
      </select>
    </label>
  );
}
