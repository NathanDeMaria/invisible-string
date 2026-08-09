"""The ModelRelease artifact -- the contract between cassandra and this app.

Lives here for now so the backend can be built and tested standalone. It moves
to `cassandra.serving` once that exists, at which point this module becomes a
re-export and the fixtures in tests/ become the schema contract test (DESIGN.md
section 8).
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class TeamRating(BaseModel):
    """A team's standing in one release.

    `rd` is Glicko's rating deviation; Elo and Elo538 don't have one, so it
    stays None rather than being faked as 0.
    """

    rating: float
    rd: float | None = None
    wins: int = 0
    losses: int = 0


class SpreadCalibration(BaseModel):
    """A fitted prob->spread mapping, stored as isotonic regression knots.

    Serialized as knots rather than a pickled sklearn estimator so serving
    needs only np.interp, and so a scikit-learn upgrade can't make old
    releases unreadable.

    `x_thresholds` ascends (win probability). `y_thresholds` descends, because
    the fit is `IsotonicRegression(increasing=False)` -- a higher win
    probability means a more negative spread. np.interp only requires the
    x-values to ascend, so this is usable as-is.
    """

    kind: Literal["isotonic"]
    x_thresholds: list[float]
    y_thresholds: list[float]


class Metrics(BaseModel):
    """Evaluation metrics for a release.

    `brier_score` is an error measure, so lower is better -- see
    `pick_default` in releases.py, which is the one place that matters.
    """

    brier_score: float
    against_spread_accuracy: float | None = None
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
    spread_calibration: SpreadCalibration | None = None
    metrics: Metrics
    trained_through: TrainedThrough
    created_at: datetime
    created_by: str
    parent_run_id: str | None = None
