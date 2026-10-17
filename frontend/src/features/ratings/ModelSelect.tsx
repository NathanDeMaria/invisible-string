import { useDispatch, useSelector } from "react-redux";

import type { RootState } from "../../app/store";
import { useGetLeaguesQuery } from "../../services/api";
import { modelSelected } from "./uiSlice";

/**
 * Which of a league's models the page is showing. Shared by the leaderboard
 * and the chart, and held in redux rather than in either, so switching
 * between them keeps the model you were looking at.
 */
export function ModelSelect({ league }: { league: string }) {
  const dispatch = useDispatch();
  const model = useSelector((s: RootState) => s.ui.model);
  const leagues = useGetLeaguesQuery();
  const models =
    leagues.data?.find((entry) => entry.league === league)?.models ?? [];

  return (
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
  );
}

function defaultName(models: { name: string; is_default: boolean }[]): string {
  return models.find((m) => m.is_default)?.name ?? models[0].name;
}
