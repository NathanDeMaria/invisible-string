"""One game's play-by-play: where it comes from, and what a play looks like here.

DESIGN.md section 16. The games page answers "what's on, and was the model
right"; this is what a *game* page needs to answer the other question a
football game raises -- how it actually went. `the-lucky-ones` turns plays into
a win probability curve, and this is the half that finds the plays.

The shape is endgame's, not ours. Its processed layer flattens ESPN's drive
JSON into one parquet row per play (`endgame_aws.pbp_transform.PLAY_SCHEMA`),
and `lucky_ones.plays.Play` is the subset of those columns a win probability
model reads, under the same names. So there is nothing to map: a row of that
table satisfies the protocol structurally, and `FixturePlay` below is the
same names again for a source that has no parquet to read.

Three things shape the module.

**A game is found by partition, not by search.** The processed plays are one
object per league-week, so reading a game means knowing its season and week
before asking -- which is why `ScheduledGame` carries them out of the season
file (§13.1). Nothing else in the bucket ties a game id to that triple.

**A game with no plays is the normal case, not an error.** ESPN has no
play-by-play for most of an NCAAFB week, none for a game that hasn't been
played, and none for a week nobody has processed yet. All three come back
empty. `PlaysUnavailable` is kept for the one case that isn't a fact about the
game -- the bucket couldn't be read -- for the reason `GamesUnavailable` is
kept apart from an empty window.

**The source is a Protocol**, like `ReleaseStore`, `JobsSource` and
`GamesSource`: tests and local dev get a fixture-backed implementation, and
neither needs AWS -- nor, for the local one, pyarrow.
"""

import json
import logging
from collections.abc import Sequence
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from lucky_ones.plays import Play
from pydantic import BaseModel, ValidationError

from app.settings import Settings, get_settings

log = logging.getLogger(__name__)


class PlaysUnavailable(RuntimeError):
    """endgame's processed play-by-play couldn't be read.

    Kept distinct from a game with no plays for the reason `GamesUnavailable`
    is kept distinct from an empty window: "ESPN has no play-by-play for this
    game" is a fact about the game, "AccessDenied" is a fact about us, and a
    D3 opponent and an outage must not render the same.
    """


class FixturePlay(BaseModel):
    """One play, as a JSON fixture carries it.

    Satisfies `lucky_ones.plays.Play` structurally -- same names, same
    meanings -- which `tests/test_plays.py` asserts rather than assumes.

    Almost everything is optional because it is optional in the source data:
    down and distance are absent on a kickoff, yardline on an administrative
    play, and a clock that didn't parse is None. A fixture spells out the
    handful of columns a curve reads and leaves the rest, which is what keeps
    a hand-written game legible.
    """

    league: str
    season: int
    week: int
    game_id: str
    play_id: str
    play_number: int
    period: int | None = None
    clock_seconds: int | None = None
    wallclock: datetime | None = None
    home_score: int | None = None
    away_score: int | None = None
    offense_team_id: str | None = None
    defense_team_id: str | None = None
    down: int | None = None
    distance: int | None = None
    yardline: int | None = None
    play_type: str | None = None
    scoring_play: bool | None = None
    is_penalty: bool | None = None
    is_turnover: bool | None = None
    drive_id: str | None = None
    drive_number: int = 0
    drive_team_id: str | None = None
    drive_result: str | None = None
    drive_is_score: bool | None = None


class PlaysSource(Protocol):
    def game(
        self, league: str, season: int, week: int, game_id: str
    ) -> Sequence[Play]: ...


class LocalPlaysSource:
    """Reads a game's plays from a JSON file instead of endgame's bucket.

    `<root>/plays/{league}/{season}/{week}/{game_id}.json` holds a list of
    plays in the columns above. Same trade as `LocalGamesSource` and
    `LocalJobsSource`, and the same root, so one env var points local dev and
    the tests at every fixture.

    Days are not re-based the way `LocalGamesSource` re-bases them: a play
    carries no date the curve reads, and the file is found by the season and
    week the *game* fixture names, which the shift doesn't touch.

    A missing file is a game with no play-by-play, not an error -- which is
    also what it means in the bucket.
    """

    def __init__(self, root: Path) -> None:
        self._dir = root / "plays"

    def game(self, league: str, season: int, week: int, game_id: str) -> Sequence[Play]:
        path = self._dir / league / str(season) / str(week) / f"{game_id}.json"
        try:
            raw = json.loads(path.read_text())
        except FileNotFoundError:
            return []
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise PlaysUnavailable(f"{path} is not readable play data") from exc
        if not isinstance(raw, list):
            raise PlaysUnavailable(f"{path} should hold a list of plays")

        try:
            plays = [FixturePlay.model_validate(item) for item in raw]
        except ValidationError as exc:
            raise PlaysUnavailable(f"{path} is not readable play data") from exc
        # The order `lucky_ones.state` walks them in, promised by `PlaySource`
        # upstream and by this one for the same reason: a fixture written out
        # of order would score a game that never happened.
        return sorted(plays, key=lambda play: play.play_number)


@lru_cache(maxsize=1)
def _build_source(settings: Settings) -> PlaysSource:
    """endgame's bucket when one is configured, otherwise the fixture files.

    The same bucket the games come from, so this costs no new configuration.
    What it does cost is one more prefix on the instance role's grant --
    `processed/plays/*`, read and listed -- which is the last thing under
    section 11.2's boundary this app didn't already have.
    """
    if settings.endgame_bucket:
        # Imported here so a local run pays neither boto3's import cost nor
        # pyarrow's, which is much the larger of the two.
        from app.processed_plays import AwsPlaysSource

        return AwsPlaysSource(
            bucket=settings.endgame_bucket,
            ttl_seconds=settings.plays_cache_ttl_seconds,
        )
    return LocalPlaysSource(settings.releases_root)


def get_plays_source() -> PlaysSource:
    """FastAPI dependency. Overridden in tests with a fake."""
    return _build_source(get_settings())
