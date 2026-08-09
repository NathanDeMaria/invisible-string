from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.releases import (
    ReleaseNotFound,
    ReleaseStore,
    get_release_store,
    latest_releases,
    pick_default,
)
from app.schema import Metrics, ModelRelease, TrainedThrough

router = APIRouter(prefix="/api")


class ModelSummary(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    name: str
    is_default: bool
    run_id: str
    created_at: datetime
    metrics: Metrics


class LeagueSummary(BaseModel):
    league: str
    models: list[ModelSummary]


class TeamRow(BaseModel):
    rank: int
    team: str
    rating: float
    rd: float | None
    wins: int
    losses: int


class RatingsResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    league: str
    model: str
    run_id: str
    created_at: datetime
    trained_through: TrainedThrough
    metrics: Metrics
    ratings: list[TeamRow]


def _rank(release: ModelRelease) -> list[TeamRow]:
    # Ties break on team name so a redeploy doesn't reshuffle equal-rated teams.
    ordered = sorted(release.ratings.items(), key=lambda kv: (-kv[1].rating, kv[0]))
    return [
        TeamRow(
            rank=i,
            team=team,
            rating=r.rating,
            rd=r.rd,
            wins=r.wins,
            losses=r.losses,
        )
        for i, (team, r) in enumerate(ordered, start=1)
    ]


@router.get("/leagues")
def list_leagues(
    store: ReleaseStore = Depends(get_release_store),
) -> list[LeagueSummary]:
    summaries: list[LeagueSummary] = []
    for league in store.list_leagues():
        try:
            releases = latest_releases(store, league)
        except ReleaseNotFound:
            # A league directory with no readable releases isn't an error, it's
            # just not ready to show yet.
            continue
        default = pick_default(releases)
        summaries.append(
            LeagueSummary(
                league=league,
                models=[
                    ModelSummary(
                        name=r.model,
                        is_default=r.run_id == default.run_id,
                        run_id=r.run_id,
                        created_at=r.created_at,
                        metrics=r.metrics,
                    )
                    for r in releases
                ],
            )
        )
    return summaries


@router.get("/leagues/{league}/ratings")
def get_ratings(
    league: str,
    model: str | None = Query(
        default=None,
        description="Defaults to the league's lowest-Brier model.",
    ),
    store: ReleaseStore = Depends(get_release_store),
) -> RatingsResponse:
    try:
        release = (
            store.get_latest(league, model)
            if model
            else pick_default(latest_releases(store, league))
        )
    except ReleaseNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return RatingsResponse(
        league=release.league,
        model=release.model,
        run_id=release.run_id,
        created_at=release.created_at,
        trained_through=release.trained_through,
        metrics=release.metrics,
        ratings=_rank(release),
    )
