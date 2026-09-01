"""The play-by-play source, and the shape a play has here.

Two things are worth checking directly. The first is that `FixturePlay`
really satisfies `lucky_ones.plays.Play`: the whole design of that package is
that a play is a *shape*, not a class, and a fixture that drifted from it
would fail somewhere inside a feature matrix rather than at the boundary. The
second is the distinction the module exists to keep -- a game with no plays is
a fact about the game, and an unreadable file is a fact about us.
"""

import json
from pathlib import Path

import pytest
from lucky_ones.plays import Play

from app.plays import FixturePlay, LocalPlaysSource, PlaysUnavailable

GAME = ("nfl", 2026, 3, "401910101")


def play(number: int, **fields: object) -> dict:
    return {
        "league": "nfl",
        "season": 2026,
        "week": 3,
        "game_id": "401910101",
        "play_id": f"p{number}",
        "play_number": number,
        **fields,
    }


@pytest.fixture
def source(tmp_path: Path) -> LocalPlaysSource:
    return LocalPlaysSource(tmp_path)


def write(root: Path, plays: object, name: str = "401910101.json") -> Path:
    directory = root / "plays" / "nfl" / "2026" / "3"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(json.dumps(plays))
    return path


class TestTheShapeOfAPlay:
    def test_a_fixture_play_is_a_play(self) -> None:
        """`Play` is runtime_checkable, so this checks the names exist --
        which is exactly the property a hand-written fixture can lose."""
        assert isinstance(FixturePlay(**play(1)), Play)

    def test_the_columns_a_curve_reads_are_all_optional(self) -> None:
        """A kickoff has no down and an administrative play no yardline, so a
        fixture spelling out only what it means to say is the normal case."""
        bare = FixturePlay(**play(1))
        assert (bare.down, bare.distance, bare.yardline) == (None, None, None)
        assert (bare.period, bare.clock_seconds) == (None, None)


class TestTheFixtureSource:
    def test_reads_a_games_plays(
        self, source: LocalPlaysSource, tmp_path: Path
    ) -> None:
        write(tmp_path, [play(1), play(2)])
        assert [p.play_number for p in source.game(*GAME)] == [1, 2]

    def test_sorts_by_play_number(
        self, source: LocalPlaysSource, tmp_path: Path
    ) -> None:
        """`PlaySource` promises play order upstream and this promises it
        here: `iter_states` walks the plays in the order it gets them, so a
        file written out of order would score a game that never happened."""
        write(tmp_path, [play(3), play(1), play(2)])
        assert [p.play_number for p in source.game(*GAME)] == [1, 2, 3]

    def test_a_missing_file_is_a_game_with_no_plays(
        self, source: LocalPlaysSource
    ) -> None:
        """Which is what it means in the bucket too: ESPN has no play-by-play
        for most of an NCAAFB week, and none at all for a game not yet
        played."""
        assert source.game(*GAME) == []

    def test_an_unreadable_file_is_not(
        self, source: LocalPlaysSource, tmp_path: Path
    ) -> None:
        path = write(tmp_path, [])
        path.write_text("{not json")
        with pytest.raises(PlaysUnavailable):
            source.game(*GAME)

    def test_a_file_that_isnt_a_list_is_not(
        self, source: LocalPlaysSource, tmp_path: Path
    ) -> None:
        write(tmp_path, {"plays": []})
        with pytest.raises(PlaysUnavailable):
            source.game(*GAME)

    def test_a_play_missing_its_identity_is_not(
        self, source: LocalPlaysSource, tmp_path: Path
    ) -> None:
        """A play with no `play_number` has no place in the order, which is
        the one thing every reader downstream relies on."""
        write(tmp_path, [{"league": "nfl", "game_id": "401910101"}])
        with pytest.raises(PlaysUnavailable):
            source.game(*GAME)
