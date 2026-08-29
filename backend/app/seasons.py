"""The AWS half of the games page: season pickles for games, odds for the line.

DESIGN.md section 13.1. Both live in endgame's bucket, under the two prefixes
section 12.2 already granted this app -- so the games page costs no new IAM.
What it does cost is reading the season files for their *contents* rather than
their counts, which is the same objects `app.batch` already unpickles.

Three things keep that affordable in a request path:

- **ETag, not TTL, decides when a season is re-read.** A season object is
  rewritten once a day, and its ETag says so exactly. Between rewrites the
  games are free, and only the odds are re-fetched.
- **Games are cached grouped by day**, so moving the window picker re-reads
  nothing.
- **Two odds objects per league per day, not thirteen.** The last pull of a day
  carries the most settled line; the first is the fallback for a game the board
  had already dropped by the last one, which is exactly the finished games this
  page most wants a line for. Reading every hourly pull in the window would be
  ~200 objects for a number that moves by half a point.
"""

import json
import logging
import pickle
import re
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.games import (
    MAX_DAYS_AHEAD,
    MAX_DAYS_BACK,
    GamesUnavailable,
    GameWindow,
    ScheduledGame,
    as_aware,
    each_day,
    game_day,
    window_bounds,
)

log = logging.getLogger(__name__)

# Only the games pickle. The CSVs beside it are possession and box-score rows,
# and cassandra reads seasons out of exactly this shape (`_SEASON_KEY_RE` in
# its save_predictions).
_SEASON_KEY = re.compile(r"^seasons/(?P<year>\d{4})/(?P<league>[^/]+)\.pkl$")

# The two most recent season prefixes, for the reason `_season_volume` reads
# two: at a season boundary the new year's prefix exists before every league
# has written into it, and a page that goes blank for a week in August isn't
# worth the tidier query.
_SEASON_YEARS = 2


class AwsGamesSource:
    """Live reads against endgame's bucket.

    Safe to share across threads: FastAPI runs sync endpoints in a threadpool,
    so several requests can land here at once.
    """

    def __init__(
        self,
        bucket: str,
        ttl_seconds: float = 300.0,
        s3_client: Any | None = None,
    ) -> None:
        self._bucket = bucket
        self._ttl = ttl_seconds
        self._s3 = s3_client if s3_client is not None else boto3.client("s3")
        self._lock = threading.Lock()
        self._windows: dict[tuple[int, int], tuple[GameWindow, float]] = {}
        # Keyed by object key, holding the ETag its games were read at. One
        # entry per season file, replaced when the daily job rewrites it, so
        # this can't grow with time the way an ETag-keyed cache would.
        self._seasons: dict[str, tuple[str, "_SeasonGames"]] = {}

    def window(self, days_back: int, days_ahead: int) -> GameWindow:
        cached = self._cached(days_back, days_ahead)
        if cached is not None:
            return cached

        since, until = window_bounds(days_back, days_ahead)
        with _upstream("s3"):
            games = self._games(since, until)
            spreads = self._spreads(since, until)

        priced = [
            game.model_copy(update={"market_spread": spreads.get(game.game_id)})
            for game in games
        ]
        priced.sort(key=lambda g: (g.start, g.league, g.game_id))
        window = GameWindow(since=since, until=until, games=priced)
        with self._lock:
            self._windows[(days_back, days_ahead)] = (window, time.monotonic())
        return window

    # -- games -----------------------------------------------------------

    def _games(self, since: date, until: date) -> list[ScheduledGame]:
        years = sorted(_child_prefixes(self._s3, self._bucket, "seasons/"))
        horizon = window_bounds(MAX_DAYS_BACK, MAX_DAYS_AHEAD)
        days = each_day(since, until)

        games: list[ScheduledGame] = []
        for year in years[-_SEASON_YEARS:]:
            for obj in _list_objects(self._s3, self._bucket, f"seasons/{year}/"):
                match = _SEASON_KEY.match(obj["Key"])
                if match is None:
                    continue
                season = self._season_games(
                    obj["Key"], match.group("league"), str(obj.get("ETag", "")), horizon
                )
                if season is None:
                    continue
                for day in days:
                    games.extend(season.by_day.get(day, ()))
        return games

    def _season_games(
        self, key: str, league: str, etag: str, horizon: tuple[date, date]
    ) -> "_SeasonGames | None":
        cached = self._seasons.get(key)
        # The horizon moves at midnight, so a cache entry whose ETag still
        # matches can stop covering the days being asked for. Re-reading then
        # is one GET a day, which is the same order as the rewrite itself.
        if cached is not None and cached[0] == etag and cached[1].covers(horizon):
            return cached[1]

        season = self._read_season(key, league, horizon)
        if season is not None:
            with self._lock:
                self._seasons[key] = (etag, season)
        return season

    def _read_season(
        self, key: str, league: str, horizon: tuple[date, date]
    ) -> "_SeasonGames | None":
        """The games near today out of one season file, grouped by day.

        **Only the games in `horizon`.** A season file is the whole schedule,
        and no request this API accepts can reach past a week either side of
        today -- so building a row for every game in the file spends hundreds
        of megabytes to answer about fifteen days of it. That is what took the
        endpoint down: a season pickle costs ~15x its own size once its games
        are pydantic models, the cache held every one of them for every league
        and both seasons, and the service has 0.5 GB. `app.batch` walks these
        same objects without trouble because it keeps a count per day and
        throws the graph away; this now keeps about as little.

        Best-effort at three levels, for the reason `app.batch._count_games`
        is: a season that can't be read costs that league its games, and a
        game that can't be read costs that game -- neither takes the page.
        """
        try:
            raw = self._s3.get_object(Bucket=self._bucket, Key=key)["Body"].read()
        except (ClientError, BotoCoreError) as exc:
            log.warning("could not read s3://%s/%s: %s", self._bucket, key, exc)
            return None

        try:
            loaded = pickle.loads(raw)
        except Exception as exc:  # noqa: BLE001 - unpickling a foreign graph
            log.warning("could not unpickle s3://%s/%s: %s", self._bucket, key, exc)
            return None

        # `save_to_s3` writes a list of seasons; tolerate a bare one.
        seasons = loaded if isinstance(loaded, list) else [loaded]

        try:
            pooled = _pool_games(seasons, league, horizon)
        except Exception as exc:  # noqa: BLE001 - see the docstring
            # Not the same failure as an unreadable body: the file parsed and
            # its shape is wrong, which is what a Game gaining or losing a
            # field upstream looks like from here.
            log.warning("could not walk s3://%s/%s: %s", self._bucket, key, exc)
            return None

        by_day: dict[date, list[ScheduledGame]] = {}
        for row in pooled.values():
            by_day.setdefault(row.day, []).append(row)
        return _SeasonGames(by_day=by_day, since=horizon[0], until=horizon[1])

    # -- odds ------------------------------------------------------------

    def _spreads(self, since: date, until: date) -> dict[str, float]:
        """game_id -> spread, for every league's pulls over the window.

        Keyed by ESPN's competition id, so the two ways ncaabb is keyed never
        come up: an `odds/ncaabb/` pull lines up with a `mens.pkl` game by id
        alone.

        Days are walked oldest first and later pulls overwrite earlier ones, so
        a game keeps the freshest line anyone posted for it -- including
        tomorrow's games, whose only pulls are today's.
        """
        spreads: dict[str, float] = {}
        for league in _child_prefixes(self._s3, self._bucket, "odds/"):
            for day in each_day(since, until):
                prefix = f"odds/{league}/{day.isoformat()}/"
                objects = _list_objects(self._s3, self._bucket, prefix)
                if not objects:
                    continue
                pulls = sorted(objects, key=lambda o: (o["LastModified"], o["Key"]))
                for obj in _first_and_last(pulls):
                    spreads.update(self._read_odds(obj["Key"]))
        return spreads

    def _read_odds(self, key: str) -> dict[str, float]:
        """One pull, as game_id -> spread.

        Best-effort like everything else that opens a foreign object: a pull
        that won't parse costs those games their line, and the schedule and
        scores around it still render.
        """
        try:
            raw = self._s3.get_object(Bucket=self._bucket, Key=key)["Body"].read()
            parsed = json.loads(raw)
        except (ClientError, BotoCoreError, json.JSONDecodeError, UnicodeDecodeError):
            log.warning("could not read odds at s3://%s/%s", self._bucket, key)
            return {}
        if not isinstance(parsed, list):
            return {}
        return dict(_parse_odds(parsed))

    # -- cache -----------------------------------------------------------

    def _cached(self, days_back: int, days_ahead: int) -> GameWindow | None:
        with self._lock:
            hit = self._windows.get((days_back, days_ahead))
        if hit is None or (time.monotonic() - hit[1]) >= self._ttl:
            return None
        return hit[0]


@dataclass(frozen=True)
class _SeasonGames:
    """One season file's games near today, grouped by the day they belong to.

    `since`/`until` are the horizon the file was read for, not a property of
    the file: everything outside it was skipped rather than kept, so a cache
    entry can only answer for the span it was built over.
    """

    by_day: Mapping[date, list[ScheduledGame]]
    since: date
    until: date

    def covers(self, horizon: tuple[date, date]) -> bool:
        return self.since <= horizon[0] and horizon[1] <= self.until


def _pool_games(
    seasons: Any, league: str, horizon: tuple[date, date]
) -> dict[str, ScheduledGame]:
    """The games of `seasons` that fall inside `horizon`, pooled by game id.

    Pooled because the same game can be fetched twice -- a cross-division
    matchup comes back under both divisions -- and the copies aren't
    guaranteed to agree. The completed copy wins: one of them may predate the
    final whistle.

    The day is computed from the raw `Game` and checked *before* a row is
    built, which is the whole point: the conversion is what costs memory, and
    all but a few days of a season file is thrown away.
    """
    since, until = horizon
    pooled: dict[str, ScheduledGame] = {}
    skipped = 0
    first_failure: Exception | None = None

    for season in seasons:
        for week in getattr(season, "weeks", []):
            for game in week.games:
                if not since <= game_day(game.date) <= until:
                    continue
                try:
                    row = _to_row(game, league)
                except Exception as exc:  # noqa: BLE001 - a foreign, evolving Game
                    skipped += 1
                    # The count on its own says a game was dropped without
                    # saying what about it we couldn't read, which is the
                    # half that would let anyone fix it. One example is
                    # enough -- they fail the same way -- and it goes out
                    # with a traceback.
                    if first_failure is None:
                        first_failure = exc
                    continue
                seen = pooled.get(row.game_id)
                if seen is None or (row.completed and not seen.completed):
                    pooled[row.game_id] = row

    if skipped:
        log.warning(
            "skipped %d unreadable %s games in the window; first was: %r",
            skipped,
            league,
            first_failure,
            exc_info=first_failure,
        )
    return pooled


def _to_row(game: Any, league: str) -> ScheduledGame:
    """One endgame `Game` in the shape this app serves.

    The scores are dropped until the game is completed. A season file stores 0
    for an unplayed game, and passing that through would render tonight's
    schedule as a column of 0-0 finals.
    """
    return ScheduledGame(
        league=league,
        game_id=game.game_id,
        start=as_aware(game.date),
        home=game.home,
        away=game.away,
        neutral=game.neutral_site,
        completed=game.completed,
        home_score=game.home_score if game.completed else None,
        away_score=game.away_score if game.completed else None,
    )


def _parse_odds(parsed: list[Any]) -> Iterator[tuple[str, float]]:
    """The (game_id, spread) pairs in one pull, skipping anything malformed.

    The shape is endgame's `espn_odds.Odds`: a competition id and ESPN's own
    odds list, whose first entry is the one cassandra reads. Entries without a
    numeric spread are skipped rather than defaulted -- a missing line and a
    pick'em are not the same claim.
    """
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        game_id = entry.get("competition_id")
        odds = entry.get("odds")
        if not isinstance(game_id, str) or not isinstance(odds, list) or not odds:
            continue
        first = odds[0]
        spread = first.get("spread") if isinstance(first, dict) else None
        if isinstance(spread, bool) or not isinstance(spread, (int, float)):
            continue
        yield game_id, float(spread)


def _first_and_last(pulls: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The two pulls of a day worth opening, oldest first.

    The last one has the most settled line. The first is there for the game the
    board had already taken down by the last pull, which on a day that's
    already been played is most of them.
    """
    if len(pulls) < 2:
        return list(pulls)
    return [pulls[0], pulls[-1]]


def _child_prefixes(s3: Any, bucket: str, prefix: str) -> list[str]:
    """The directory-ish names one level under `prefix`."""
    names: list[str] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        for entry in page.get("CommonPrefixes", []):
            names.append(entry["Prefix"][len(prefix) :].rstrip("/"))
    return sorted(names)


def _list_objects(s3: Any, bucket: str, prefix: str) -> list[Mapping[str, Any]]:
    objects: list[Mapping[str, Any]] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        objects.extend(page.get("Contents", []))
    return objects


@contextmanager
def _upstream(name: str) -> Iterator[None]:
    """Turns a boto failure into the one exception the API layer knows about."""
    try:
        yield
    except (ClientError, BotoCoreError) as exc:
        log.warning("%s read failed: %s", name, exc)
        raise GamesUnavailable(f"could not read {name}: {exc}") from exc
