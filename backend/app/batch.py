"""The AWS half of the job health dashboard: Batch for outcomes, S3 for volume.

DESIGN.md section 12.1. Two upstreams behind one source, because the page wants
two things that live in different places:

- **Did the job work?** `batch:ListJobs` over the queue, filtered by creation
  time. Using a filter makes Batch ignore `jobStatus`, so one paginated call
  covers every status instead of one call per status.
- **Did it bring back data?** Object metadata under endgame's `odds/` and
  `seasons/` prefixes. Listing answers most of it without reading anything;
  only the newest odds object per league is opened, because it's small and it's
  the one number on the page that's a real record count.

Everything is behind a TTL cache keyed by window size. The jobs move hourly at
most, and a dashboard someone leaves open must not turn into a steady stream of
ListJobs calls.

The IAM this needs is spelled out in section 12.2, along with what granting it
costs -- `seasons/*` is list-only on purpose, so the web tier still can't read
raw scrape data.
"""

import json
import logging
import re
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
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
                seasons=self._season_volume(),
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

    def _season_volume(self) -> list[SeasonObject]:
        """Size and freshness of the current season's artifacts.

        The two most recent years, not one: at a season boundary the new year's
        prefix exists before every league has written into it, and blanking the
        table for a week in August isn't worth the tidier query.
        """
        years = sorted(self._child_prefixes("seasons/"), reverse=True)[:2]

        seasons: list[SeasonObject] = []
        for year in years:
            for obj in self._list_objects(f"seasons/{year}/"):
                parsed = _parse_season_key(obj["Key"])
                if parsed is None:
                    continue
                league, artifact = parsed
                seasons.append(
                    SeasonObject(
                        league=league,
                        year=int(year),
                        artifact=artifact,
                        key=obj["Key"],
                        bytes=int(obj["Size"]),
                        last_modified=obj["LastModified"],
                    )
                )

        seasons.sort(key=lambda s: (-s.year, s.league, s.artifact))
        return seasons

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
