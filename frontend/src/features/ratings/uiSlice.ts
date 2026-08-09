import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

// UI-only state. Everything served by the API lives in RTK Query's cache and
// is deliberately not duplicated here.
interface UiState {
  /** null means "the league's default model" -- the lowest-Brier one. */
  model: string | null;
  search: string;
}

const initialState: UiState = { model: null, search: "" };

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
  },
});

export const { modelSelected, searchChanged } = uiSlice.actions;
export default uiSlice.reducer;
