"""The ModelRelease artifact -- the contract between cassandra and this app.

cassandra owns the schema (DESIGN.md section 9.6), so this module is a
re-export and nothing more. It exists so that `app.api.ratings`, `app.releases`
and the tests import from one place, and so the day cassandra reorganizes its
package layout is a one-line change here rather than a sweep.

What arrives with it, and why it matters that it's so little: `ModelRelease`
depends on `cassandra.prob_to_margin`, which needs numpy and nothing else to
*read* a fit. scikit-learn lives in cassandra's poetry `fit` group, and poetry
groups aren't part of package metadata, so it is not in this image and cannot
be. `IsotonicProbToMarginFitter.fit` imports it lazily for exactly that reason.
A `No module named sklearn` here therefore never means "add sklearn" -- it means
something is trying to fit rather than to read a fit, and that belongs upstream.

`calibration_from_predictor` and `metrics_from_scored` are deliberately not
re-exported: they're for whatever *writes* releases, and this app only reads
them.
"""

from cassandra.serving import (
    IsotonicMarginCalibration,
    LogisticMarginCalibration,
    MarginCalibration,
    Metrics,
    ModelRelease,
    TeamRating,
    TrainedThrough,
)

__all__ = [
    "IsotonicMarginCalibration",
    "LogisticMarginCalibration",
    "MarginCalibration",
    "Metrics",
    "ModelRelease",
    "TeamRating",
    "TrainedThrough",
]
