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
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from typing import Any, NamedTuple

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.endgame_pickle import load_seasons, numbered_weeks
from app.games import (
    MAX_DAYS_AHEAD,
    MAX_DAYS_BACK,
    GamesUnavailable,
    GameWindow,
    PlayedGame,
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

# How many single old games to keep built. A page view is one entry, and an
# entry is one `ScheduledGame` -- the cap is there because the key is a game
# id rather than because the rows are large.
MAX_CACHED_ROWS = 256

# What S3 says when the object isn't there. `get_object` raises for both, and
# a season a link names but nothing has written is a miss rather than the
# outage `_upstream` turns a ClientError into.
_MISSING = {"NoSuchKey", "404"}


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
        # One row per old game anybody has opened a page for. See
        # `find_in_season` for why this is rows and the one above is seasons.
        self._rows: OrderedDict[tuple[str, str], ScheduledGame] = OrderedDict()

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

    def find_in_season(
        self, league: str, game_id: str, season: int
    ) -> ScheduledGame | None:
        """One game out of one season file, built and kept on its own.

        Three reads, cheapest first.

        The cached season's own rows answer for anything inside the horizon,
        which is the case where this is called at all only because the window
        was searched by league and came back empty for another one.

        Then this method's own cache, which holds *rows* rather than seasons:
        a game that has been played never changes, so a reader reloading an
        old game page pays the pickle once. Bounded, because the key is a game
        id and there are hundreds of thousands of those.

        Then the file. `_find_row` walks it and builds exactly one
        `ScheduledGame`, which is the whole reason reaching past the horizon is
        affordable: what took the endpoint down was a *cache* of rows for every
        game of every league and season, and one row for one game is four
        orders of magnitude off that. The unpickled graph is transient, the
        same way `app.batch`'s is.

        No line. The spread lives in the odds objects for the day the game was
        played, which is a listing and two reads per game page for a number
        that is only on the board while the game is (`_spreads`). A game this
        old shows the score and the forecast without one.
        """
        key = f"seasons/{season}/{league}.pkl"
        cached = self._seasons.get(key)
        if cached is not None:
            for rows in cached[1].by_day.values():
                for game in rows:
                    if game.game_id == game_id:
                        return game

        with self._lock:
            found = self._rows.get((league, game_id))
        if found is not None:
            return found

        with _upstream("s3"):
            row = self._read_one(key, league, game_id)
        if row is None:
            return None

        with self._lock:
            self._rows[(league, game_id)] = row
            self._rows.move_to_end((league, game_id))
            while len(self._rows) > MAX_CACHED_ROWS:
                self._rows.popitem(last=False)
        return row

    def _read_one(self, key: str, league: str, game_id: str) -> ScheduledGame | None:
        """One season file, walked for one game. Best-effort like the rest."""
        try:
            raw = self._s3.get_object(Bucket=self._bucket, Key=key)["Body"].read()
        except ClientError as exc:
            # A season nobody has written is an ordinary miss here rather than
            # an outage: a link can name a year this league has no file for.
            if exc.response.get("Error", {}).get("Code") in _MISSING:
                log.info("no season file at s3://%s/%s", self._bucket, key)
                return None
            raise

        try:
            seasons = load_seasons(raw)
        except Exception as exc:  # noqa: BLE001 - unpickling a foreign graph
            log.warning("could not unpickle s3://%s/%s: %s", self._bucket, key, exc)
            return None

        try:
            return _find_row(seasons, league, game_id)
        except Exception as exc:  # noqa: BLE001 - a foreign, evolving Game
            log.warning("could not walk s3://%s/%s: %s", self._bucket, key, exc)
            return None

    def season_schedule(self, league: str, season: int) -> list[PlayedGame]:
        """One season file's whole schedule, at three fields a game.

        Usually free. A game page is reached from the games table, so the file
        it needs has already been unpickled to build that window and the
        schedule was kept in the same walk -- this is a dict lookup. Only a
        cold page pays a list and a read.

        A cached entry is used without re-checking its ETag, unlike `window`'s.
        What this is for is when each side last *played*, and a game that has
        been played does not move; the file is re-read on the next window
        anyway, so the schedule is never more than one rewrite behind.

        An empty list for a season nothing was found for, which the caller
        reads as "can't say" rather than as "nobody was rested".
        """
        key = f"seasons/{season}/{league}.pkl"
        cached = self._seasons.get(key)
        if cached is not None:
            return cached[1].schedule

        with _upstream("s3"):
            objects = _list_objects(self._s3, self._bucket, key)
            if not objects:
                return []
            loaded = self._season_games(
                key,
                league,
                str(objects[0].get("ETag", "")),
                window_bounds(MAX_DAYS_BACK, MAX_DAYS_AHEAD),
            )
        return [] if loaded is None else loaded.schedule

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
            seasons = load_seasons(raw)
        except Exception as exc:  # noqa: BLE001 - unpickling a foreign graph
            log.warning("could not unpickle s3://%s/%s: %s", self._bucket, key, exc)
            return None

        try:
            pooled = _pool_games(seasons, league, horizon)
        except Exception as exc:  # noqa: BLE001 - see the docstring
            # Not the same failure as an unreadable body: the file parsed and
            # its *shape* is wrong -- a season with no `weeks`, a week with no
            # `games`. A `Game` gaining a field no longer lands here (or
            # anywhere): `app.endgame_pickle` reads one by field order, so an
            # appended field is dropped rather than fatal.
            log.warning("could not walk s3://%s/%s: %s", self._bucket, key, exc)
            return None

        by_day: dict[date, list[ScheduledGame]] = {}
        for row in pooled.rows.values():
            by_day.setdefault(row.day, []).append(row)
        return _SeasonGames(
            by_day=by_day,
            schedule=pooled.schedule,
            since=horizon[0],
            until=horizon[1],
        )

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

    `schedule` is the exception, and deliberately not bounded by the horizon:
    it is the whole season at three fields a game, which is what rest has to
    look back over. `covers` says nothing about it, because it always covers.
    """

    by_day: Mapping[date, list[ScheduledGame]]
    schedule: list[PlayedGame]
    since: date
    until: date

    def covers(self, horizon: tuple[date, date]) -> bool:
        return self.since <= horizon[0] and horizon[1] <= self.until


class _Pooled(NamedTuple):
    """What one walk of a season file keeps: the window's rows, and the dates.

    Two spans out of one pass, because they cost very different amounts.
    `rows` is the horizon only -- building a `ScheduledGame` is the expensive
    part and all but a few days of the file is thrown away. `schedule` is the
    *whole* season at a date and two names per game, which is what rest needs
    and what nothing else in the file is cheap enough to keep.
    """

    rows: dict[str, ScheduledGame]
    schedule: list[PlayedGame]


def _pool_games(seasons: Any, league: str, horizon: tuple[date, date]) -> _Pooled:
    """The games of `seasons` near today, pooled by game id -- and every date.

    Pooled because the same game can be fetched twice -- a cross-division
    matchup comes back under both divisions -- and the copies aren't
    guaranteed to agree. The completed copy wins: one of them may predate the
    final whistle.

    The day is computed from the raw `Game` and checked *before* a row is
    built, which is the whole point: the conversion is what costs memory, and
    all but a few days of a season file is thrown away.

    The schedule is taken *before* that check, from the raw game, because who
    is rested is a question about the season rather than about the window: a
    side coming off a bye last played a fortnight ago, which is a week outside
    the widest horizon this API serves. Reading only the window would answer
    "nobody was rested" for precisely the games where somebody was. Three
    fields is what makes that affordable -- see `PlayedGame`.
    """
    since, until = horizon
    pooled: dict[str, ScheduledGame] = {}
    schedule: dict[str, PlayedGame] = {}
    skipped = 0
    first_failure: Exception | None = None

    for season in seasons:
        year = getattr(season, "year", None)
        for number, games in numbered_weeks(season):
            for game in games:
                # Pooled by id like the rows, and for the same reason: a
                # cross-division game arrives twice and must not read as two
                # games a team played on the same day.
                try:
                    schedule[game.game_id] = PlayedGame(
                        date=as_aware(game.date),
                        home=game.home,
                        away=game.away,
                        completed=game.completed,
                    )
                except Exception:  # noqa: BLE001 - a foreign, evolving Game
                    # Counted with the rows below rather than separately: a
                    # game this can't read is one the row build can't either.
                    pass
                if not since <= game_day(game.date) <= until:
                    continue
                try:
                    row = _to_row(game, league, season=year, week=number)
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
    return _Pooled(rows=pooled, schedule=sorted(schedule.values()))


def _find_row(seasons: Any, league: str, game_id: str) -> ScheduledGame | None:
    """One game out of a whole season file, as a row -- and nothing else.

    The counterpart to `_pool_games`, and the difference is the point: that
    one builds every row in the horizon and this builds at most one. A season
    file is the whole schedule, so the id is checked against the raw `Game`
    before anything is converted.

    Pooled like `_pool_games` pools, for the same reason: a cross-division
    game is in the file twice and the copies need not agree, so the walk
    continues past a first match and the completed copy wins. The year and the
    week come from where it was found, which is the only place they exist.
    """
    found: ScheduledGame | None = None
    for season in seasons:
        year = getattr(season, "year", None)
        for number, games in numbered_weeks(season):
            for game in games:
                if game.game_id != game_id:
                    continue
                row = _to_row(game, league, season=year, week=number)
                if found is None or (row.completed and not found.completed):
                    found = row
    return found


def _to_row(
    game: Any, league: str, season: int | None = None, week: int | None = None
) -> ScheduledGame:
    """One endgame `Game` in the shape this app serves.

    The scores are dropped until the game is completed, and that is now the
    common case rather than the edge one: the jobs write the games ESPN hasn't
    finished as well as the ones it has, and every one of those carries 0-0.
    Passing it through would render tonight's slate as a column of scoreless
    finals -- and a game *in progress* would render its partial score as a
    final, which is worse, because it looks right.

    `status` is what makes the empty score readable. `completed` says only
    result / not-a-result; a game with no result is scheduled, in progress,
    postponed or cancelled, and those are four different rows.

    `season` and `week` are the file's own, carried through so the plays for
    this game can be found later: they are the partition the processed
    play-by-play is written under, and the season file is the only place that
    says which one a game is in.
    """
    return ScheduledGame(
        league=league,
        season=season,
        week=week,
        game_id=game.game_id,
        start=as_aware(game.date),
        home=game.home,
        away=game.away,
        neutral=game.neutral_site,
        completed=game.completed,
        status=game.status,
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
