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
from endgame.types import Game, Week

from app.endgame_pickle import RawGame, load_seasons

from .conftest import NEW_GAME_FIELDS, as_endgames_game

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
