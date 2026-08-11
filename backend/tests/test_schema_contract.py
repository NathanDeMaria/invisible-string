"""The schema contract test DESIGN.md section 8 asks for.

Every golden fixture is validated against cassandra's own `ModelRelease` --
`app.schema` re-exports it, and `backend/pyproject.toml` pins the rev. That
makes this the test that answers "did bumping the pin break the artifact
format?" with a red check here, rather than with a 500 in production.

The awkward part is that pydantic ignores unknown keys by default, so most of
the obvious ways to write this test pass on a fixture that was only half
migrated. `test_no_unknown_top_level_keys` is the guard: without it, a fixture
still carrying `spread_calibration` validates cleanly, `margin_calibration`
comes back None, and nothing complains.
"""

import json
import math
from pathlib import Path

import numpy as np
import pytest

from app.schema import ModelRelease

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE_FILES = sorted((FIXTURES / "models").rglob("latest.json"))

# A heavy home favourite, and by symmetry 0.1 is the same underdog. Both sit
# inside the knot range of every isotonic fixture, so the clamp isn't what's
# being measured.
HEAVY_FAVOURITE = 0.9


def rendered_spread(margin: float) -> float:
    """What `/api/predict` will put on the wire (DESIGN.md section 3).

    The calibration predicts margin of victory for the home team, and the
    display convention is the market's: negative spread = home favoured. So the
    boundary negates, and "Duke by 6.5" goes out as -6.5.
    """
    return -margin


def _load(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def _ids(paths: list[Path]) -> list[str]:
    return [str(p.relative_to(FIXTURES / "models").parent) for p in paths]


def test_there_are_fixtures_to_check() -> None:
    """Guards the rglob. Every test below is a no-op if this list is empty."""
    assert len(FIXTURE_FILES) >= 3


@pytest.mark.parametrize("path", FIXTURE_FILES, ids=_ids(FIXTURE_FILES))
class TestGoldenFixtures:
    def test_validates(self, path: Path) -> None:
        ModelRelease.model_validate(_load(path))

    def test_no_unknown_top_level_keys(self, path: Path) -> None:
        """Catches a rename that only half landed.

        `spread_calibration` -> `margin_calibration` is the live example: with
        extras merely ignored, the stale key parses fine and the calibration
        quietly becomes None.
        """
        unknown = set(_load(path)) - set(ModelRelease.model_fields)
        assert unknown == set()

    def test_carries_a_calibration(self, path: Path) -> None:
        """And that it isn't None -- which is how the previous test gets fooled
        in the other direction, by a fixture that simply drops the key."""
        assert ModelRelease.model_validate(_load(path)).margin_calibration is not None

    def test_round_trips_as_strict_json(self, path: Path) -> None:
        """Re-serializing has to produce JSON a browser will accept.

        `json.dumps` writes float nan as a bare `NaN` token, which is not valid
        JSON and which `JSON.parse` rejects. cassandra maps nan to None on the
        way out for exactly this reason; `allow_nan=False` is what proves it
        did.
        """
        dumped = ModelRelease.model_validate(_load(path)).model_dump(mode="json")
        ModelRelease.model_validate(json.loads(json.dumps(dumped, allow_nan=False)))

    def test_metrics_are_finite(self, path: Path) -> None:
        metrics = ModelRelease.model_validate(_load(path)).metrics
        for name, value in metrics.model_dump().items():
            assert value is None or math.isfinite(value), name

    def test_a_heavy_favourite_gets_a_positive_margin(self, path: Path) -> None:
        """The sign check, and the reason this whole change is worth being slow
        about.

        Cassandra used to fit win prob -> *market spread* with
        `IsotonicRegression(increasing=False)`, so `y_thresholds` descended and
        a strong favourite mapped to a negative number. Since e80ef85 it fits
        win prob -> *margin of victory*, `increasing=True`, and the sign is the
        other way round. A fixture regenerated without flipping produces spreads
        that look completely plausible and are backwards, and no other test in
        this repo would notice.

        Asserted through `margin_predictor()` rather than by reading knots, so
        this exercises the same call `/api/predict` will make -- including the
        clamping that turns an out-of-range win probability into an answer
        instead of the nan sklearn would have returned.
        """
        margin = _margin_at(_load(path), HEAVY_FAVOURITE)
        assert margin > 0, f"margin at p={HEAVY_FAVOURITE} is not positive"
        assert rendered_spread(margin) < 0

    def test_the_underdog_side_mirrors_it(self, path: Path) -> None:
        """The other half of the sign convention.

        A fit that was negated *twice* -- or a fixture whose y-values are all
        positive -- passes the favourite test and fails here.
        """
        assert _margin_at(_load(path), 1 - HEAVY_FAVOURITE) < 0

    def test_a_pickem_is_roughly_level(self, path: Path) -> None:
        """p=0.5 should predict a game that finishes near level.

        Loose on purpose: isotonic knots land where the data put them, so this
        is a sanity bound, not a calibration check.
        """
        assert abs(_margin_at(_load(path), 0.5)) < 3.0

    def test_isotonic_thresholds_ascend(self, path: Path) -> None:
        """`increasing=True`, both axes.

        x ascending is what `np.interp` requires. y ascending is the sign
        convention itself, and is what the fitter now guarantees.
        """
        calibration = ModelRelease.model_validate(_load(path)).margin_calibration
        if calibration is None or calibration.kind != "isotonic":
            pytest.skip("not an isotonic fit")

        xs, ys = calibration.x_thresholds, calibration.y_thresholds
        assert len(xs) == len(ys) >= 2
        assert xs == sorted(xs)
        assert ys == sorted(ys)


def _margin_at(raw: dict[str, object], win_prob: float) -> float:
    """The margin a release predicts for a home team with this win probability.

    Exactly the call `/api/predict` will make: rehydrate the stored fit and
    evaluate it. No sklearn involved, and no second implementation of np.interp
    living in this repo.
    """
    predictor = ModelRelease.model_validate(raw).margin_predictor()
    assert predictor is not None
    return float(predictor.predict_margins(np.array([win_prob]))[0])
