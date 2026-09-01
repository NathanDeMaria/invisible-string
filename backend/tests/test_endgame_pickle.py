"""Reading a season pickle whose `Game` isn't the `Game` this image installs.

The failure this guards against is quiet and total: endgame's `Game` is a
NamedTuple, so a field appended upstream makes every season file written since
raise `TypeError` on the way back in, and both readers catch that per file and
log it. One append upstream, and the games page is empty for every league at
once.

The awkward part is that the installed `endgame` is whichever one the
dependency chain resolves -- so a test that only used it could only ever
exercise one era of file. `game_pickle` builds the other era instead: a
namedtuple of any arity, pickled under `endgame.types.Game`, which is byte for
byte what a differently-versioned endgame writes. That is what lets both the
file with `status` and the file without it be checked from one image, which is
also the situation in the bucket -- `seasons/` holds files from either side of
the flip, since a previous year's is only rewritten when that year is pulled.
"""

import pickle
from collections import namedtuple
from datetime import datetime
from typing import Any

import pytest
from endgame.ncaabb.ncaabb import Season
from endgame.types import Game, Week, group_games_into_weeks

from app.endgame_pickle import (
    RawGame,
    load_seasons,
    numbered_weeks,
    week_number,
)

from .conftest import NEW_GAME_FIELDS, NewGame, as_endgames_game, new_game

TIPOFF = datetime(2026, 3, 1, 20, 0)

# What the installed endgame writes, whatever that happens to be.
INSTALLED_FIELDS = Game._fields


def game_pickle(fields: tuple[str, ...], values: tuple[Any, ...]) -> bytes:
    """A season pickle whose games came from a `Game` with `fields`."""
    # Named "Game" because that is the name the pickle has to carry, and put
    # in a `Week` it isn't endgame's `Game` -- which is the whole exercise.
    other = namedtuple("Game", fields)  # ty: ignore[mismatched-type-name]
    other.__module__ = "endgame.types"
    with as_endgames_game(other):
        games = [other(*values)]
        return pickle.dumps([Season([Week(games, 1)], 2026)])  # ty: ignore[invalid-argument-type]


def only_game(raw: bytes) -> Any:
    seasons = load_seasons(raw)
    return seasons[0].weeks[0].games[0]


class TestFieldOrder:
    """The one thing this module gets wrong if endgame moves under it.

    Reading positionally buys tolerance of an *appended* field at the price of
    assuming nothing is inserted or reordered. That price is only worth paying
    if the assumption is checked, which is what this is.
    """

    def test_mirrors_the_installed_game(self) -> None:
        shared = min(len(RawGame.FIELDS), len(INSTALLED_FIELDS))
        assert RawGame.FIELDS[:shared] == INSTALLED_FIELDS[:shared]

    def test_knows_at_least_what_is_installed(self) -> None:
        """Fields are appended upstream, so this list should never be the
        shorter one -- and if it is, it is behind rather than tolerant."""
        assert len(RawGame.FIELDS) >= len(INSTALLED_FIELDS)

    def test_only_trailing_fields_are_defaulted(self) -> None:
        """`__new__` counts required fields as "all but the defaults", which
        is only right while the defaults are the last ones."""
        assert RawGame.FIELDS[-len(RawGame.DEFAULTS) :] == tuple(RawGame.DEFAULTS)


class TestTheInstalledClass:
    def test_reads_a_season_this_image_could_have_written(self) -> None:
        played = Game("Duke", 78, "North Carolina", 71, False, True, TIPOFF, "401")
        game = only_game(pickle.dumps([Season([Week([played], 1)], 2026)]))
        assert (game.home, game.away, game.home_score) == ("Duke", "North Carolina", 78)
        assert game.completed is True
        assert game.date == TIPOFF

    def test_tolerates_a_bare_season(self) -> None:
        """`save_to_s3` writes a list; a file written by hand may not."""
        played = Game("Duke", 78, "North Carolina", 71, False, True, TIPOFF, "401")
        assert len(load_seasons(pickle.dumps(Season([Week([played], 1)], 2026)))) == 1


class TestAnAppendedField:
    """The change that is actually in the bucket: `Game` gained a `status` when
    the jobs started writing the games ESPN hasn't finished."""

    NEW_FIELDS = NEW_GAME_FIELDS
    SCHEDULED = (
        "Duke",
        0,
        "Houston",
        0,
        False,
        False,
        TIPOFF,
        "402",
        "STATUS_SCHEDULED",
    )

    def test_the_new_field_is_read(self) -> None:
        game = only_game(game_pickle(self.NEW_FIELDS, self.SCHEDULED))
        assert game.status == "STATUS_SCHEDULED"
        assert game.completed is False

    def test_the_rest_of_the_game_still_lands(self) -> None:
        game = only_game(game_pickle(self.NEW_FIELDS, self.SCHEDULED))
        assert (game.home, game.away, game.game_id) == ("Duke", "Houston", "402")

    def test_an_older_file_defaults_it(self) -> None:
        """Every game in the bucket written before the flip. "" rather than
        STATUS_FINAL: those games really are all final, but writing a status
        nothing observed is how a wrong invariant gets baked in."""
        old = ("Duke", 78, "North Carolina", 71, False, True, TIPOFF, "401")
        game = only_game(game_pickle(INSTALLED_FIELDS[:8], old))
        assert game.status == ""

    def test_the_next_append_is_survivable_too(self) -> None:
        """The point of the exercise. A field this app has never heard of is
        dropped, and every field it has heard of still reads."""
        future = only_game(
            game_pickle(
                self.NEW_FIELDS + ("venue",),
                self.SCHEDULED + ("Cameron Indoor",),
            )
        )
        assert future.status == "STATUS_SCHEDULED"
        assert future.home == "Duke"
        assert not hasattr(future, "venue")


class TestABrokenGame:
    def test_too_few_values_is_an_error(self) -> None:
        """Not version skew -- endgame has never written fewer than these
        eight, so a game missing one is a broken object, and the readers skip
        it the way they skip any other."""
        with pytest.raises(TypeError):
            only_game(game_pickle(INSTALLED_FIELDS[:4], ("Duke", 78, "UNC", 71)))

    def test_the_message_says_what_was_short(self) -> None:
        with pytest.raises(TypeError, match="4 values"):
            only_game(game_pickle(INSTALLED_FIELDS[:4], ("Duke", 78, "UNC", 71)))


def test_games_come_back_as_raw_games() -> None:
    """Whichever endgame is installed. The substitution is unconditional so
    that the app reads one kind of object, rather than one kind on the deploy
    where the pin happens to match and another where it doesn't."""
    played = Game("Duke", 78, "North Carolina", 71, False, True, TIPOFF, "401")
    season = pickle.dumps([Season([Week([played], 1)], 2026)])
    assert isinstance(only_game(season), RawGame)


def test_only_game_is_substituted() -> None:
    """`Season` and `Week` are walked, not read field by field, so their
    layout is endgame's business and they resolve to endgame's classes."""
    played = Game("Duke", 78, "North Carolina", 71, False, True, TIPOFF, "401")
    season = load_seasons(pickle.dumps([Season([Week([played], 1)], 2026)]))[0]
    assert isinstance(season, Season)
    assert isinstance(season.weeks[0], Week)


class TestWeekNumbering:
    """The other rule this module mirrors, and the one with a silent failure.

    A week number here isn't a label -- it is the key the processed
    play-by-play is written under (`processed/plays/.../week=NN/`). Getting it
    wrong doesn't raise: it reads a real week's real plays and draws somebody
    else's game. So the arithmetic is pinned against endgame's own, the way
    `RawGame.FIELDS` is pinned against `Game._fields`.
    """

    # NCAAFB's, and the only league in the bucket that has one.
    SEASON_START = (8, 20)

    def test_matches_endgames_own_numbering(self) -> None:
        games = [
            new_game(datetime(2026, 8, 29, 19, 0), gid="1", status="STATUS_FINAL"),
            new_game(datetime(2026, 9, 5, 15, 30), gid="2", status="STATUS_FINAL"),
            new_game(datetime(2026, 11, 28, 12, 0), gid="3", status="STATUS_FINAL"),
            new_game(datetime(2027, 1, 11, 19, 30), gid="4", status="STATUS_FINAL"),
        ]
        theirs = {
            game.game_id: week.number
            for week in group_games_into_weeks(games, 2026, self.SEASON_START)
            for game in week.games
        }
        ours = {
            game.game_id: week_number(game.date, 2026, self.SEASON_START)
            for game in games
        }
        assert ours == theirs

    def test_a_bowl_game_in_january_keeps_counting(self) -> None:
        """The case the mirror exists for: NCAAFB runs past new year, and a
        week numbered off the calendar year rather than the season's would
        restart at 1 in January."""
        assert week_number(datetime(2027, 1, 11), 2026, self.SEASON_START) > 18


class TestNumberedWeeks:
    def test_a_season_without_a_start_keeps_the_sources_numbers(self) -> None:
        """The NFL. Its weeks are already chronological, so endgame walks them
        in the source's own numbering and so does the plays job."""
        played = new_game(TIPOFF, gid="401", status="STATUS_FINAL", completed=True)
        with as_endgames_game(NewGame):
            season = Season([Week([played], 7)], 2026)
        assert [number for number, _ in numbered_weeks(season)] == [7]

    def test_a_season_with_a_start_is_regrouped_by_date(self) -> None:
        """NCAAFB. The source's week numbers aren't chronological, so both
        endgame's plays job and this regroup the games by calendar week --
        which means two games the source filed together can land apart."""
        early = new_game(datetime(2026, 8, 29, 19, 0), gid="1", status="STATUS_FINAL")
        late = new_game(datetime(2026, 9, 5, 19, 0), gid="2", status="STATUS_FINAL")
        with as_endgames_game(NewGame):
            season = Season([Week([early, late], 1)], 2026, None, (8, 20))
        numbered = dict(numbered_weeks(season))
        assert len(numbered) == 2
        assert [
            g.game_id for g in numbered[week_number(early.date, 2026, (8, 20))]
        ] == ["1"]

    def test_a_game_fetched_twice_is_only_in_one_week(self) -> None:
        """A cross-division matchup comes back under both divisions, and the
        copies needn't agree. Two copies in two calendar weeks would be two
        rows on the page -- so they're pooled first, exactly as endgame's
        `calendar_weeks` pools them."""
        live = new_game(datetime(2026, 9, 5, 19, 0), gid="1", status="STATUS_SCHEDULED")
        final = new_game(
            datetime(2026, 9, 5, 19, 0), gid="1", status="STATUS_FINAL", completed=True
        )
        with as_endgames_game(NewGame):
            season = Season([Week([live], 1), Week([final], 2)], 2026, None, (8, 20))
        (games,) = [games for _, games in numbered_weeks(season)]
        assert [(g.game_id, g.completed) for g in games] == [("1", True)]

    def test_a_final_is_never_walked_back_to_a_live_game(self) -> None:
        """`supersedes`, in the one form this needs. Copies of a game in
        progress are fetched minutes apart, and whichever ran last is not
        necessarily the one that saw the final whistle."""
        final = new_game(
            datetime(2026, 9, 5, 19, 0), gid="1", status="STATUS_FINAL", completed=True
        )
        live = new_game(datetime(2026, 9, 5, 19, 0), gid="1", status="STATUS_SCHEDULED")
        with as_endgames_game(NewGame):
            season = Season([Week([final], 1), Week([live], 2)], 2026, None, (8, 20))
        (games,) = [games for _, games in numbered_weeks(season)]
        assert [(g.game_id, g.completed) for g in games] == [("1", True)]
