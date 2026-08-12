import { useLocation } from "react-router-dom";

/**
 * Exposes the router's current URL to assertions.
 *
 * Needed because MemoryRouter keeps its history in memory and never touches
 * `window.location` -- so a test that checks `window.location.search` is
 * reading the jsdom default and passes no matter what the component does.
 */
export function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location" hidden>
      {location.pathname}
      {location.search}
    </div>
  );
}
