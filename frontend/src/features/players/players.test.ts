import { describe, expect, it } from "vitest";

import type { PlayerRow } from "../../services/api";
import {
  filterPlayers,
  nextSort,
  perGame,
  seasonLabel,
  sortPlayers,
} from "./players";

const row = (over: Partial<PlayerRow>): PlayerRow => ({
  athlete_id: "1",
  player: "Pat",
  team_id: "9",
  team: "Duke",
  projected: false,
  offense: 1,
  defense: 1,
  total: 2,
  offense_sd: 1,
  defense_sd: 1,
  total_sd: 2,
  vs_team: 1,
  games: 10,
  starts: 10,
  minutes: 300,
  share: 0.75,
  ...over,
});

describe("filterPlayers", () => {
  const rows = [
    row({ player: "Pat", share: 0.5 }),
    row({ player: "Low", share: 0.05 }),
    row({ player: "Box", share: null }),
    row({ player: "Wait", team: "UNC", projected: true, share: 0.3 }),
  ];
  const names = (found: PlayerRow[]) => found.map((r) => r.player);

  it("drops those under the floor and those with no share", () => {
    expect(names(filterPlayers(rows, "", 10))).toEqual(["Pat", "Wait"]);
  });

  it("keeps a player exactly on it", () => {
    expect(names(filterPlayers([row({ share: 0.1 })], "", 10))).toEqual([
      "Pat",
    ]);
  });

  it("searches names and teams", () => {
    expect(names(filterPlayers(rows, "unc", 10))).toEqual(["Wait"]);
    expect(names(filterPlayers(rows, "PAT", 10))).toEqual(["Pat"]);
  });
});

describe("sortPlayers", () => {
  it("sends the blanks to the bottom both ways", () => {
    const rows = [
      row({ player: "None", games: null, minutes: null }),
      row({ player: "Some", games: 2, minutes: 40 }),
      row({ player: "More", games: 2, minutes: 60 }),
    ];
    for (const direction of ["asc", "desc"] as const) {
      const sorted = sortPlayers(rows, { key: "per_game", direction });
      expect(sorted[2].player).toBe("None");
    }
  });

  it("doesn't count someone yet to play as the fewest games", () => {
    const rows = [
      row({ player: "Wait", projected: true, games: 0, starts: 0 }),
      row({ player: "One", games: 1 }),
    ];
    const sorted = sortPlayers(rows, { key: "games", direction: "asc" });
    expect(sorted.map((r) => r.player)).toEqual(["One", "Wait"]);
  });

  it("breaks a tie on the total", () => {
    const rows = [
      row({ player: "Low", games: 3, total: 1 }),
      row({ player: "High", games: 3, total: 5 }),
    ];
    const sorted = sortPlayers(rows, { key: "games", direction: "asc" });
    expect(sorted[0].player).toBe("High");
  });
});

describe("nextSort", () => {
  it("starts each column best-first and flips on a second click", () => {
    const total = { key: "total", direction: "desc" } as const;
    expect(nextSort(total, "offense").direction).toBe("desc");
    expect(nextSort(total, "total_sd").direction).toBe("asc");
    expect(nextSort(total, "player").direction).toBe("asc");
    expect(nextSort(total, "total").direction).toBe("asc");
  });
});

describe("the small readings", () => {
  it("has no minutes a game for someone yet to play", () => {
    expect(perGame(row({ games: 0, minutes: 0 }))).toBeNull();
    expect(perGame(row({ games: 10, minutes: 300 }))).toBe(30);
  });

  it("names a season for both its years", () => {
    expect(seasonLabel(2025)).toBe("2025-26");
    expect(seasonLabel(2099)).toBe("2099-00");
  });
});
