"""Health of the Batch jobs that produce the data underneath the releases.

DESIGN.md section 12. The eleven scheduled jobs live in endgame's repo and
write to endgame's bucket; nothing in this app has ever looked at them, and the
only signal that a scrape stopped working is a failure email. This module is
the read side of that: runs grouped by job definition, plus how much data the
results carry.

Two things shape everything here.

**Batch forgets.** Completed job records survive about a week, so every number
on this page is "over the last few days", and the window is capped to match
(section 12.3). A longer history needs runs persisted as they finish, which is
a different design.

**Grouping is by job definition, not by job name.** EventBridge submits each
run as `{definition}-scheduled-run`, so names are near-useless for grouping,
while the definition is exactly the unit a schedule is attached to. It also
means the refresh job (section 5a) shows up here the day it lands without a
change in this file.

The source is a Protocol for the same reason `ReleaseStore` is: tests and local
dev get a fixture-backed implementation, and neither needs AWS.
"""

import json
import logging
from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, ValidationError, computed_field

from app.settings import Settings, get_settings

log = logging.getLogger(__name__)

# Batch keeps completed job records for roughly this long, so a longer window
# would answer with the same data under a bigger number (section 12.3).
MAX_WINDOW_DAYS = 7
DEFAULT_WINDOW_DAYS = 7

# The two statuses a run stops in. Everything else -- SUBMITTED, PENDING,
# RUNNABLE, STARTING, RUNNING -- is still in flight and counts toward neither
# side of the success rate.
SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"

# How many runs of each job the response carries. Enough to see a pattern in
# the hourly odds jobs, without sending a week of them to a table that shows
# one row per job.
RECENT_RUNS = 8

_GAMES_PREFIX = "daily-games-"
_ODDS_PREFIX = "odds-"


class JobsUnavailable(RuntimeError):
    """The upstream -- Batch, or endgame's bucket -- couldn't be read.

    Kept distinct from an empty result: "no runs in the window" is a fact about
    the jobs, "AccessDenied" is a fact about us, and rendering the second as
    the first would show a reassuring empty dashboard while the app has no idea
    what the jobs are doing.
    """


class JobRun(BaseModel):
    """One Batch job run."""

    job_id: str
    name: str
    definition: str
    status: str
    created_at: datetime
    started_at: datetime | None = None
    stopped_at: datetime | None = None
    status_reason: str | None = None
    exit_code: int | None = None

    @computed_field
    @property
    def duration_seconds(self) -> float | None:
        """Wall time in the container, not counting time spent RUNNABLE.

        Queue wait is a property of the queue rather than of the job, and
        folding it in would make every job look slow whenever something big is
        ahead of it.
        """
        if self.started_at is None or self.stopped_at is None:
            return None
        return (self.stopped_at - self.started_at).total_seconds()


class JobHealth(BaseModel):
    """One job definition's runs over the window, rolled up."""

    name: str
    kind: str
    league: str | None
    runs: int
    succeeded: int
    failed: int
    running: int
    success_rate: float | None
    last_run: JobRun | None
    last_success_at: datetime | None
    recent: list[JobRun]


class OddsDay(BaseModel):
    """One league's odds pulls on one day.

    `pulls` and `bytes` come from listing alone. `latest_records` is the only
    true record count on the dashboard -- odds objects are small and immutable,
    so the newest one per league is cheap to open and count (section 12.4).
    """

    league: str
    day: date
    pulls: int
    bytes: int
    latest_at: datetime | None = None
    latest_records: int | None = None


class SeasonObject(BaseModel):
    """A season artifact's size and freshness.

    Deliberately not a game count: a season is one pickle rewritten in place,
    and counting what's inside it means reading megabytes, which section 1
    rules out in a request path. So this answers "did today's run write
    something, and was it bigger than before" -- freshness, with bytes as a
    proxy for volume that the UI shouldn't dress up as a count.
    """

    league: str
    year: int
    artifact: str
    key: str
    bytes: int
    last_modified: datetime


class RunWindow(BaseModel):
    since: datetime
    runs: list[JobRun]
    # True when we stopped paginating before Batch ran out of runs: the oldest
    # part of the window is missing, so the rates are over a sample of it.
    truncated: bool = False


class Volume(BaseModel):
    since: datetime
    odds: list[OddsDay]
    seasons: list[SeasonObject]


class JobsSource(Protocol):
    def runs(self, days: int) -> RunWindow: ...

    def volume(self, days: int) -> Volume: ...


def window_start(days: int, now: datetime | None = None) -> datetime:
    return (now or datetime.now(UTC)) - timedelta(days=days)


def classify(definition: str) -> tuple[str, str | None]:
    """(kind, league) for a job definition name.

    `daily-games-mens` and `odds-ncaabb` are the same league's data under two
    different keys -- games are per ncaabb *gender*, odds are per league. This
    doesn't reconcile them; the dashboard groups by job, and calling `mens` and
    `ncaabb` one row would be inventing a join nobody asked for.

    Anything unrecognized is "other" rather than an error, so a job added to
    the queue upstream shows up on the dashboard instead of vanishing from it.
    """
    if definition.startswith(_GAMES_PREFIX):
        return "games", definition[len(_GAMES_PREFIX) :] or None
    if definition.startswith(_ODDS_PREFIX):
        return "odds", definition[len(_ODDS_PREFIX) :] or None
    return "other", None


def summarize(runs: Iterable[JobRun], recent: int = RECENT_RUNS) -> list[JobHealth]:
    """Roll runs up per job definition, worst first.

    The ordering is the point of the page (section 12.5): a job whose last run
    failed sorts above one that merely failed earlier in the window, which
    sorts above the healthy ones. Within a tier, by name, so the list doesn't
    reshuffle between refreshes.
    """
    by_definition: dict[str, list[JobRun]] = {}
    for run in runs:
        by_definition.setdefault(run.definition, []).append(run)

    health: list[JobHealth] = []
    for definition, job_runs in by_definition.items():
        # Newest first, ties broken on job id so two runs created in the same
        # second don't swap places between requests.
        job_runs.sort(key=lambda r: (r.created_at, r.job_id), reverse=True)
        kind, league = classify(definition)

        succeeded = sum(1 for r in job_runs if r.status == SUCCEEDED)
        failed = sum(1 for r in job_runs if r.status == FAILED)
        terminal = succeeded + failed
        last_success = next((r for r in job_runs if r.status == SUCCEEDED), None)

        health.append(
            JobHealth(
                name=definition,
                kind=kind,
                league=league,
                runs=len(job_runs),
                succeeded=succeeded,
                failed=failed,
                running=len(job_runs) - terminal,
                # None, not 0.0, when nothing finished in the window: a job
                # that hasn't run yet and a job that failed every attempt are
                # not the same story (section 12.3).
                success_rate=(succeeded / terminal) if terminal else None,
                last_run=job_runs[0],
                last_success_at=last_success.stopped_at if last_success else None,
                recent=job_runs[:recent],
            )
        )

    health.sort(key=lambda h: (_severity(h), h.name))
    return health


def _severity(health: JobHealth) -> int:
    if health.last_run is not None and health.last_run.status == FAILED:
        return 0
    if health.failed:
        return 1
    return 2


class LocalJobsSource:
    """Reads runs and volume from JSON files instead of from AWS.

    `<root>/jobs/runs.json` and `<root>/jobs/volume.json` hold what the AWS
    source would have returned. This is what tests and `make run` use, so the
    dashboard renders locally without credentials -- the same trade
    `LocalReleaseStore` makes, and it shares a root with it for the same
    reason: one env var to point at the fixtures.

    **Timestamps are re-based so the newest entry lands now.** A committed
    fixture cannot sit inside a rolling seven-day window: without the shift the
    local dashboard would go empty a week after anyone last touched the file,
    which is precisely when it stops being worth running. Relative spacing
    between runs is preserved, so "failed twice in a row overnight" still reads
    that way.

    Missing files are empty, not an error. A checkout that hasn't seeded them
    should show a dashboard with nothing on it, not a 502.
    """

    def __init__(self, root: Path) -> None:
        self._dir = root / "jobs"

    def runs(self, days: int) -> RunWindow:
        since = window_start(days)
        raw = self._load("runs.json")
        runs = [JobRun.model_validate(item) for item in raw.get("runs", [])]

        if runs:
            offset = datetime.now(UTC) - max(run.created_at for run in runs)
            runs = [_shift_run(run, offset) for run in runs]

        return RunWindow(
            since=since,
            runs=[run for run in runs if run.created_at >= since],
            truncated=False,
        )

    def volume(self, days: int) -> Volume:
        since = window_start(days)
        raw = self._load("volume.json")
        odds = [OddsDay.model_validate(item) for item in raw.get("odds", [])]
        seasons = [SeasonObject.model_validate(item) for item in raw.get("seasons", [])]

        # Whole days, so a fixture's newest odds day becomes today rather than
        # today-ish. Seasons ride along on the same offset to stay consistent
        # with the odds beside them.
        offset = timedelta()
        if odds:
            offset = timedelta(
                days=(datetime.now(UTC).date() - max(o.day for o in odds)).days
            )
        elif seasons:
            offset = datetime.now(UTC) - max(s.last_modified for s in seasons)

        odds = [_shift_odds(day, offset) for day in odds]
        seasons = [_shift_season(season, offset) for season in seasons]

        return Volume(
            since=since,
            # Seasons aren't filtered: there's one object per league per season
            # and it's rewritten in place, so "within the window" isn't a thing
            # it can be. Its last-modified is the freshness signal.
            odds=[day for day in odds if day.day >= since.date()],
            seasons=seasons,
        )

    def _load(self, name: str) -> dict[str, Any]:
        path = self._dir / name
        try:
            loaded = json.loads(path.read_text())
        except FileNotFoundError:
            return {}
        except (json.JSONDecodeError, UnicodeDecodeError, ValidationError) as exc:
            raise JobsUnavailable(f"{path} is not readable job data") from exc
        if not isinstance(loaded, dict):
            raise JobsUnavailable(f"{path} should hold an object")
        return loaded


def _shift_run(run: JobRun, offset: timedelta) -> JobRun:
    return run.model_copy(
        update={
            "created_at": run.created_at + offset,
            "started_at": run.started_at + offset if run.started_at else None,
            "stopped_at": run.stopped_at + offset if run.stopped_at else None,
        }
    )


def _shift_odds(day: OddsDay, offset: timedelta) -> OddsDay:
    return day.model_copy(
        update={
            "day": day.day + offset,
            "latest_at": day.latest_at + offset if day.latest_at else None,
        }
    )


def _shift_season(season: SeasonObject, offset: timedelta) -> SeasonObject:
    return season.model_copy(update={"last_modified": season.last_modified + offset})


@lru_cache(maxsize=1)
def _build_source(settings: Settings) -> JobsSource:
    """AWS when both the queue and the bucket are configured, else fixtures.

    Cached like the release store, and for the same reason: the AWS source
    holds the TTL cache, so rebuilding it per request would call Batch on every
    page load.

    Both settings are required together on purpose. A source that could answer
    one endpoint and 502 the other would make a half-configured deploy look
    like an outage.
    """
    if settings.batch_job_queue and settings.endgame_bucket:
        # Imported here so a local run doesn't pay boto3's import cost, the
        # same way app.releases defers app.s3.
        from app.batch import AwsJobsSource

        return AwsJobsSource(
            queue=settings.batch_job_queue,
            bucket=settings.endgame_bucket,
            ttl_seconds=settings.jobs_cache_ttl_seconds,
        )
    return LocalJobsSource(settings.releases_root)


def get_jobs_source() -> JobsSource:
    """FastAPI dependency. Overridden in tests with a fake."""
    return _build_source(get_settings())
