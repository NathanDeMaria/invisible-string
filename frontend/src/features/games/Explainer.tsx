import type { ReactNode } from "react";

interface Props {
  /**
   * The line that stays on the page. Usually the number itself, so the
   * disclosure hangs off the thing it explains rather than sitting beside it
   * as a second sentence.
   */
  summary: ReactNode;
  children: ReactNode;
}

/**
 * A number, and the paragraph about how to read it -- folded away until
 * somebody asks.
 *
 * Every number under the chart needs a caveat and every caveat is true: a
 * share of the game is not a win probability, two totals of win probability
 * don't sum to anything, and an EPA per play is neither. Written out, they
 * are five paragraphs of prose between the reader and four numbers, and a
 * page that has to be read to be scanned isn't a scoreboard any more.
 *
 * So the caveat is one click away rather than gone. Both halves of that
 * matter: a number whose warning the page has dropped is worse than a busy
 * page, and the whole argument for saying these things at all (DESIGN.md
 * 16.6, 16.7, 16.8) is that the reader can be misled without them.
 *
 * **`<details>`, not state.** It opens without JavaScript, keyboard and
 * screen readers already know what it is, and browser find-in-page opens one
 * to show a match. A `useState` toggle would be all three of those written
 * again, worse.
 *
 * **The summary is the number, not a "learn more".** Clicking the sentence
 * you just read is what a reader with a question does, and it keeps the line
 * that carries the reading in the page rather than behind a label that
 * doesn't.
 */
export function Explainer({ summary, children }: Props) {
  return (
    <details className="explainer">
      <summary>{summary}</summary>
      <div className="explainer-body">{children}</div>
    </details>
  );
}
