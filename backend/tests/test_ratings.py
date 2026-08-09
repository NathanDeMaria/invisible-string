import pytest
from fastapi.testclient import TestClient

from app.releases import (
    ReleaseNotFound,
    ReleaseStore,
    latest_releases,
    pick_default,
)


def test_healthz(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"status": "ok"}


class TestPickDefault:
    """The lowest-Brier rule from DESIGN.md section 11.1.

    The mens fixtures are built so that elo has both a *worse* Brier score and
    a *better* against-spread accuracy than glicko_tuned. So picking by max
    Brier, or by ATS accuracy at all, returns elo -- only the correct rule
    returns glicko_tuned.
    """

    def test_picks_lowest_brier(self, store: ReleaseStore) -> None:
        chosen = pick_default(latest_releases(store, "mens"))
        assert chosen.model == "glicko_tuned"

    def test_not_fooled_by_ats_accuracy(self, store: ReleaseStore) -> None:
        releases = latest_releases(store, "mens")
        best_ats = max(releases, key=lambda r: r.metrics.against_spread_accuracy or 0.0)
        assert best_ats.model == "elo"
        assert pick_default(releases).model != best_ats.model

    def test_empty_raises(self) -> None:
        with pytest.raises(ReleaseNotFound):
            pick_default([])


class TestListLeagues:
    def test_lists_both_leagues(self, client: TestClient) -> None:
        body = client.get("/api/leagues").json()
        assert [entry["league"] for entry in body] == ["mens", "womens"]

    def test_marks_exactly_one_default_per_league(self, client: TestClient) -> None:
        for entry in client.get("/api/leagues").json():
            defaults = [m["name"] for m in entry["models"] if m["is_default"]]
            assert len(defaults) == 1, entry["league"]

    def test_default_is_lowest_brier(self, client: TestClient) -> None:
        body = client.get("/api/leagues").json()
        mens = next(e for e in body if e["league"] == "mens")
        assert [m["name"] for m in mens["models"] if m["is_default"]] == [
            "glicko_tuned"
        ]


class TestRatings:
    def test_defaults_to_lowest_brier_model(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/ratings").json()
        assert body["model"] == "glicko_tuned"
        assert body["run_id"] == "2026-08-08T09:00:12Z"

    def test_explicit_model_is_honored(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/ratings?model=elo").json()
        assert body["model"] == "elo"

    def test_ranks_descending_by_rating(self, client: TestClient) -> None:
        rows = client.get("/api/leagues/mens/ratings?model=elo").json()["ratings"]
        assert [r["rank"] for r in rows] == [1, 2, 3, 4]
        assert [r["team"] for r in rows] == [
            "Duke",
            "Houston",
            "North Carolina",
            "Kansas",
        ]

    def test_ties_break_on_team_name(self, client: TestClient) -> None:
        """Duke and Houston are both 1834.2 in the glicko fixture.

        Without a deterministic tiebreak these two swap depending on dict
        ordering, so the table reshuffles between deploys for no reason.
        """
        rows = client.get("/api/leagues/mens/ratings").json()["ratings"]
        assert [r["team"] for r in rows[:2]] == ["Duke", "Houston"]
        assert rows[0]["rating"] == rows[1]["rating"]

    def test_rd_is_null_when_the_model_has_none(self, client: TestClient) -> None:
        rows = client.get("/api/leagues/mens/ratings?model=elo").json()["ratings"]
        assert all(r["rd"] is None for r in rows)

    def test_rd_present_for_glicko(self, client: TestClient) -> None:
        rows = client.get("/api/leagues/mens/ratings").json()["ratings"]
        assert rows[0]["rd"] == 71.4

    def test_carries_freshness_metadata(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/ratings").json()
        assert body["trained_through"]["season_year"] == 2026
        assert body["metrics"]["brier_score"] == 0.1782

    def test_unknown_league_404s(self, client: TestClient) -> None:
        assert client.get("/api/leagues/nfl/ratings").status_code == 404

    def test_unknown_model_404s(self, client: TestClient) -> None:
        assert client.get("/api/leagues/mens/ratings?model=nope").status_code == 404
