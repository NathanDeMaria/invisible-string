import { useCallback, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";

interface Options {
  /**
   * Where Up goes from the first row, where the page has somewhere better
   * than nowhere -- the leaderboard sends it back to the filter box, which
   * makes "type, arrow down, arrow up, keep typing" one gesture rather than a
   * reach for the mouse.
   */
  onExitTop?: () => void;
}

/** What a navigable row spreads onto its `<tr>`. */
export interface RowKeys {
  tabIndex: 0;
  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => void;
}

/**
 * A table whose rows are the thing you move through.
 *
 * The row is the tab stop rather than the link inside it. That is the same
 * *number* of stops these tables already had -- every row's first cell is a
 * link into the row's own page -- so Tab still walks teams and games one at a
 * time, and nothing on the page became harder to tab past. What it buys is
 * that the focused thing is the row: the whole line highlights, arrows move
 * between rows, Home and End reach the ends of a 360-team leaderboard without
 * 360 presses, and Enter opens what the row is about.
 *
 * Movement reads the DOM rather than an index, because the DOM is what the
 * order actually is: filtering the leaderboard or stepping a day rebuilds the
 * rows, and a remembered index would point at whatever moved into its place.
 *
 * Nothing here touches Tab itself. Rows are ordinary tab stops in document
 * order, so Shift-Tab, the browser's focus ring and a screen reader's own
 * navigation all keep working -- a `tabIndex` roving between rows would take
 * the first two away to save the third.
 */
export function useRowKeys({ onExitTop }: Options = {}) {
  const navigate = useNavigate();

  return useCallback(
    (href: string): RowKeys => ({
      tabIndex: 0,
      onKeyDown: (event) => {
        // Only the row's own keystrokes. A link inside a row is out of the
        // tab order but can still take focus from a click, and Enter there
        // is the link's to handle rather than ours to handle twice.
        if (event.target !== event.currentTarget) return;

        const row = event.currentTarget;
        const move = (to: Element | null | undefined) => {
          if (!(to instanceof HTMLElement)) return;
          event.preventDefault();
          to.focus();
        };

        switch (event.key) {
          case "ArrowDown":
            move(row.nextElementSibling);
            break;
          case "ArrowUp":
            if (row.previousElementSibling) {
              move(row.previousElementSibling);
            } else if (onExitTop) {
              event.preventDefault();
              onExitTop();
            }
            break;
          case "Home":
            move(row.parentElement?.firstElementChild);
            break;
          case "End":
            move(row.parentElement?.lastElementChild);
            break;
          case "Enter":
            event.preventDefault();
            navigate(href);
            break;
        }
      },
    }),
    [navigate, onExitTop],
  );
}
