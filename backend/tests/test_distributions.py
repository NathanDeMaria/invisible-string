"""The metric shapes, and the validation that keeps a bad one off the wire.

The lookup itself is the browser's (`frontend/src/features/games/percentile`),
so what is tested here is the contract it depends on: a hundred and one
checkpoints, sorted, with the population they were drawn from named beside
them. An artifact that breaks any of those doesn't fail in the page -- it
answers a percentile question with a wrong number -- so it has to fail here.
"""

import json
import logging
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from app.distributions import (
    CHECKPOINTS,
    DistributionsNotFound,
    DistributionsUnreadable,
    LocalDistributionStore,
    S3DistributionStore,
    parse_distributions,
)

from .conftest import FIXTURES


def payload(**overrides: Any) -> dict[str, Any]:
    """A valid artifact, with whatever the test needs broken about it."""
    return {
        "schema_version": 1,
        "league": "nfl",
        "run_id": "r1",
        "created_at": "2026-09-01T01:44:20Z",
        "seasons": [2021, 2022, 2023, 2024, 2025],
        "metrics": {
            "epa_per_play": {
                "unit": "team-game",
                "n": 2850,
                "values": [i / 100 for i in range(CHECKPOINTS)],
            }
        },
        **overrides,
    }


class TestReadingTheArtifact:
    def test_reads_the_fixture(self) -> None:
        found = LocalDistributionStore(FIXTURES).get("nfl")

        assert found.league == "nfl"
        assert found.seasons == [2021, 2022, 2023, 2024, 2025]
        assert set(found.metrics) == {"epa_per_play", "game_control"}

    def test_every_metric_carries_a_hundred_and_one_checkpoints(self) -> None:
        found = LocalDistributionStore(FIXTURES).get("nfl")

        for name, metric in found.metrics.items():
            assert len(metric.values) == CHECKPOINTS, name
            assert metric.values == sorted(metric.values), name

    def test_the_population_is_named(self) -> None:
        """`n` can't say whether a metric was sampled once a game or once a
        side, and those are different claims about the same season."""
        metric = LocalDistributionStore(FIXTURES).get("nfl").metrics["epa_per_play"]
        assert metric.unit == "team-game"
        assert metric.n > 0

    def test_a_league_without_one_is_not_found(self) -> None:
        """Only football has these. Every basketball league misses forever,
        which is a state the page renders rather than an error."""
        with pytest.raises(DistributionsNotFound):
            LocalDistributionStore(FIXTURES).get("mens")


class TestRefusingABadOne:
    """The checkpoints are searched, not scanned.

    An array that is the wrong length or out of order doesn't raise in the
    lookup -- it silently answers the wrong percentile, which is the one
    failure mode this artifact has and the reason validation is not optional.
    """

    def test_too_few_checkpoints(self) -> None:
        broken = payload()
        broken["metrics"]["epa_per_play"]["values"] = [0.0, 1.0]

        with pytest.raises(DistributionsUnreadable):
            parse_distributions(json.dumps(broken), "nfl")

    def test_checkpoints_out_of_order(self) -> None:
        broken = payload()
        values = list(broken["metrics"]["epa_per_play"]["values"])
        values[60], values[61] = values[61], values[60]
        broken["metrics"]["epa_per_play"]["values"] = values

        with pytest.raises(DistributionsUnreadable):
            parse_distributions(json.dumps(broken), "nfl")

    def test_a_run_of_equal_checkpoints_is_fine(self) -> None:
        """Non-decreasing, not strictly increasing: a metric with a mass of
        ties -- a luck total that is 0 for most games -- legitimately repeats
        a value across a run of percentiles."""
        flat = payload()
        flat["metrics"]["epa_per_play"]["values"] = [0.0] * 40 + [
            i / 100 for i in range(CHECKPOINTS - 40)
        ]

        parsed = parse_distributions(json.dumps(flat), "nfl")
        assert len(parsed.metrics["epa_per_play"].values) == CHECKPOINTS

    def test_not_json_at_all(self) -> None:
        with pytest.raises(DistributionsUnreadable):
            parse_distributions("{oops", "nfl")


class TestTheEndpoint:
    def test_serves_the_leagues_metrics(self, client: TestClient) -> None:
        body = client.get("/api/leagues/nfl/distributions").json()

        assert body["league"] == "nfl"
        assert len(body["metrics"]["epa_per_play"]["values"]) == CHECKPOINTS

    def test_says_which_seasons_it_compared_against(self, client: TestClient) -> None:
        """A percentile without its population is a claim the page can't
        support, so the window travels with the numbers."""
        body = client.get("/api/leagues/nfl/distributions").json()
        assert body["seasons"] == [2021, 2022, 2023, 2024, 2025]

    def test_a_league_without_one_404s(self, client: TestClient) -> None:
        assert client.get("/api/leagues/mens/distributions").status_code == 404

    def test_an_unreadable_one_is_a_502(
        self, tmp_path: Path, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Not a 404: the object is there, and pointing someone at a missing
        file sends them looking in the wrong place. The fix is a republish."""
        from app.distributions import get_distribution_store
        from app.main import create_app

        directory = tmp_path / "distributions"
        directory.mkdir()
        (directory / "nfl.json").write_text('{"league": "nfl"}')

        app = create_app()
        app.dependency_overrides[get_distribution_store] = lambda: (
            LocalDistributionStore(tmp_path)
        )
        with caplog.at_level(logging.WARNING):
            response = TestClient(app).get("/api/leagues/nfl/distributions")

        assert response.status_code == 502
        assert "do not match the current schema" in caplog.text


class FakeS3:
    """Counts gets, and answers with whatever the test seeded."""

    def __init__(self, objects: dict[str, bytes]) -> None:
        self._objects = objects
        self.gets = 0

    def get_object(self, Bucket: str, Key: str) -> Any:  # noqa: N803 - boto3's
        self.gets += 1
        if Key not in self._objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": _Body(self._objects[Key])}


class _Body:
    def __init__(self, raw: bytes) -> None:
        self._raw = raw

    def read(self) -> bytes:
        return self._raw


class TestTheS3Store:
    def store(self, s3: FakeS3, **kwargs: Any) -> S3DistributionStore:
        return S3DistributionStore(bucket="artifacts", client=s3, **kwargs)

    def test_reads_the_object_under_the_prefix(self) -> None:
        s3 = FakeS3({"distributions/nfl.json": json.dumps(payload()).encode()})

        assert self.store(s3).get("nfl").league == "nfl"

    def test_a_second_read_inside_the_ttl_is_cached(self) -> None:
        s3 = FakeS3({"distributions/nfl.json": json.dumps(payload()).encode()})
        store = self.store(s3)

        store.get("nfl")
        store.get("nfl")

        assert s3.gets == 1

    def test_a_miss_is_cached_too(self) -> None:
        """Only football has these, so a basketball game page would otherwise
        send a doomed GET every time somebody opened one."""
        s3 = FakeS3({})
        store = self.store(s3)

        for _ in range(3):
            with pytest.raises(DistributionsNotFound):
                store.get("mens")

        assert s3.gets == 1

    def test_and_is_re_read_once_the_ttl_lapses(self) -> None:
        s3 = FakeS3({"distributions/nfl.json": json.dumps(payload()).encode()})
        store = self.store(s3, ttl_seconds=0)

        store.get("nfl")
        store.get("nfl")

        assert s3.gets == 2

    def test_an_unreachable_object_reads_as_missing(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """AccessDenied and a lost connection get the same answer a missing
        object does. The whole job of this file is an optional label, and a
        502 would take a game page down over an annotation."""

        class Denied(FakeS3):
            def get_object(self, Bucket: str, Key: str) -> Any:  # noqa: N803
                self.gets += 1
                raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")

        with caplog.at_level(logging.INFO):
            with pytest.raises(DistributionsNotFound):
                self.store(Denied({})).get("nfl")

        assert "no distributions" in caplog.text

    def test_a_bad_object_still_raises_unreadable(self) -> None:
        """The one failure that isn't smoothed over: it was fetched, so this
        is the data being wrong rather than the file being absent."""
        s3 = FakeS3({"distributions/nfl.json": b'{"league": "nfl"}'})

        with pytest.raises(DistributionsUnreadable):
            self.store(s3).get("nfl")
