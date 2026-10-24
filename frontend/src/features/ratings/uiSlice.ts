import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import type { Metric } from "./scatter";
import { MODEL_ORDER, nextSort, type Sort, type SortKey } from "./sort";

// UI-only state. Everything served by the API lives in RTK Query's cache and
// is deliberately not duplicated here.
interface UiState {
  /** null means "the league's default model" -- the lowest-Brier one. */
  model: string | null;
  search: string;
  /**
   * The ratings table's order. Kept across a change of model, so comparing
   * two models' best offenses is one click on the select rather than a
   * re-sort each time.
   */
  sort: Sort;
  /**
   * The chart's axes, or null for the default pair. Kept across a change of
   * model like the sort, and only fall back (in `scatter.resolveAxis`) where
   * the model in view doesn't publish the one chosen.
   */
  chartX: Metric | null;
  chartY: Metric | null;
}

const initialState: UiState = {
  model: null,
  search: "",
  sort: MODEL_ORDER,
  chartX: null,
  chartY: null,
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    modelSelected(state, action: PayloadAction<string | null>) {
      state.model = action.payload;
    },
    searchChanged(state, action: PayloadAction<string>) {
      state.search = action.payload;
    },
    sortClicked(state, action: PayloadAction<SortKey>) {
      state.sort = nextSort(state.sort, action.payload);
    },
    chartAxisSelected(
      state,
      action: PayloadAction<{ axis: "x" | "y"; metric: Metric }>,
    ) {
      if (action.payload.axis === "x") state.chartX = action.payload.metric;
      else state.chartY = action.payload.metric;
    },
  },
});

export const { modelSelected, searchChanged, sortClicked, chartAxisSelected } =
  uiSlice.actions;
export default uiSlice.reducer;
