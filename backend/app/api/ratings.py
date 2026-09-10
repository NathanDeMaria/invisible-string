import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.artifacts import ArtifactStore, get_artifact_store
from app.movement import Movement, MovementWindow, Standing, movement
from app.releases import (
    ReleaseNotFound,
    ReleaseStore,
    ReleaseUnreadable,
    get_release_store,
    latest_releases,
    pick_default,
    resolve_release,
)
from app.schema import Metrics, ModelRelease, TeamRating, TrainedThrough
from app.teams import still_playing

log = logging.getLogger(__name__)

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
    # What the week did to this team (`app.movement`). None where the history
    # can't say: no `history.parquet` published for this model, the first
    # snapshot of a season, or a team whose first game was this week. A row
    # that says nothing is right where a zero would be a claim.
    movement: Movement | None = None


class RatingsResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    league: str
    model: str
    run_id: str
    created_at: datetime
    trained_through: TrainedThrough
    metrics: Metrics
    # The snapshot every `movement` above is measured against, so the page can
    # name the day rather than say "last week" and hope. None when no row has
    # a movement.
    movement_since: MovementWindow | None = None
    ratings: list[TeamRow]


def _ranked(release: ModelRelease) -> list[tuple[int, str, TeamRating]]:
    """The release's ratings as a leaderboard of the teams that still play.

    A model trained on a decade of seasons rates every team it has ever seen,
    which for a closed pro league means franchises that folded years ago
    sitting in tonight's standings (`app.teams`). They're dropped before the
    ranks are handed out, so the numbers count teams rather than history --
    a leaderboard whose 4th is really 5th is worse than one that's short.

    Only the folded ones. A team that moved or was renamed is still playing
    under a later name, and its old name is a naming problem for upstream
    rather than a row to delete -- see `app.teams`.
    """
    playing = [
        (team, rating)
        for team, rating in release.ratings.items()
        if still_playing(release.league, team)
    ]
    # Ties break on team name so a redeploy doesn't reshuffle equal-rated teams.
    ordered = sorted(playing, key=lambda kv: (-kv[1].rating, kv[0]))
    return [(i, team, r) for i, (team, r) in enumerate(ordered, start=1)]


def _standings(ranked: list[tuple[int, str, TeamRating]]) -> list[Standing]:
    """The ranked table in the shape `app.movement` measures against."""
    return [
        Standing(team=team, rank=rank, rating=r.rating, wins=r.wins, losses=r.losses)
        for rank, team, r in ranked
    ]


@router.get("/leagues")
def list_leagues(
    store: ReleaseStore = Depends(get_release_store),
) -> list[LeagueSummary]:
    summaries: list[LeagueSummary] = []
    for league in store.list_leagues():
        try:
            releases = latest_releases(store, league)
        except (ReleaseNotFound, ReleaseUnreadable):
            # A league with nothing servable isn't an error here, it's just not
            # ready to show. Unreadable is included on purpose: this endpoint is
            # the index for *every* league, so one league's stale artifact must
            # not blank the others. `latest_releases` has already logged which.
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
    artifacts: ArtifactStore = Depends(get_artifact_store),
) -> RatingsResponse:
    try:
        release = resolve_release(store, league, model)
    except ReleaseNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReleaseUnreadable as exc:
        # 502, not 404 and not 500: the artifact is there, we fetched it, and
        # it's the *upstream* data that's wrong. Nothing the caller can change,
        # and nothing a retry will fix -- it needs a republish. Saying "not
        # found" would send someone hunting for a missing object that exists.
        log.warning("serving 502 for %s: %s", league, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    ranked = _ranked(release)
    # The history is an enhancement, never a precondition: `app.artifacts`
    # answers a missing or unreadable file with an empty frame, and an empty
    # frame produces no movement rather than an error. A league published
    # before the artifact existed still gets its table.
    window, moved = movement(
        artifacts.history(release.league, release.model), _standings(ranked)
    )

    return RatingsResponse(
        league=release.league,
        model=release.model,
        run_id=release.run_id,
        created_at=release.created_at,
        trained_through=release.trained_through,
        metrics=release.metrics,
        movement_since=window,
        ratings=[
            TeamRow(
                rank=rank,
                team=team,
                rating=r.rating,
                rd=r.rd,
                wins=r.wins,
                losses=r.losses,
                movement=moved.get(team),
            )
            for rank, team, r in ranked
        ],
    )
