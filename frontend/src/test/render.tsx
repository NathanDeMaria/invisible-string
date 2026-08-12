import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { Provider } from "react-redux";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { createStore } from "../app/store";
import { LocationProbe } from "./LocationProbe";

interface Options {
  route?: string;
  /**
   * Route pattern to mount `ui` under. Required for components that read
   * useParams -- without a matching Route the params are empty and the
   * component silently falls back to its defaults.
   */
  path?: string;
}

/** Renders with a fresh store, so RTK Query's cache can't leak between tests. */
export function renderApp(
  ui: ReactElement,
  { route = "/", path }: Options = {},
) {
  return render(
    <Provider store={createStore()}>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        {path ? (
          <Routes>
            <Route path={path} element={ui} />
          </Routes>
        ) : (
          ui
        )}
      </MemoryRouter>
    </Provider>,
  );
}
