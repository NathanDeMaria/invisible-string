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

**The order a source hands plays back in is the clock's, not the feed's.**
`in_game_order` is the whole of that rule and the reason it isn't upstream's
`sort_plays`; see its docstring.
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
    # ESPN's sentence about the play, and the only place the *manner* of one
    # is recorded: `lucky_ones.luck` reads it to find the fumbles and the
    # contested passes (DESIGN.md 16.7). Nothing the model sees is built from
    # it, so a fixture that leaves it out simply has no bounces in it.
    text: str | None = None
    scoring_play: bool | None = None
    is_penalty: bool | None = None
    is_turnover: bool | None = None
    drive_id: str | None = None
    drive_number: int = 0
    drive_team_id: str | None = None
    drive_result: str | None = None
    drive_is_score: bool | None = None


def in_game_order(plays: Sequence[Play]) -> list[Play]:
    """One game's plays in the order the clock says they happened.

    Not upstream's `sort_plays`, which orders by `play_number` -- and
    `play_number` is "1-based position in the game, in the order ESPN sent the
    drives", which is a different claim than "in the order the game happened".
    ESPN's drive list is *usually* chronological and occasionally isn't: a
    drive lands out of place and its whole block of plays lands with it.

    That is invisible to a model reading down and distance, and it is not
    invisible to the chart. §16.6's x axis is `seconds_remaining`, so a block
    of plays sitting a quarter away from where its clock puts it draws a line
    that runs forward, jumps back across the plot and runs forward again --
    two long diagonals crossing, over a game nobody played that way. The
    curve, `game_control`'s clock weights and the score carried into each snap
    are all read in this order, so it is worth fixing once here rather than
    papering over in the one place it happens to show.

    The key is (period, clock counting down, `play_number`). Two things about
    it matter:

    - **`play_number` is the tiebreak, not the sort.** A drive is a handful of
      snaps that ESPN records at the same clock -- a penalty and its replay, a
      spike, plays inside the same tick -- and the feed's order within one is
      the only thing that knows which came first. So a game whose drives are
      in order comes back exactly as it went in, and only a genuinely
      misplaced block moves.
    - **A play with no clock inherits the last one that had a clock**, rather
      than sorting to an edge. `iter_states` drops such a play from the curve
      but still reads its score, so where it sits relative to its neighbours
      is not nothing -- and the feed's order is the best evidence of that.
      Before the first clocked play there is nothing to inherit, and those
      sort to the front, which is where they already were.
    """
    by_number = sorted(plays, key=lambda play: play.play_number)
    keyed: list[tuple[tuple[int, int, int], Play]] = []
    period, clock = 0, 0
    for play in by_number:
        if play.period is not None and play.clock_seconds is not None:
            period, clock = play.period, play.clock_seconds
        keyed.append(((period, -clock, play.play_number), play))
    keyed.sort(key=lambda pair: pair[0])
    return [play for _, play in keyed]


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
        return in_game_order(plays)


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
