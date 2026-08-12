"""Win probability and predicted spread for a matchup that hasn't happened.

A GET on purpose (DESIGN.md section 3): a matchup is a shareable, linkable,
cacheable thing, and RTK Query caches it for free.

Nothing here does model math. `rating_predictor()` rebuilds the predictor from
the release, `predict_matchup()` builds the pre-game half of a Game, and
`margin_predictor()` evaluates the stored fit. This module's whole job is to
choose the release, refuse the inputs that would produce a confident lie, and
negate one number at the boundary.
"""

import logging

import numpy as np
from cassandra.predictor import (
    RatingsUnsupported,
    UnknownPredictorClass,
    predict_matchup,
)
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.releases import (
    ReleaseNotFound,
    ReleaseStore,
    ReleaseUnreadable,
    get_release_store,
    resolve_release,
)
from app.schema import ModelRelease

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


class PredictResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    league: str
    model: str
    run_id: str

    home: str
    away: str
    neutral: bool

    home_win_prob: float
    away_win_prob: float
    # None when the release carries no margin fit -- a release written before
    # the calibration existed, or a predictor flat enough that there was no
    # slope to fit. Better an absent number than a fabricated one.
    predicted_spread: float | None
    home_rating: float
    away_rating: float


@router.get("/predict")
def predict(
    league: str = Query(description="e.g. mens"),
    home: str = Query(description="Home team, exactly as the ratings name it."),
    away: str = Query(description="Away team."),
    neutral: bool = Query(default=False, description="Turns off home advantage."),
    model: str | None = Query(
        default=None, description="Defaults to the league's lowest-Brier model."
    ),
    home_advantage: float | None = Query(
        default=None, description="What-if override for the model's home advantage."
    ),
    store: ReleaseStore = Depends(get_release_store),
) -> PredictResponse:
    try:
        release = resolve_release(store, league, model)
    except ReleaseNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReleaseUnreadable as exc:
        log.warning("serving 502 for %s: %s", league, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    release = _with_home_advantage(release, home_advantage)

    try:
        predictor = release.rating_predictor()
    except RatingsUnsupported as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{release.model} doesn't rate teams, so it can't predict a matchup",
        ) from exc
    except UnknownPredictorClass as exc:
        # A release written by a newer cassandra than this image was built
        # against. Upstream data this build can't read -- same shape of problem
        # as a schema mismatch, so the same 502.
        log.warning("serving 502 for %s: %s", league, exc)
        raise HTTPException(
            status_code=502,
            detail=f"this build has no predictor class {release.predictor_class!r}",
        ) from exc

    _check_teams(release, home, away)

    prob = predict_matchup(
        predictor, home=home, away=away, neutral_site=neutral
    ).team1_win_prob

    return PredictResponse(
        league=release.league,
        model=release.model,
        run_id=release.run_id,
        home=home,
        away=away,
        neutral=neutral,
        home_win_prob=prob,
        away_win_prob=1.0 - prob,
        predicted_spread=_spread(release, prob),
        home_rating=release.ratings[home].rating,
        away_rating=release.ratings[away].rating,
    )


def _check_teams(release: ModelRelease, home: str, away: str) -> None:
    """Refuse a team the release has never heard of.

    This is the guard that matters most in this module. Every predictor
    defaults an unseen team to its base rating, so without this a typo --
    "Duke " with a trailing space, "UNC" for "North Carolina" -- returns a
    perfectly plausible win probability computed against a 1500-rated ghost.
    A 404 is the only honest answer, and it's much easier to notice.
    """
    unknown = sorted({home, away} - release.ratings.keys())
    if unknown:
        raise HTTPException(
            status_code=404,
            detail=f"{release.league}/{release.model} has no rating for: "
            + ", ".join(repr(t) for t in unknown),
        )
    if home == away:
        raise HTTPException(status_code=422, detail="a team can't play itself")


def _with_home_advantage(
    release: ModelRelease, home_advantage: float | None
) -> ModelRelease:
    """Apply the what-if override, if one was asked for.

    Only for a model that already has the parameter: passing it to a predictor
    whose constructor doesn't take one is a TypeError deep inside cassandra,
    and a 422 saying so is a better answer than a 500.
    """
    if home_advantage is None:
        return release
    if "home_advantage" not in release.params:
        raise HTTPException(
            status_code=422,
            detail=f"{release.model} has no home_advantage parameter to override",
        )
    return release.model_copy(
        update={"params": {**release.params, "home_advantage": home_advantage}}
    )


def _spread(release: ModelRelease, prob: float) -> float | None:
    """The market-facing number, which is the negation of the model's.

    The calibration predicts *margin of victory* -- positive means the home
    team wins by that much -- and the display convention is the market's, where
    negative means home is favoured. So a predicted margin of 6.5 goes out as
    -6.5 and renders as "Duke -6.5" (DESIGN.md section 1).

    `predict_margins` clamps out-of-range probabilities rather than returning
    the nan sklearn would, so a matchup more lopsided than anything the season
    contained still gets an answer.
    """
    margin_predictor = release.margin_predictor()
    if margin_predictor is None:
        return None
    margin = float(margin_predictor.predict_margins(np.array([prob]))[0])
    return -margin
