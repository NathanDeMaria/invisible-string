"""Hiding the teams a league doesn't field any more (`app.teams`).

The wnba fixture is a small version of the real thing: four teams that play
now and three names that nothing answers to -- one folded, one relocated under
a new name, and one whose name a 2026 expansion team took back.
"""

from fastapi.testclient import TestClient

from app.teams import still_playing


class TestStillPlaying:
    def test_a_folded_team_is_not_playing(self) -> None:
        assert not still_playing("wnba", "Houston Comets")

    def test_a_relocated_teams_old_name_is_not_playing(self) -> None:
        # The franchise is alive and playing in Las Vegas. Nothing answers to
        # the name it left behind.
        assert not still_playing("wnba", "San Antonio Stars")

    def test_a_current_team_is_playing(self) -> None:
        assert still_playing("wnba", "Las Vegas Aces")

    def test_a_name_that_came_back_is_playing(self) -> None:
        # The Portland Fire folded in 2002 and the name is a 2026 expansion
        # team's. A list of dead *franchises* would have hidden a team that
        # plays this week; this is a list of dead *names*.
        assert still_playing("wnba", "Portland Fire")

    def test_a_league_nobody_curated_hides_nothing(self) -> None:
        # The college leagues, where every team the model has seen is still
        # out there -- and any league added before anyone writes it a list.
        assert still_playing("mens", "Houston Comets")
        assert still_playing("nfl", "Houston Comets")

    def test_matching_survives_the_upstream_s_spacing_and_case(self) -> None:
        # Matched against whatever ESPN wrote into a season file years ago.
        assert not still_playing("wnba", "  houston comets ")
        assert not still_playing("WNBA", "Houston Comets")


class TestRatingsDropThem:
    def test_leaderboard_holds_only_teams_that_play(self, client: TestClient) -> None:
        rows = client.get("/api/leagues/wnba/ratings").json()["ratings"]
        assert [row["team"] for row in rows] == [
            "Las Vegas Aces",
            "New York Liberty",
            "Minnesota Lynx",
            "Portland Fire",
        ]

    def test_ranks_count_teams_rather_than_history(self, client: TestClient) -> None:
        # The Comets rate above two of these, so leaving them in the sort and
        # dropping them afterwards would hand out 1, 2, 4, 5. A leaderboard
        # whose 4th is really 5th is worse than one that's short.
        rows = client.get("/api/leagues/wnba/ratings").json()["ratings"]
        assert [row["rank"] for row in rows] == [1, 2, 3, 4]

    def test_other_leagues_keep_every_team(self, client: TestClient) -> None:
        rows = client.get("/api/leagues/mens/ratings").json()["ratings"]
        assert len(rows) == 4

    def test_predict_still_answers_for_a_team_that_stopped(
        self, client: TestClient
    ) -> None:
        # A saved link to an old matchup is a fair question about what the
        # ratings say. Hiding a team from the picker isn't a claim that the
        # model has nothing to say about it.
        body = client.get(
            "/api/predict?league=wnba&home=Houston Comets&away=Las Vegas Aces"
        )
        assert body.status_code == 200
        assert body.json()["home"] == "Houston Comets"
