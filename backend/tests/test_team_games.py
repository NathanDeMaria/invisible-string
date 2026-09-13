"""One team's games, out of the run's own predictions.

The fixture is four mens games, and Duke is in two of them -- at home against
North Carolina and away at Houston. That pairing is what these are built on:
the file quotes every number from the home team's side, so the away row is the
one that has to come back turned around, and a bug that forgot to turn it
would still look entirely reasonable on the home one.
"""

import pytest
from fastapi.testclient import TestClient

from app.artifacts import ArtifactStore


def _games(client: TestClient, team: str, **params: str) -> list[dict]:
    response = client.get(f"/api/leagues/mens/teams/{team}/games", params=params)
    assert response.status_code == 200
    return response.json()["games"]


class TestATeamsGames:
    def test_lists_the_games_the_model_has_a_forecast_for(
        self, client: TestClient
    ) -> None:
        assert [row["game_id"] for row in _games(client, "Duke")] == [
            "401710103",
            "401710101",
        ]

    def test_newest_first(self, client: TestClient) -> None:
        """The opposite order from the history endpoint, on purpose: that one
        is drawing a line and has to walk it forwards, and this is a list
        somebody came to to look up last night."""
        dates = [row["date"] for row in _games(client, "Duke")]
        assert dates == sorted(dates, reverse=True)

    def test_a_home_game_reads_off_the_file_unchanged(self, client: TestClient) -> None:
        row = next(r for r in _games(client, "Duke") if r["game_id"] == "401710101")

        assert row["home"] is True
        assert row["opponent"] == "North Carolina"
        assert (row["team_score"], row["opponent_score"]) == (78, 71)
        assert row["win_prob"] == 0.62
        # +5.5 of margin for the home team is a spread of -5.5, which is the
        # negation `/api/games` applies to the same stored row.
        assert row["predicted_spread"] == -5.5
        assert row["market_spread"] == -4.5

    def test_an_away_game_is_turned_around(self, client: TestClient) -> None:
        """The same row Houston's page would show from the other end.

        Houston were 0.55 at home by 1.75, laying 1.5. From Duke's side that
        is 0.45, getting 1.75, taking 1.5 -- and the score reads the other way
        too.
        """
        row = next(r for r in _games(client, "Duke") if r["game_id"] == "401710103")

        assert row["home"] is False
        assert row["opponent"] == "Houston"
        assert (row["team_score"], row["opponent_score"]) == (59, 61)
        # Approximate because it is a complement: 1 - 0.55 is not 0.45 in
        # binary, and rounding it on the way out would be this endpoint
        # inventing a precision the model never claimed.
        assert row["win_prob"] == pytest.approx(0.45)
        assert row["predicted_spread"] == pytest.approx(1.75)
        assert row["market_spread"] == pytest.approx(1.5)

    def test_the_two_sides_of_one_game_agree(self, client: TestClient) -> None:
        """Duke's row and Houston's row for the same fixture are one game read
        from two ends, and every number in them has to be each other's
        complement -- which is the property the flip exists to produce."""
        duke = next(r for r in _games(client, "Duke") if r["game_id"] == "401710103")
        houston = next(
            r for r in _games(client, "Houston") if r["game_id"] == "401710103"
        )

        assert duke["home"] != houston["home"]
        assert duke["opponent"] == "Houston"
        assert houston["opponent"] == "Duke"
        assert duke["win_prob"] + houston["win_prob"] == pytest.approx(1.0)
        assert duke["predicted_spread"] == pytest.approx(-houston["predicted_spread"])
        assert duke["market_spread"] == pytest.approx(-houston["market_spread"])
        assert duke["team_score"] == houston["opponent_score"]

    def test_carries_the_season_a_link_needs(self, client: TestClient) -> None:
        """The game page can't find a game outside the fortnight around today
        without its season (`app.games.find_game`), so every row carries the
        one the model filed it under."""
        row = _games(client, "Duke")[0]
        assert (row["season"], row["week"]) == (2026, 1)

    def test_names_the_model_that_forecast_them(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/teams/Duke/games").json()
        assert body["model"] == "glicko_tuned"
        assert body["run_id"] == "2026-08-08T09:00:12Z"
        assert body["team"] == "Duke"


class TestWhatIsntThere:
    def test_a_team_with_no_rows_is_an_empty_list(self, client: TestClient) -> None:
        """Not a 404. This file cannot tell a team that doesn't exist from one
        whose model hasn't published predictions -- and the caller is holding
        the ratings table, which can (`app.api.history` says the same)."""
        assert _games(client, "Vermont") == []

    def test_a_model_published_without_the_artifact(self, client: TestClient) -> None:
        """elo has no predictions file in the fixtures, which is every model in
        the bucket until it is republished. The page loses its list, not its
        chart."""
        assert _games(client, "Duke", model="elo") == []

    def test_no_artifacts_at_all_is_an_empty_list(
        self, store, no_artifacts: ArtifactStore
    ) -> None:
        from app.artifacts import get_artifact_store
        from app.main import create_app
        from app.releases import get_release_store

        app = create_app()
        app.dependency_overrides[get_release_store] = lambda: store
        app.dependency_overrides[get_artifact_store] = lambda: no_artifacts
        client = TestClient(app)

        assert _games(client, "Duke") == []

    def test_an_unknown_league_404s(self, client: TestClient) -> None:
        response = client.get("/api/leagues/nope/teams/Duke/games")
        assert response.status_code == 404

    def test_an_unknown_model_404s(self, client: TestClient) -> None:
        response = client.get(
            "/api/leagues/mens/teams/Duke/games", params={"model": "nope"}
        )
        assert response.status_code == 404
