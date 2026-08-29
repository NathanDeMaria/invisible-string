"""The games around today: what's on, and what happened.

DESIGN.md section 13. The ratings pages answer "how good is this team?" and
the matchup page answers "what if these two played?". This is the third
question, and the one an actual reader has first: *what's on tonight, and was
the model right about last night?*

Everything here is the pre-prediction half -- schedule, scores, and the line.
`app.api.games` is what puts a model's number beside each one, because the
model belongs to `app.releases` and the games belong to endgame's bucket, and
keeping the join in the API layer is what lets a league with no readable
release still show its games.

Two things shape the module.

**Scores are as fresh as the nightly scrape.** A season is one pickle rewritten
once a day by `daily-games-{league}` (section 12), so a game that ended an hour
ago still reads as scheduled here until that job runs. That's a property of the
upstream, not something this can paper over -- so `home_score` is None until
`completed`, rather than the 0 the season file carries, and the page says so
out loud.

**The line is per game, not per league.** Odds objects are keyed by ESPN's
competition id, which is exactly `Game.game_id`, so joining them needs no
mapping between the two ways ncaabb is keyed (games are `mens`/`womens`, odds
are `ncaabb`) -- the join section 12 declined to invent isn't needed here.

The source is a Protocol for the same reason `ReleaseStore` and `JobsSource`
are: tests and local dev get a fixture-backed implementation, and neither needs
AWS.
"""

import json
import logging
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ValidationError

from app.settings import Settings, get_settings

log = logging.getLogger(__name__)

# The zone endgame's jobs think in: it stamps odds keys with the Chicago date
# (`_parse_date` in its cli), and "what's on today" turns on the same boundary.
# Using UTC would move an evening game into tomorrow all evening, which is the
# one day this page is most about.
GAME_TZ = ZoneInfo("America/Chicago")

# The default window: the couple of days that are still worth looking back at,
# plus today and tomorrow's slate.
DEFAULT_DAYS_BACK = 2
DEFAULT_DAYS_AHEAD = 1

# Not a retention ceiling the way section 12.3's is -- a season file carries
# the whole schedule, so a wider window is answerable. It's a cost cap: the
# odds side lists and reads a couple of objects per league per day, and this
# page is about the days around today. Ask for a month and you want a
# different page.
MAX_DAYS_BACK = 7
MAX_DAYS_AHEAD = 7


class GamesUnavailable(RuntimeError):
    """endgame's bucket couldn't be read.

    Kept distinct from an empty window for the reason `JobsUnavailable` is: "no
    games in these days" is a fact about the schedule, "AccessDenied" is a fact
    about us, and an offseason and an outage must not render the same.
    """


class ScheduledGame(BaseModel):
    """One game, before anyone's model has looked at it.

    `home_score` and `away_score` are None until the game is `completed`. The
    season file stores 0 for a game that hasn't happened, and 0-0 is a score --
    rendering it would turn tonight's schedule into a wall of scoreless
    finals.

    `market_spread` follows the same convention as `/api/predict`'s
    `predicted_spread`: quoted from the home team's side, so negative means the
    home team is favoured. That's the sign cassandra's own betting metrics
    assume (`spread + team1_mov > 0` is a home cover), which is what makes the
    two numbers comparable in a table.
    """

    league: str
    game_id: str
    start: datetime
    home: str
    away: str
    neutral: bool
    completed: bool
    home_score: int | None = None
    away_score: int | None = None
    market_spread: float | None = None

    @property
    def day(self) -> date:
        return game_day(self.start)


class GameWindow(BaseModel):
    """The games in a span of days, and which days that was.

    The bounds are dates rather than timestamps because the window is a span of
    *days in `GAME_TZ`*, not a rolling number of hours: "the last two days"
    should mean the same thing at 9am and at 9pm.
    """

    since: date
    until: date
    games: list[ScheduledGame]


class GamesSource(Protocol):
    def window(self, days_back: int, days_ahead: int) -> GameWindow: ...


def window_bounds(
    days_back: int, days_ahead: int, now: datetime | None = None
) -> tuple[date, date]:
    """The first and last day of the window, inclusive, in `GAME_TZ`."""
    today = (now or datetime.now(UTC)).astimezone(GAME_TZ).date()
    return today - timedelta(days=days_back), today + timedelta(days=days_ahead)


def each_day(since: date, until: date) -> list[date]:
    return [since + timedelta(days=n) for n in range((until - since).days + 1)]


def as_aware(moment: datetime) -> datetime:
    """A game's kickoff as an unambiguous instant.

    ESPN's dates come back with an offset and `dateutil` keeps it, so in
    practice this is a no-op. A naive one is read as a wall clock in `GAME_TZ`
    rather than as UTC -- the same face-value reading `app.batch` takes when it
    buckets games by day, and the only one that can't walk an evening game into
    the next date. Doing it here rather than at the edges means nothing
    downstream has to remember which kind it's holding.
    """
    if moment.tzinfo is None:
        return moment.replace(tzinfo=GAME_TZ)
    return moment


def game_day(moment: datetime) -> date:
    """The day a game belongs to, in the zone the jobs think in."""
    return as_aware(moment).astimezone(GAME_TZ).date()


class LocalGamesSource:
    """Reads a window from a JSON file instead of from endgame's bucket.

    `<root>/games/games.json` holds what the AWS source would have returned.
    Same trade as `LocalJobsSource`, and the same root, so one env var points
    local dev and the tests at every fixture.

    **Days are re-based so the newest completed game lands today.** A committed
    fixture cannot sit inside a window centred on today: without the shift the
    local page would be empty the day after anyone touched the file, which is
    exactly when it stops being worth running. Anchoring on the newest
    *completed* game rather than the newest game is what keeps the fixture's
    unplayed games in the future where they were written -- anchoring on the
    latest game of all would drag tomorrow's slate back onto today and leave
    nothing scheduled.

    Times of day are preserved, so an evening game stays an evening game.

    A missing file is an empty window, not an error: a checkout that hasn't
    seeded one should show a page with no games rather than a 502, which is
    what an unreadable bucket means.
    """

    def __init__(self, root: Path) -> None:
        self._dir = root / "games"

    def window(self, days_back: int, days_ahead: int) -> GameWindow:
        since, until = window_bounds(days_back, days_ahead)
        raw = self._load("games.json")

        try:
            games = [
                ScheduledGame.model_validate(item) for item in raw.get("games", [])
            ]
        except ValidationError as exc:
            raise GamesUnavailable(
                f"{self._dir / 'games.json'} is not readable game data"
            ) from exc

        offset = _fixture_offset(games)
        shifted = [_shift(game, offset) for game in games]
        in_window = [g for g in shifted if since <= g.day <= until]
        in_window.sort(key=lambda g: (g.start, g.league, g.game_id))
        return GameWindow(since=since, until=until, games=in_window)

    def _load(self, name: str) -> dict[str, Any]:
        path = self._dir / name
        try:
            loaded = json.loads(path.read_text())
        except FileNotFoundError:
            return {}
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise GamesUnavailable(f"{path} is not readable game data") from exc
        if not isinstance(loaded, dict):
            raise GamesUnavailable(f"{path} should hold an object")
        return loaded


def _fixture_offset(games: list[ScheduledGame]) -> timedelta:
    played = [g.day for g in games if g.completed]
    anchor = max(played, default=None) or max((g.day for g in games), default=None)
    if anchor is None:
        return timedelta()
    return timedelta(days=(datetime.now(GAME_TZ).date() - anchor).days)


def _shift(game: ScheduledGame, offset: timedelta) -> ScheduledGame:
    return game.model_copy(update={"start": game.start + offset})


@lru_cache(maxsize=1)
def _build_source(settings: Settings) -> GamesSource:
    """endgame's bucket when one is configured, otherwise the fixture file.

    Only the bucket, unlike `app.jobs` -- this reads no Batch, so there's no
    half-configured state to protect against. Cached like the other two
    sources, because the AWS one holds the caches that make this page
    affordable at all.
    """
    if settings.endgame_bucket:
        # Imported here so a local run doesn't pay boto3's import cost, the
        # same way app.releases defers app.s3.
        from app.seasons import AwsGamesSource

        return AwsGamesSource(
            bucket=settings.endgame_bucket,
            ttl_seconds=settings.games_cache_ttl_seconds,
        )
    return LocalGamesSource(settings.releases_root)


def get_games_source() -> GamesSource:
    """FastAPI dependency. Overridden in tests with a fake."""
    return _build_source(get_settings())
