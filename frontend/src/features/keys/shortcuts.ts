/** One key, or a few that do the same thing, and what it does. */
export interface Shortcut {
  keys: string[];
  does: string;
}

export interface ShortcutGroup {
  where: string;
  shortcuts: Shortcut[];
}

/**
 * Every shortcut the app has, in the order the help sheet lists them.
 *
 * The list is the documentation, not the implementation: each key is bound
 * where it acts, because what `1` means depends on which page is asking. What
 * this buys is one place that knows the *whole* set, which is the thing a
 * reader needs and the thing that otherwise only exists in someone's head --
 * so a key added to a page without a line here is a key nobody will find.
 */
export const SHORTCUTS: ShortcutGroup[] = [
  {
    where: "Anywhere",
    shortcuts: [
      { keys: ["g"], does: "Games" },
      { keys: ["r"], does: "Ratings, for the league you were last in" },
      { keys: ["m"], does: "Matchup, for that same league" },
      { keys: ["j"], does: "Job health" },
      { keys: ["?"], does: "This sheet" },
    ],
  },
  {
    where: "A table of teams or games",
    shortcuts: [
      { keys: ["Tab", "↓", "↑"], does: "Move down and up the rows" },
      { keys: ["Home", "End"], does: "First row, last row" },
      { keys: ["Enter"], does: "Open the team or the game" },
    ],
  },
  {
    where: "The leaderboard",
    shortcuts: [
      { keys: ["/"], does: "Filter teams" },
      { keys: ["↓"], does: "From the filter, into the table" },
      { keys: ["Esc"], does: "Clear the filter" },
      { keys: ["1", "…", "9"], does: "Switch league" },
    ],
  },
  {
    where: "Games",
    shortcuts: [
      { keys: ["←", "→"], does: "A day back, a day on" },
      { keys: ["t"], does: "Back to today" },
      { keys: ["1", "…", "9"], does: "Show one league" },
      { keys: ["0"], does: "Show them all" },
    ],
  },
];
