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

from app.plays import (
    FixturePlay,
    LocalPlaysSource,
    PlaysUnavailable,
    in_game_order,
)

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

    def test_puts_the_game_back_in_order(
        self, source: LocalPlaysSource, tmp_path: Path
    ) -> None:
        """`PlaySource` promises game order upstream and this promises it
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


def snap(number: int, period: int, clock: int) -> FixturePlay:
    return FixturePlay(**play(number, period=period, clock_seconds=clock))


class TestTheOrderAGameIsWalkedIn:
    """`play_number` is ESPN's drive order, and the x axis is the clock.

    They agree in almost every game, which is why the difference went
    unnoticed until a chart drew a drive a quarter away from where it
    happened. These are the cases where they don't.
    """

    def test_a_game_in_order_is_left_alone(self) -> None:
        """The common case, and the one worth stating: nothing about a
        well-formed feed is rearranged."""
        game = [snap(1, 1, 900), snap(2, 1, 880), snap(3, 2, 700)]
        assert [p.play_number for p in in_game_order(game)] == [1, 2, 3]

    def test_a_drive_the_feed_misplaced_moves_back_to_its_clock(self) -> None:
        """The bug this exists for. Plays 3 and 4 are a Q1 drive that arrived
        after the Q2 ones; walked as sent they draw a line that runs into the
        second quarter, jumps back across the plot and runs forward again."""
        game = [
            snap(1, 1, 900),
            snap(2, 2, 700),
            snap(3, 1, 600),
            snap(4, 1, 560),
            snap(5, 2, 400),
        ]
        assert [p.play_number for p in in_game_order(game)] == [1, 3, 4, 2, 5]

    def test_the_clock_only_ever_runs_down(self) -> None:
        """The property the chart actually depends on, said as the chart
        reads it: seconds left in regulation, never increasing."""
        game = [snap(1, 2, 700), snap(2, 1, 900), snap(3, 4, 30), snap(4, 3, 500)]
        assert [(p.period, p.clock_seconds) for p in in_game_order(game)] == [
            (1, 900),
            (2, 700),
            (3, 500),
            (4, 30),
        ]

    def test_plays_sharing_a_clock_keep_the_feed_s_order(self) -> None:
        """A penalty and its replay, or two snaps inside one tick, land on the
        same clock -- and then `play_number` is the only thing that knows
        which came first. Sorting them by anything else would scramble a
        drive to fix a defect that isn't in it."""
        game = [snap(3, 1, 700), snap(1, 1, 700), snap(2, 1, 700)]
        assert [p.play_number for p in in_game_order(game)] == [1, 2, 3]

    def test_overtime_stays_after_regulation(self) -> None:
        """`seconds_remaining` is pinned to zero for every overtime snap
        upstream, so the period has to carry the order -- otherwise a fifth
        quarter sorts in among the fourth's two-minute drill."""
        game = [snap(1, 4, 60), snap(2, 5, 0), snap(3, 6, 0)]
        assert [p.play_number for p in in_game_order(game)] == [1, 2, 3]

    def test_a_play_with_no_clock_stays_with_the_one_it_followed(self) -> None:
        """`iter_states` drops it from the curve and still reads its score,
        so where it sits between its neighbours matters. The feed's order is
        the only evidence of that, so it inherits the last clock seen rather
        than sorting to an edge."""
        game = [
            snap(1, 1, 900),
            snap(2, 2, 700),
            FixturePlay(**play(3)),
            snap(4, 1, 600),
        ]
        assert [p.play_number for p in in_game_order(game)] == [1, 4, 2, 3]

    def test_a_game_that_opens_with_no_clock_keeps_those_plays_first(self) -> None:
        """There is nothing to inherit before the first clocked play, and the
        front is where they already were."""
        game = [FixturePlay(**play(1)), snap(2, 1, 900), snap(3, 1, 880)]
        assert [p.play_number for p in in_game_order(game)] == [1, 2, 3]
