"""`/api/leagues/{league}/history` -- the long read of the same artifact.

The mens fixture holds two seasons for four teams: six weeks of 2025 and two
of 2026, which is what makes the season boundary and the range filter
testable rather than hypothetical.
"""

from fastapi.testclient import TestClient


def _series(client: TestClient, league: str, teams: str, **params) -> dict:
    response = client.get(
        f"/api/leagues/{league}/history", params={"teams": teams, **params}
    )
    assert response.status_code == 200, response.text
    return {entry["team"]: entry["points"] for entry in response.json()["series"]}


class TestOneTeam:
    def test_every_week_it_has_been_rated(self, client: TestClient) -> None:
        points = _series(client, "mens", "Duke")["Duke"]
        assert len(points) == 8
        assert (points[0]["year"], points[0]["week"]) == (2025, 1)
        assert (points[-1]["year"], points[-1]["week"]) == (2026, 2)

    def test_oldest_first(self, client: TestClient) -> None:
        """A chart drawn in whatever order the rows arrived is the kind of
        wrong that looks like a data problem."""
        points = _series(client, "mens", "Duke")["Duke"]
        keys = [(p["year"], p["week"]) for p in points]
        assert keys == sorted(keys)

    def test_a_point_carries_what_a_tooltip_needs(self, client: TestClient) -> None:
        """The rating is the line; the rest is what a reader asks of a point
        they've stopped on -- when it was, and what the team's record was."""
        last = _series(client, "mens", "Duke")["Duke"][-1]
        assert last["rating"] == 1834.2
        assert last["rd"] == 71.4
        assert (last["wins"], last["losses"]) == (24, 5)
        assert last["date"].startswith("2026-08-07")

    def test_it_names_the_run_it_came_from(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/history", params={"teams": "Duke"}).json()
        assert body["model"] == "glicko_tuned"
        assert body["run_id"] == "2026-08-08T09:00:12Z"


class TestSeveralTeams:
    def test_in_the_order_they_were_asked_for(self, client: TestClient) -> None:
        """A compare chart's first line is the one the reader named first."""
        body = client.get(
            "/api/leagues/mens/history",
            params={"teams": "Kansas,Duke,Houston"},
        ).json()
        assert [entry["team"] for entry in body["series"]] == [
            "Kansas",
            "Duke",
            "Houston",
        ]

    def test_a_repeat_is_one_series(self, client: TestClient) -> None:
        body = client.get(
            "/api/leagues/mens/history", params={"teams": "Duke, Duke ,Duke"}
        ).json()
        assert [entry["team"] for entry in body["series"]] == ["Duke"]

    def test_too_many_is_a_422(self, client: TestClient) -> None:
        """Nobody reads six overlaid lines, and refusing is cheaper than
        serving a chart that can't be read."""
        response = client.get(
            "/api/leagues/mens/history",
            params={"teams": "a,b,c,d,e,f"},
        )
        assert response.status_code == 422

    def test_naming_none_is_a_422(self, client: TestClient) -> None:
        assert (
            client.get("/api/leagues/mens/history", params={"teams": " , "}).status_code
            == 422
        )

    def test_teams_is_required(self, client: TestClient) -> None:
        # No default, deliberately: the whole table is 360 lines.
        assert client.get("/api/leagues/mens/history").status_code == 422


class TestTheRange:
    def test_from_and_to_narrow_it(self, client: TestClient) -> None:
        points = _series(client, "mens", "Duke", **{"from": 2026})["Duke"]
        assert {p["year"] for p in points} == {2026}

    def test_a_range_with_nothing_in_it_is_empty(self, client: TestClient) -> None:
        assert _series(client, "mens", "Duke", **{"from": 2030})["Duke"] == []

    def test_the_default_is_everything(self, client: TestClient) -> None:
        """A team's whole history is a few hundred points, so the page filters
        its own range rather than going back to the network for it."""
        points = _series(client, "mens", "Duke")["Duke"]
        assert {p["year"] for p in points} == {2025, 2026}


class TestWhenThereIsNothingToDraw:
    def test_a_team_with_no_rows_is_an_empty_series(self, client: TestClient) -> None:
        """Not a 404: this file can't tell a team that doesn't exist from one
        its model hasn't rated, and the caller holds the ratings table where
        that question is answerable."""
        assert _series(client, "mens", "Vermont")["Vermont"] == []

    def test_a_model_with_no_history_serves_empty_series(
        self, client: TestClient
    ) -> None:
        """Every model published before the artifact existed -- and the read is
        per *model*, not per league: glicko has a history and elo doesn't, and
        reading the league's would draw one model's line under the other's
        name."""
        assert _series(client, "mens", "Duke", model="elo")["Duke"] == []

    def test_a_league_with_no_release_is_a_404(self, client: TestClient) -> None:
        assert (
            client.get(
                "/api/leagues/nfl/history", params={"teams": "Chicago Bears"}
            ).status_code
            == 404
        )

    def test_an_unknown_model_is_a_404(self, client: TestClient) -> None:
        assert (
            client.get(
                "/api/leagues/mens/history",
                params={"teams": "Duke", "model": "nope"},
            ).status_code
            == 404
        )
