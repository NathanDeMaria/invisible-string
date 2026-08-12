import type { PredictResponse } from "../../services/api";

/**
 * The market's way of writing a prediction: the favourite, and the points
 * they lay.
 *
 * `predicted_spread` comes back from the *home* team's perspective, where
 * negative means home is favoured (DESIGN.md section 1). So a home favourite
 * renders with the number as-is -- it is already negative -- and an away
 * favourite renders with it flipped, because a spread is always quoted against
 * the team laying it.
 *
 * Attaching the number to the wrong side reads perfectly naturally, which is
 * why this lives on its own and is tested directly rather than only through
 * the component.
 */
export function favouriteLine(prediction: PredictResponse): string | null {
  const { predicted_spread: spread, home, away } = prediction;
  if (spread == null) return null;
  // Rounds to the same "0.0" the branches below would print, so a spread of
  // -0.04 says pick'em rather than "Duke -0.0".
  if (Math.abs(spread) < 0.05) return "Pick'em";
  return spread < 0
    ? `${home} ${spread.toFixed(1)}`
    : `${away} ${(-spread).toFixed(1)}`;
}
