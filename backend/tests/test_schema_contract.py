"""The schema contract test DESIGN.md section 8 asks for.

Every golden fixture is validated against the `ModelRelease` this app actually
serves through. Once `backend/pyproject.toml` pins cassandra and `app.schema`
becomes a re-export of `cassandra.serving`, this file is unchanged and starts
answering a much better question: *did bumping the rev break the artifact
format?* -- which is a red check here instead of a 500 in production.

The awkward part is that pydantic ignores unknown keys by default, so most of
the obvious ways to write this test pass on a fixture that was only half
migrated. `test_no_unknown_top_level_keys` is the guard: without it, a fixture
still carrying `spread_calibration` validates cleanly, `margin_calibration`
comes back None, and nothing complains.
"""

import json
import math
from pathlib import Path

import pytest

from app.schema import ModelRelease

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE_FILES = sorted((FIXTURES / "models").rglob("latest.json"))

# A heavy home favourite. The number matters: it has to sit inside the knot
# range of every isotonic fixture, otherwise the bracketing below silently
# degenerates to an endpoint and stops testing the interesting part.
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

        Deliberately asserted on the knots rather than by interpolating:
        `np.interp` belongs to `ModelRelease.margin_predictor()`, not here.
        Bracketing works because the fit is monotone increasing -- whatever the
        interpolant returns at 0.9 lies between the two surrounding knots, so
        both being positive settles it.
        """
        calibration = ModelRelease.model_validate(_load(path)).margin_calibration
        assert calibration is not None

        if calibration.kind == "isotonic":
            low, high = _bracket(
                calibration.x_thresholds, calibration.y_thresholds, HEAVY_FAVOURITE
            )
            assert low > 0, f"margin at p={HEAVY_FAVOURITE} is not positive"
            assert high > 0
            assert rendered_spread(low) < 0
            assert rendered_spread(high) < 0
        else:
            # margin = scale * logit(p), so the sign of the margin above p=0.5
            # is the sign of scale. A negative scale is the same bug wearing a
            # different hat.
            assert calibration.scale > 0

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


def _bracket(xs: list[float], ys: list[float], p: float) -> tuple[float, float]:
    """The two y-knots surrounding `p`. Fails rather than clamping."""
    assert xs[0] <= p <= xs[-1], f"p={p} is outside the fitted range {xs[0]}..{xs[-1]}"
    i = max(j for j, x in enumerate(xs) if x <= p)
    return (ys[i], ys[min(i + 1, len(ys) - 1)])
