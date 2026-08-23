"""The AWS half of the job health dashboard: Batch for outcomes, S3 for volume.

DESIGN.md section 12.1. Two upstreams behind one source, because the page wants
two things that live in different places:

- **Did the job work?** `batch:ListJobs` over the queue, filtered by creation
  time. Using a filter makes Batch ignore `jobStatus`, so one paginated call
  covers every status instead of one call per status.
- **Did it bring back data?** Object metadata under endgame's `odds/` and
  `seasons/` prefixes, plus the two kinds of object worth opening: the newest
  odds pull per league, and each league's current season file, which is
  unpickled and counted by game date. Season files are re-read only when their
  ETag moves -- once a day, when the job rewrites one -- so leaving the page
  open costs listings, not megabytes.

Everything is behind a TTL cache keyed by window size. The jobs move hourly at
most, and a dashboard someone leaves open must not turn into a steady stream of
ListJobs calls.

The IAM this needs is spelled out in section 12.2, along with what granting it
costs. Counting games spends the last of the two-bucket boundary: reading a
season means `s3:GetObject` on `seasons/*`, so the web tier can now read raw
scrape data. That was a deliberate call, not an oversight.
"""

import json
import logging
import pickle
import re
import threading
import time
from collections import Counter
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.jobs import (
    JobRun,
    JobsUnavailable,
    OddsDay,
    RunWindow,
    SeasonObject,
    Volume,
    window_start,
)

log = logging.getLogger(__name__)

# endgame stamps odds keys with the Chicago date (`_parse_date` in its cli),
# so the day prefixes we list have to be built in the same zone. Using UTC
# would ask for tomorrow's prefix all evening and miss the last pulls of
# today's.
JOB_TZ = ZoneInfo("America/Chicago")

# `{definition}-scheduled-run` is how EventBridge names a scheduled submission.
# Only used as a fallback when a job summary somehow arrives without its
# definition.
_SCHEDULED_SUFFIX = "-scheduled-run"

_SEASON_KEY = re.compile(
    r"^seasons/(?P<year>\d{4})/(?P<name>[^/]+?)\.(?P<ext>pkl|csv)$"
)

# How many pages of runs to walk before giving up and saying so. 100 per page,
# and eleven jobs at up to ~13 runs a day each is well under one page a day.
MAX_RUN_PAGES = 20


class AwsJobsSource:
    """Live reads against endgame's Batch queue and bucket.

    Safe to share across threads: FastAPI runs sync endpoints in a threadpool,
    so several requests can land here at once.
    """

    def __init__(
        self,
        queue: str,
        bucket: str,
        ttl_seconds: float = 60.0,
        batch_client: Any | None = None,
        s3_client: Any | None = None,
    ) -> None:
        self._queue = queue
        self._bucket = bucket
        self._ttl = ttl_seconds
        self._batch = (
            batch_client if batch_client is not None else boto3.client("batch")
        )
        self._s3 = s3_client if s3_client is not None else boto3.client("s3")
        self._lock = threading.Lock()
        self._runs: dict[int, tuple[RunWindow, float]] = {}
        self._volume: dict[int, tuple[Volume, float]] = {}
        # Keyed by object key, holding the ETag it was counted at. One entry
        # per season file, replaced when the job rewrites it, so this can't
        # grow with time the way an ETag-keyed cache would.
        self._season_games: dict[str, tuple[str, "_GameCounts"]] = {}

    # -- runs ------------------------------------------------------------

    def runs(self, days: int) -> RunWindow:
        cached = self._cached(self._runs, days)
        if cached is not None:
            return cached

        since = window_start(days)
        with _upstream("batch"):
            runs, truncated = self._list_runs(since)
        window = RunWindow(since=since, runs=runs, truncated=truncated)
        self._store(self._runs, days, window)
        return window

    def _list_runs(self, since: datetime) -> tuple[list[JobRun], bool]:
        """Every run created since `since`, across all statuses, and whether
        that's all of them.

        One filter is all ListJobs allows, and using one turns `jobStatus`
        off -- which is what makes a single pass over the queue possible
        rather than seven.
        """
        runs: list[JobRun] = []
        params: dict[str, Any] = {
            "jobQueue": self._queue,
            "maxResults": 100,
            "filters": [
                {
                    "name": "AFTER_CREATED_AT",
                    "values": [str(int(since.timestamp() * 1000))],
                }
            ],
        }

        for _ in range(MAX_RUN_PAGES):
            page = self._batch.list_jobs(**params)
            runs.extend(
                _parse_run(summary) for summary in page.get("jobSummaryList", [])
            )
            token = page.get("nextToken")
            if not token:
                return runs, False
            params["nextToken"] = token

        log.warning(
            "stopped after %d pages of Batch jobs; window is a sample", MAX_RUN_PAGES
        )
        return runs, True

    # -- volume ----------------------------------------------------------

    def volume(self, days: int) -> Volume:
        cached = self._cached(self._volume, days)
        if cached is not None:
            return cached

        since = window_start(days)
        with _upstream("s3"):
            volume = Volume(
                since=since,
                odds=self._odds_volume(days),
                seasons=self._season_volume(days),
            )
        self._store(self._volume, days, volume)
        return volume

    def _odds_volume(self, days: int) -> list[OddsDay]:
        """Per league, per day: how many pulls landed and how big they were.

        Listing `odds/{league}/{day}/` is one call per league per day, which at
        five leagues over a week is 35 cheap calls behind a TTL. The
        alternative -- one list of `odds/{league}/` -- walks every day of the
        season to answer about seven of them.
        """
        today = datetime.now(JOB_TZ).date()
        days_back = [today - timedelta(days=offset) for offset in range(days)]

        volume: list[OddsDay] = []
        for league in self._child_prefixes("odds/"):
            newest_key: str | None = None
            newest_at: datetime | None = None
            newest_day: OddsDay | None = None

            for day in days_back:
                objects = self._list_objects(f"odds/{league}/{day.isoformat()}/")
                if not objects:
                    continue
                latest = max(objects, key=lambda o: o["LastModified"])
                entry = OddsDay(
                    league=league,
                    day=day,
                    pulls=len(objects),
                    bytes=sum(int(o["Size"]) for o in objects),
                    latest_at=latest["LastModified"],
                )
                volume.append(entry)
                if newest_at is None or latest["LastModified"] > newest_at:
                    newest_key, newest_at, newest_day = (
                        latest["Key"],
                        latest["LastModified"],
                        entry,
                    )

            # One GET per league, for the newest pull anywhere in the window.
            if newest_key is not None and newest_day is not None:
                newest_day.latest_records = self._count_records(newest_key)

        volume.sort(key=lambda o: (o.league, o.day))
        return volume

    def _count_records(self, key: str) -> int | None:
        """How many odds were in one pull.

        Best-effort: a pull that can't be read or isn't a list still leaves the
        rest of the dashboard standing, because this number is a nicety and the
        counts around it aren't.
        """
        try:
            body = self._s3.get_object(Bucket=self._bucket, Key=key)["Body"].read()
            parsed = json.loads(body)
        except (ClientError, BotoCoreError, json.JSONDecodeError, UnicodeDecodeError):
            log.warning("could not count records in s3://%s/%s", self._bucket, key)
            return None
        return len(parsed) if isinstance(parsed, list) else None

    def _season_volume(self, days: int) -> list[SeasonObject]:
        """Size, freshness and game counts for the current season's artifacts.

        The two most recent years, not one: at a season boundary the new year's
        prefix exists before every league has written into it, and blanking the
        table for a week in August isn't worth the tidier query.
        """
        years = sorted(self._child_prefixes("seasons/"), reverse=True)[:2]
        today = datetime.now(JOB_TZ).date()
        window_start = today - timedelta(days=days - 1)

        seasons: list[SeasonObject] = []
        for year in years:
            for obj in self._list_objects(f"seasons/{year}/"):
                parsed = _parse_season_key(obj["Key"])
                if parsed is None:
                    continue
                league, artifact = parsed
                # Only the games pickle holds games. The CSVs beside it are
                # possessions and box-score rows, and a count there would read
                # as a number of games.
                counts = (
                    self._game_counts(obj["Key"], str(obj.get("ETag", "")))
                    if artifact == "games"
                    else None
                )
                seasons.append(
                    SeasonObject(
                        league=league,
                        year=int(year),
                        artifact=artifact,
                        key=obj["Key"],
                        bytes=int(obj["Size"]),
                        last_modified=obj["LastModified"],
                        games=counts.total if counts else None,
                        games_today=(
                            counts.completed_between(today, today) if counts else None
                        ),
                        games_in_window=(
                            counts.completed_between(window_start, today)
                            if counts
                            else None
                        ),
                    )
                )

        seasons.sort(key=lambda s: (-s.year, s.league, s.artifact))
        return seasons

    def _game_counts(self, key: str, etag: str) -> "_GameCounts | None":
        """Games in one season file, counted per day and cached by ETag.

        A season object is rewritten once a day, so its ETag is the exact
        signal for "worth reading again". Between rewrites this is free, which
        is what makes counting affordable in a request path at all -- the
        objection in section 1 is to reading these on every request, not to
        reading one.

        Counting per *day* rather than per window means the picker can move
        without re-reading anything.
        """
        cached = self._season_games.get(key)
        if cached is not None and cached[0] == etag:
            return cached[1]

        counts = self._count_games(key)
        if counts is not None:
            with self._lock:
                self._season_games[key] = (etag, counts)
        return counts

    def _count_games(self, key: str) -> "_GameCounts | None":
        """Read one season pickle and count what's in it.

        Best-effort, and deliberately not fatal: a season that can't be read
        leaves its row showing size and freshness, which is what this table
        was before it could count. That also means the counts appear on their
        own when `s3:GetObject` on `seasons/*` lands, rather than the whole
        volume endpoint failing until it does.
        """
        try:
            raw = self._s3.get_object(Bucket=self._bucket, Key=key)["Body"].read()
        except (ClientError, BotoCoreError) as exc:
            log.warning("could not read s3://%s/%s: %s", self._bucket, key, exc)
            return None

        try:
            loaded = pickle.loads(raw)
        except Exception as exc:  # noqa: BLE001 - see below
            # Unpickling someone else's object graph can fail in essentially
            # any way: a moved class, a renamed field, a truncated body. All of
            # them mean the same thing here -- no counts for this file -- and
            # none of them should take the dashboard down with them.
            log.warning("could not unpickle s3://%s/%s: %s", self._bucket, key, exc)
            return None

        # `save_to_s3` writes a list of seasons; tolerate a bare one.
        seasons = loaded if isinstance(loaded, list) else [loaded]

        total = 0
        completed: Counter[date] = Counter()
        for season in seasons:
            for week in getattr(season, "weeks", []):
                for game in week.games:
                    total += 1
                    # Scheduled-but-unplayed games are in the file too, and
                    # they'd make an empty scrape look like a full one.
                    if game.completed:
                        completed[_game_day(game.date)] += 1

        return _GameCounts(total=total, completed_by_day=dict(completed))

    # -- s3 helpers ------------------------------------------------------

    def _child_prefixes(self, prefix: str) -> list[str]:
        names: list[str] = []
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(
            Bucket=self._bucket, Prefix=prefix, Delimiter="/"
        ):
            for entry in page.get("CommonPrefixes", []):
                names.append(entry["Prefix"][len(prefix) :].rstrip("/"))
        return sorted(names)

    def _list_objects(self, prefix: str) -> list[Mapping[str, Any]]:
        objects: list[Mapping[str, Any]] = []
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            objects.extend(page.get("Contents", []))
        return objects

    # -- cache -----------------------------------------------------------

    def _cached[T](self, store: dict[int, tuple[T, float]], days: int) -> T | None:
        with self._lock:
            hit = store.get(days)
        if hit is None or (time.monotonic() - hit[1]) >= self._ttl:
            return None
        return hit[0]

    def _store[T](self, store: dict[int, tuple[T, float]], days: int, value: T) -> None:
        with self._lock:
            store[days] = (value, time.monotonic())


@contextmanager
def _upstream(name: str) -> Iterator[None]:
    """Turns a boto failure into the one exception the API layer knows about.

    Named after which upstream, because "AccessDenied" reads very differently
    depending on whether it came from the queue or the bucket -- and after
    section 12.2 those are two separate grants that can go missing one at a
    time.
    """
    try:
        yield
    except (ClientError, BotoCoreError) as exc:
        log.warning("%s read failed: %s", name, exc)
        raise JobsUnavailable(f"could not read {name}: {exc}") from exc


@dataclass(frozen=True)
class _GameCounts:
    """Everything in a season file, plus completed games by day."""

    total: int
    completed_by_day: Mapping[date, int]

    def completed_between(self, start: date, end: date) -> int:
        return sum(n for day, n in self.completed_by_day.items() if start <= day <= end)


def _game_day(moment: datetime) -> date:
    """The day a game belongs to, in the zone the jobs think in.

    endgame's game dates arrive naive from ESPN. A naive one is taken at face
    value rather than assumed to be UTC: converting it would walk evening games
    into the next day, which is exactly the boundary "games today" turns on.
    """
    if moment.tzinfo is None:
        return moment.date()
    return moment.astimezone(JOB_TZ).date()


def _parse_run(summary: dict[str, Any]) -> JobRun:
    name = summary.get("jobName", "")
    return JobRun(
        job_id=summary["jobId"],
        name=name,
        definition=_definition_name(summary.get("jobDefinition"), name),
        status=summary.get("status", "UNKNOWN"),
        created_at=_moment(summary.get("createdAt")) or datetime.now(UTC),
        started_at=_moment(summary.get("startedAt")),
        stopped_at=_moment(summary.get("stoppedAt")),
        # `statusReason` is the scheduler's summary ("Essential container in
        # task exited"); the container's own reason is the useful half when
        # there is one.
        status_reason=(summary.get("container") or {}).get("reason")
        or summary.get("statusReason"),
        exit_code=(summary.get("container") or {}).get("exitCode"),
    )


def _definition_name(arn: str | None, job_name: str) -> str:
    """`daily-games-nfl` out of the ARN, or out of the run's name.

    The ARN carries a revision (`.../daily-games-nfl:3`), which is dropped: a
    job's history shouldn't split in two the day its definition is re-registered.
    """
    if arn:
        return arn.rsplit("/", 1)[-1].split(":")[0]
    return job_name.removesuffix(_SCHEDULED_SUFFIX)


def _moment(millis: Any) -> datetime | None:
    """Batch timestamps are epoch milliseconds."""
    if millis is None:
        return None
    if isinstance(millis, datetime):
        return millis
    return datetime.fromtimestamp(int(millis) / 1000, tz=UTC)


def _parse_season_key(key: str) -> tuple[str, str] | None:
    """(league, artifact) for a season object, or None for anything else.

    The ncaabb jobs write three things per season and the rest write one, so
    the artifact is what the suffix says rather than something the caller has
    to know per league.
    """
    match = _SEASON_KEY.match(key)
    if match is None:
        return None
    name, ext = match.group("name"), match.group("ext")
    if ext == "pkl":
        return name, "games"
    if name.endswith("_box"):
        return name.removesuffix("_box"), "box_scores"
    return name, "possessions"
