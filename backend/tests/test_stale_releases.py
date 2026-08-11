"""What happens when the bucket and the code have drifted apart.

This is not hypothetical. Merging the margin-calibration change renamed
`spread_calibration` to `margin_calibration` and made `margin_mae` required,
which invalidated every artifact already published -- and because the
validation error escaped from the middle of a list comprehension in
`latest_releases`, one stale object turned `/api/leagues` into a 500 for
*every* league at once.

The fixtures under `fixtures/stale/` are the real pre-rename artifacts, pulled
straight out of git at 7f590be, so these tests fail the way production did
rather than the way a hand-written mock would.

Layout: mens has one stale model (elo) and one current one (glicko_tuned);
womens has nothing but a stale model. That covers partial and total failure in
one tree.
"""

import logging

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.releases import (
    LocalReleaseStore,
    ReleaseNotFound,
    ReleaseStore,
    ReleaseUnreadable,
    get_release_store,
    latest_releases,
)

from .conftest import FIXTURES


@pytest.fixture
def stale_store() -> ReleaseStore:
    return LocalReleaseStore(FIXTURES / "stale")


@pytest.fixture
def stale_client(stale_store: ReleaseStore) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_release_store] = lambda: stale_store
    return TestClient(app)


def test_the_fixture_really_is_stale(stale_store: ReleaseStore) -> None:
    """Guards every test below.

    If the stale fixture ever gets "helpfully" migrated to the current schema,
    these tests keep passing while testing nothing at all.
    """
    with pytest.raises(ReleaseUnreadable):
        stale_store.get_latest("mens", "elo")


class TestPartialFailure:
    """One stale model alongside a good one."""

    def test_the_good_model_still_comes_back(self, stale_store: ReleaseStore) -> None:
        assert [r.model for r in latest_releases(stale_store, "mens")] == [
            "glicko_tuned"
        ]

    def test_the_index_still_lists_the_league(self, stale_client: TestClient) -> None:
        body = stale_client.get("/api/leagues").json()
        assert [e["league"] for e in body] == ["mens"]
        assert [m["name"] for m in body[0]["models"]] == ["glicko_tuned"]

    def test_ratings_serve_from_the_good_model(self, stale_client: TestClient) -> None:
        response = stale_client.get("/api/leagues/mens/ratings")
        assert response.status_code == 200
        assert response.json()["model"] == "glicko_tuned"

    def test_the_skip_is_logged_with_the_model_name(
        self, stale_store: ReleaseStore, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Degrading quietly is only acceptable if it isn't silent."""
        with caplog.at_level(logging.WARNING, logger="app.releases"):
            latest_releases(stale_store, "mens")
        assert any("mens/elo" in r.getMessage() for r in caplog.records)


class TestTotalFailure:
    """A league where every artifact is stale."""

    def test_raises_unreadable_not_not_found(self, stale_store: ReleaseStore) -> None:
        """The distinction is the whole point of the second exception type.

        Objects are sitting in the bucket. Calling that "not found" sends
        someone looking for something that is plainly there.
        """
        with pytest.raises(ReleaseUnreadable):
            latest_releases(stale_store, "womens")

    def test_ratings_502_rather_than_404(self, stale_client: TestClient) -> None:
        response = stale_client.get("/api/leagues/womens/ratings")
        assert response.status_code == 502
        assert "womens" in response.json()["detail"]

    def test_explicit_stale_model_502s(self, stale_client: TestClient) -> None:
        response = stale_client.get("/api/leagues/mens/ratings?model=elo")
        assert response.status_code == 502

    def test_the_index_omits_the_league_entirely(
        self, stale_client: TestClient
    ) -> None:
        """Rather than 500ing, which is what shipped."""
        body = stale_client.get("/api/leagues").json()
        assert "womens" not in [e["league"] for e in body]

    def test_a_genuinely_empty_league_is_still_a_404(
        self, stale_store: ReleaseStore
    ) -> None:
        """Unreadable must not swallow the not-found case it sits next to."""
        with pytest.raises(ReleaseNotFound):
            latest_releases(stale_store, "nfl")
