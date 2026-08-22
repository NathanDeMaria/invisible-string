"""Job health and data volume for the batch jobs upstream of the releases.

DESIGN.md section 12.1. Two endpoints rather than one, because the two halves
fail independently: Batch throttling shouldn't blank the volume tables, and a
bucket permission that hasn't been granted yet shouldn't take the run history
with it. The page renders whichever half answered.

Public read, like everything outside `/api/admin/*` (section 3). Job names and
failure reasons are the most operational thing this site exposes; if that ever
feels like too much, it's one `Depends` away from being admin-only.
"""

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.jobs import (
    DEFAULT_WINDOW_DAYS,
    MAX_WINDOW_DAYS,
    JobHealth,
    JobsSource,
    JobsUnavailable,
    OddsDay,
    SeasonObject,
    get_jobs_source,
    summarize,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# Capped rather than clamped: `?days=30` is a question this data can't answer
# (section 12.3), and answering it with a week of runs under a monthly heading
# is worse than refusing.
_days = Query(
    default=DEFAULT_WINDOW_DAYS,
    ge=1,
    le=MAX_WINDOW_DAYS,
    description=(
        f"Days of history. Capped at {MAX_WINDOW_DAYS} because AWS Batch keeps "
        "completed job records for about a week."
    ),
)


class JobsResponse(BaseModel):
    window_days: int
    since: datetime
    truncated: bool
    jobs: list[JobHealth]


class VolumeResponse(BaseModel):
    window_days: int
    since: datetime
    odds: list[OddsDay]
    seasons: list[SeasonObject]


@router.get("/jobs")
def get_jobs(
    days: int = _days,
    source: JobsSource = Depends(get_jobs_source),
) -> JobsResponse:
    try:
        window = source.runs(days)
    except JobsUnavailable as exc:
        raise _upstream_error(exc) from exc

    return JobsResponse(
        window_days=days,
        since=window.since,
        truncated=window.truncated,
        jobs=summarize(window.runs),
    )


@router.get("/jobs/volume")
def get_volume(
    days: int = _days,
    source: JobsSource = Depends(get_jobs_source),
) -> VolumeResponse:
    try:
        volume = source.volume(days)
    except JobsUnavailable as exc:
        raise _upstream_error(exc) from exc

    return VolumeResponse(
        window_days=days,
        since=volume.since,
        odds=volume.odds,
        seasons=volume.seasons,
    )


def _upstream_error(exc: JobsUnavailable) -> HTTPException:
    """502, for the same reason an unreadable release is (see api/ratings).

    Nothing the caller can change and nothing a retry fixes: either the grants
    in section 12.2 aren't in place or the upstream is down. A 500 would point
    at this app, and an empty 200 would quietly claim the jobs are fine.
    """
    log.warning("serving 502 for job health: %s", exc)
    return HTTPException(status_code=502, detail=str(exc))
