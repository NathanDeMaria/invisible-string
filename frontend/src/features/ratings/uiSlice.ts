import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

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
}

const initialState: UiState = { model: null, search: "", sort: MODEL_ORDER };

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
  },
});

export const { modelSelected, searchChanged, sortClicked } = uiSlice.actions;
export default uiSlice.reducer;
