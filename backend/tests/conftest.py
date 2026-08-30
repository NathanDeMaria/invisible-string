import pickle
from collections import namedtuple
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from unittest import mock

import endgame.types
import pytest
from endgame.ncaabb.ncaabb import Season
from endgame.types import Week
from fastapi.testclient import TestClient

from app.games import GamesSource, LocalGamesSource, get_games_source
from app.jobs import JobsSource, LocalJobsSource, get_jobs_source
from app.main import create_app
from app.releases import LocalReleaseStore, ReleaseStore, get_release_store

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def store() -> ReleaseStore:
    return LocalReleaseStore(FIXTURES)


@pytest.fixture
def jobs_source() -> JobsSource:
    return LocalJobsSource(FIXTURES)


@pytest.fixture
def games_source() -> GamesSource:
    return LocalGamesSource(FIXTURES)


@pytest.fixture
def client(
    store: ReleaseStore, jobs_source: JobsSource, games_source: GamesSource
) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_release_store] = lambda: store
    app.dependency_overrides[get_jobs_source] = lambda: jobs_source
    app.dependency_overrides[get_games_source] = lambda: games_source
    return TestClient(app)


# endgame's `Game`, as the jobs that write unplayed games declare it: the eight
# fields it has always had, plus the ESPN status that says why a game with no
# score has none.
#
# Built here rather than imported, because the version that declares it may
# well not be installed: endgame arrives transitively, so the class in the
# image is whichever one cassandra's chain resolves, and the bucket is written
# by jobs that don't ask. Pickled through `endgame.types.Game` (see
# `as_endgames_game`), the stream is byte for byte what a newer endgame writes,
# which is the only property the tests need of it.
NEW_GAME_FIELDS = (
    "home",
    "home_score",
    "away",
    "away_score",
    "neutral_site",
    "completed",
    "date",
    "game_id",
    "status",
)

# Named "Game" because the *pickle* has to carry that name; the variable
# can't also be called Game without shadowing endgame's.
NewGame = namedtuple("Game", NEW_GAME_FIELDS)  # ty: ignore[mismatched-type-name]
NewGame.__module__ = "endgame.types"


@contextmanager
def as_endgames_game(replacement: type) -> Iterator[None]:
    """Stand endgame's own `Game` aside, so `replacement` pickles under its name.

    Needed because pickle refuses to write a class under a module path where
    something else answers to it, and undone immediately: the patch is a
    property of the *dump*, and a test that also builds a real `Game` has to
    keep working either side of it.
    """
    with mock.patch.object(endgame.types, "Game", replacement):
        yield


def new_game(
    when: datetime,
    *,
    gid: str,
    status: str,
    completed: bool = False,
    home: str = "Duke",
    away: str = "North Carolina",
) -> Any:
    """One `Game` as the newer endgame writes it, whatever this image pins."""
    return NewGame(
        home=home,
        home_score=78 if completed else 0,
        away=away,
        away_score=71 if completed else 0,
        neutral_site=False,
        completed=completed,
        date=when,
        game_id=gid,
        status=status,
    )


def new_season_pickle(games: list[Any], year: int = 2026) -> bytes:
    """What `save_to_s3` writes once the jobs carry fixtures: a pickled list."""
    with as_endgames_game(NewGame):
        return pickle.dumps([Season([Week(games, 1)], year)])
