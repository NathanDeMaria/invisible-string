"""A team's rating over time, out of `history.parquet`.

DESIGN.md section 6's serving half. The ratings table says where a team stands
and what the last week did to it; this is the same file read the long way --
every week it has been rated, so a page can draw the line.

Three things shape the endpoint.

**Team-filtered, and required.** The useful view is one team, or two to five
overlaid; nobody reads 360 lines. So `teams` has no default and asking for too
many is a 422 rather than a slow answer -- a chart that can't be read is not a
cheaper thing to serve, it's a more expensive way to serve nothing.

**A team's whole history fits in one response.** ~20 weeks a season over 16
seasons is a few hundred points, which is smaller than the ratings table this
page was reached from. So `from`/`to` exist for a caller that wants less, and
the page that has them all filters its own range without going back to the
network.

**A team with no rows is an empty series, not a 404.** The 404 belongs to a
team that doesn't exist, and this file can't tell that from one whose model
hasn't rated it -- a release published before the history artifact existed has
no rows for anybody. The caller holds the ratings table, which is where "no
such team" is answerable; here an empty series says "nothing to draw" and the
page says so.
"""

import logging
from datetime import datetime

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.artifacts import ArtifactStore, get_artifact_store
from app.releases import (
    ReleaseNotFound,
    ReleaseStore,
    ReleaseUnreadable,
    get_release_store,
    resolve_release,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# Overlaying more than a handful of lines is unreadable, and the limit is the
# API's rather than the chart's so nobody can ask this to build the unreadable
# version by hand.
MAX_TEAMS = 5


class HistoryPoint(BaseModel):
    """One week, as the team finished it.

    `date` is the last game played that week (cassandra's `WeekSnapshot`), so
    it is a day something actually happened on -- which is what lets a chart
    label its axis with time rather than with a week number that resets every
    November.

    `wins` and `losses` are season-to-date at that point, not the week's own.
    A reader hovering week 9 wants the record the team carried into it.
    """

    year: int
    week: int
    date: datetime
    rating: float
    rd: float | None
    wins: int
    losses: int


class TeamSeries(BaseModel):
    team: str
    points: list[HistoryPoint]


class HistoryResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    league: str
    model: str
    run_id: str
    series: list[TeamSeries]


def _requested(teams: str) -> list[str]:
    """The teams asked for, in the order asked, deduped.

    Comma-separated because that is what a URL a reader might edit wants, and
    because no team in these leagues has a comma in its name. Order is kept:
    a compare chart's first line is the one the reader named first.
    """
    seen: list[str] = []
    for raw in teams.split(","):
        team = raw.strip()
        if team and team not in seen:
            seen.append(team)
    if not seen:
        raise HTTPException(status_code=422, detail="name at least one team in `teams`")
    if len(seen) > MAX_TEAMS:
        raise HTTPException(
            status_code=422,
            detail=f"at most {MAX_TEAMS} teams at once, asked for {len(seen)}",
        )
    return seen


def _points(rows: pd.DataFrame) -> list[HistoryPoint]:
    """One team's rows, oldest first.

    Sorted here rather than trusted from the file: the artifact's own order is
    `(team, year, week)`, which is already this, but a chart drawn in whatever
    order the rows arrived is the kind of wrong that looks like a data problem.
    """
    ordered = rows.sort_values(["year", "week"], kind="stable")
    return [
        HistoryPoint(
            year=int(row["year"]),
            week=int(row["week"]),
            date=row["date"],
            rating=float(row["rating"]),
            # NaN rather than None survives the parquet round trip for the Elo
            # family, whose ratings have no deviation. It has to go back out as
            # null: `NaN` is not valid JSON and browsers reject it.
            rd=None if pd.isna(row["rd"]) else float(row["rd"]),
            wins=int(row["wins"]),
            losses=int(row["losses"]),
        )
        for row in ordered.to_dict("records")
    ]


@router.get("/leagues/{league}/history")
def get_history(
    league: str,
    teams: str = Query(
        description=(
            f"Comma-separated team names, at most {MAX_TEAMS}. "
            "Named exactly as the ratings table spells them."
        ),
    ),
    model: str | None = Query(
        default=None,
        description="Defaults to the league's lowest-Brier model.",
    ),
    season_from: int | None = Query(
        default=None,
        alias="from",
        description="First season year to include. Defaults to all of them.",
    ),
    season_to: int | None = Query(
        default=None,
        alias="to",
        description="Last season year to include. Defaults to all of them.",
    ),
    store: ReleaseStore = Depends(get_release_store),
    artifacts: ArtifactStore = Depends(get_artifact_store),
) -> HistoryResponse:
    wanted = _requested(teams)

    try:
        release = resolve_release(store, league, model)
    except ReleaseNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReleaseUnreadable as exc:
        # The same 502 `/ratings` serves, for the same reason: the artifact is
        # there and it's the upstream data that's wrong.
        log.warning("serving 502 for %s history: %s", league, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    history = artifacts.history(release.league, release.model)
    if not history.empty:
        if season_from is not None:
            history = history[history["year"] >= season_from]
        if season_to is not None:
            history = history[history["year"] <= season_to]

    return HistoryResponse(
        league=release.league,
        model=release.model,
        run_id=release.run_id,
        series=[
            TeamSeries(
                team=team,
                points=(
                    [] if history.empty else _points(history[history["team"] == team])
                ),
            )
            for team in wanted
        ],
    )
