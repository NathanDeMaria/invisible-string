import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import boto3
import pytest
from moto import mock_aws

from app.releases import ReleaseNotFound, latest_releases, pick_default
from app.s3 import S3ReleaseStore

BUCKET = "invisible-string-artifacts"
FIXTURES = Path(__file__).parent / "fixtures" / "models"


@pytest.fixture
def s3() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-2")
        client.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-east-2"},
        )
        # Upload the same fixtures the local store tests use, laid out the way
        # the real bucket is.
        for path in FIXTURES.glob("*/*/latest.json"):
            league, model = path.parent.parent.name, path.parent.name
            client.put_object(
                Bucket=BUCKET,
                Key=f"models/{league}/{model}/latest.json",
                Body=path.read_bytes(),
            )
        yield client


@pytest.fixture
def store(s3: Any) -> S3ReleaseStore:
    return S3ReleaseStore(bucket=BUCKET, client=s3)


class CountingClient:
    """Wraps the moto client and counts get_object calls.

    The cache is the whole point of this store, and a cache that silently
    isn't caching looks identical from the outside -- so count the calls
    rather than trusting the return values.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.get_object_calls = 0
        self.conditional_calls = 0
        self.paginator_calls = 0

    def get_object(self, **kwargs: Any) -> Any:
        self.get_object_calls += 1
        if "IfNoneMatch" in kwargs:
            self.conditional_calls += 1
        return self._inner.get_object(**kwargs)

    def get_paginator(self, name: str) -> Any:
        self.paginator_calls += 1
        return self._inner.get_paginator(name)


class TestListing:
    def test_lists_leagues(self, store: S3ReleaseStore) -> None:
        assert store.list_leagues() == ["mens", "womens"]

    def test_lists_models_for_a_league(self, store: S3ReleaseStore) -> None:
        assert store.list_models("mens") == ["elo", "glicko_tuned"]

    def test_unknown_league_lists_nothing(self, store: S3ReleaseStore) -> None:
        assert store.list_models("nfl") == []


class TestGetLatest:
    def test_reads_a_release(self, store: S3ReleaseStore) -> None:
        release = store.get_latest("mens", "glicko_tuned")
        assert release.model == "glicko_tuned"
        assert release.ratings["Duke"].rating == 1834.2

    def test_missing_key_raises(self, store: S3ReleaseStore) -> None:
        with pytest.raises(ReleaseNotFound):
            store.get_latest("mens", "nope")

    def test_missing_league_raises(self, store: S3ReleaseStore) -> None:
        with pytest.raises(ReleaseNotFound):
            store.get_latest("nfl", "elo")


class TestCaching:
    def test_second_read_within_ttl_does_not_call_s3(self, s3: Any) -> None:
        client = CountingClient(s3)
        store = S3ReleaseStore(bucket=BUCKET, client=client, ttl_seconds=60)

        store.get_latest("mens", "elo")
        store.get_latest("mens", "elo")
        store.get_latest("mens", "elo")

        assert client.get_object_calls == 1

    def test_expired_ttl_revalidates_conditionally(self, s3: Any) -> None:
        """After the TTL, re-check with If-None-Match rather than re-download."""
        client = CountingClient(s3)
        store = S3ReleaseStore(bucket=BUCKET, client=client, ttl_seconds=0)

        first = store.get_latest("mens", "elo")
        second = store.get_latest("mens", "elo")

        assert client.get_object_calls == 2
        assert client.conditional_calls == 1
        # 304 means the cached object is handed back, not a re-parse.
        assert second is first

    def test_picks_up_a_new_release_after_the_ttl(self, s3: Any) -> None:
        store = S3ReleaseStore(bucket=BUCKET, client=s3, ttl_seconds=0)
        assert store.get_latest("mens", "elo").run_id == "2026-08-08T09:01:44Z"

        body = json.loads(
            (FIXTURES / "mens" / "elo" / "latest.json").read_text(),
        )
        body["run_id"] = "2026-08-09T09:00:00Z"
        s3.put_object(
            Bucket=BUCKET,
            Key="models/mens/elo/latest.json",
            Body=json.dumps(body).encode(),
        )

        assert store.get_latest("mens", "elo").run_id == "2026-08-09T09:00:00Z"

    def test_a_new_release_is_hidden_until_the_ttl_lapses(self, s3: Any) -> None:
        """The flip side of the TTL, stated so the staleness window is a
        deliberate choice rather than a surprise."""
        store = S3ReleaseStore(bucket=BUCKET, client=s3, ttl_seconds=3600)
        assert store.get_latest("mens", "elo").run_id == "2026-08-08T09:01:44Z"

        body = json.loads((FIXTURES / "mens" / "elo" / "latest.json").read_text())
        body["run_id"] = "2026-08-09T09:00:00Z"
        s3.put_object(
            Bucket=BUCKET,
            Key="models/mens/elo/latest.json",
            Body=json.dumps(body).encode(),
        )

        assert store.get_latest("mens", "elo").run_id == "2026-08-08T09:01:44Z"

    def test_listings_are_cached_too(self, s3: Any) -> None:
        client = CountingClient(s3)
        store = S3ReleaseStore(bucket=BUCKET, client=client, ttl_seconds=60)

        store.list_models("mens")
        store.list_models("mens")

        # Counted, not compared: two uncached listings return equal results
        # too, so an equality assertion passes with no cache at all.
        assert client.paginator_calls == 1

    def test_cached_listing_is_not_mutable_by_callers(
        self, store: S3ReleaseStore
    ) -> None:
        """A caller sorting the returned list in place must not corrupt the cache.

        Mutates the result of the *second* call on purpose: the first call
        builds a fresh list regardless, so mutating that one exercises nothing.
        The cache-hit path is the one that can hand out its own storage.
        """
        store.list_models("mens")
        from_cache = store.list_models("mens")
        from_cache.reverse()
        assert store.list_models("mens") == ["elo", "glicko_tuned"]


class TestAgainstTheRestOfTheApp:
    def test_default_model_selection_works_over_s3(self, store: S3ReleaseStore) -> None:
        """The same lowest-Brier rule the local store is tested for, so the
        two implementations can't disagree about what the API serves."""
        assert pick_default(latest_releases(store, "mens")).model == "glicko_tuned"
