"""The ModelRelease artifact -- the contract between cassandra and this app.

This module exists to become a re-export. cassandra now owns the schema at
`cassandra.serving.release` (DESIGN.md section 9.6); once `backend/pyproject.toml`
pins the rev that introduced it, the bodies below are deleted and replaced with

    from cassandra.serving import (  # noqa: F401
        MarginCalibration, Metrics, ModelRelease, TeamRating, TrainedThrough,
    )

Keeping the module means `app.api.ratings` and `app.releases` never change their
imports, and `tests/test_schema_contract.py` becomes the real contract test the
moment the swap happens -- it already validates the golden fixtures through
whatever this module exports.

The definitions here track cassandra's field-for-field on purpose. They are a
placeholder for the pin, not a second opinion about the schema.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "IsotonicMarginCalibration",
    "LogisticMarginCalibration",
    "MarginCalibration",
    "Metrics",
    "ModelRelease",
    "TeamRating",
    "TrainedThrough",
]


class TeamRating(BaseModel):
    """A team's standing in one release.

    `rd` is Glicko's rating deviation; Elo and Elo538 don't have one, so it
    stays None rather than being faked as 0.
    """

    rating: float
    rd: float | None = None
    wins: int = 0
    losses: int = 0


class IsotonicMarginCalibration(BaseModel):
    """A fitted win-prob -> margin-of-victory map, stored as isotonic knots.

    Serialized as knots rather than a pickled sklearn estimator so serving needs
    only `np.interp`, and so a scikit-learn upgrade can't make old releases
    unreadable. cassandra keeps scikit-learn in a poetry `fit` group precisely so
    it never reaches this image: reading a fit must not require the ability to
    produce one.

    **Both lists ascend.** The fit is `IsotonicRegression(increasing=True)` over
    win prob -> actual margin, so a higher win probability means a *more
    positive* number: the home team wins by more. Rendered spread is the
    negation (see `ModelRelease.margin_calibration`).
    """

    kind: Literal["isotonic"]
    x_thresholds: list[float]
    y_thresholds: list[float]


class LogisticMarginCalibration(BaseModel):
    """A one-parameter alternative to the isotonic fit.

    Isotonic flattens outside the win probabilities the season actually
    contained, which is the lopsided-matchup case DESIGN.md section 3 clamps
    for; the logistic form keeps extrapolating instead. cassandra's
    `DEFAULT_FITTERS` scores both and stores whichever wins, so the artifact has
    to be able to carry either.
    """

    kind: Literal["logistic"]
    scale: float


MarginCalibration = Annotated[
    IsotonicMarginCalibration | LogisticMarginCalibration,
    Field(discriminator="kind"),
]


class Metrics(BaseModel):
    """Evaluation metrics for a release.

    `brier_score` is an error measure, so lower is better -- see `pick_default`
    in releases.py, which is the one place that matters.

    The three MAEs are margin-of-victory errors in points, and only two of them
    say anything on their own. `margin_mae` is over every game with a final
    score; the signal is the *gap* between `spread_game_margin_mae` and
    `market_margin_mae`, which are the model's error and the closing line's
    error over the same subset of games -- the ones a book hung a number on.
    Both are None for a league with no odds coverage: cassandra maps nan to null
    on the way out, because `json.dumps` emits nan as a bare `NaN` token that is
    not valid JSON and that browsers reject.
    """

    brier_score: float
    margin_mae: float
    against_spread_accuracy: float | None = None
    spread_game_margin_mae: float | None = None
    market_margin_mae: float | None = None
    n_games: int
    n_spread_games: int = 0


class TrainedThrough(BaseModel):
    """Watermark for the incremental refresh job.

    `processed_game_ids` is a set of ids rather than a timestamp because games
    get re-fetched and scores corrected; ids are what make the refresh
    idempotent. Current season only -- it's a resume marker, not an audit log.
    """

    season_year: int
    last_game_date: datetime | None = None
    processed_game_ids: list[str] = Field(default_factory=list)


class ModelRelease(BaseModel):
    """One model's ratings and calibration at a point in time."""

    # `model` collides with pydantic's protected `model_` namespace warning
    # even though it isn't itself a reserved attribute.
    model_config = ConfigDict(protected_namespaces=())

    schema_version: Literal[1] = 1
    run_id: str
    league: str
    model: str
    predictor_class: str
    params: dict[str, float | str] = Field(default_factory=dict)
    ratings: dict[str, TeamRating] = Field(default_factory=dict)
    # Win prob -> margin of victory, NOT -> market spread. `/api/predict`
    # negates at the boundary (DESIGN.md section 3) so the wire format stays
    # "negative spread = home favoured": a +6.5 margin renders as "Duke -6.5".
    margin_calibration: MarginCalibration | None = None
    metrics: Metrics
    trained_through: TrainedThrough
    created_at: datetime
    created_by: str
    parent_run_id: str | None = None
