"""The game page's two endpoints: one game, and its win probability curve.

The join these test is the point of the feature -- a game from the season
files, a fit from inside a package, and plays from a third prefix -- and every
one of the three can be absent for a reason that isn't a failure. What matters
is that each absence degrades to the right thing: a league with no fit gets no
chart, a game with no play-by-play gets an empty one, and only an upstream
that refused to be read is an error.
"""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.games import GamesSource, GamesUnavailable, GameWindow, get_games_source
from app.jobs import JobsSource, get_jobs_source
from app.main import create_app
from app.plays import PlaysSource, PlaysUnavailable, get_plays_source
from app.releases import ReleaseStore, get_release_store
from app.win_probability import curve_for, fit_for

GAME = "/api/games/nfl/401910101"


@pytest.fixture
def client_over(
    store: ReleaseStore,
    jobs_source: JobsSource,
    games_source: GamesSource,
    plays_source: PlaysSource,
) -> Callable[..., TestClient]:
    """The usual client with one upstream swapped for a broken one.

    Both endpoints have two upstreams behind them and each fails differently,
    so the tests below need to break exactly one at a time.
    """

    def build(games: Any = None, plays: Any = None) -> TestClient:
        app = create_app()
        app.dependency_overrides[get_release_store] = lambda: store
        app.dependency_overrides[get_jobs_source] = lambda: jobs_source
        app.dependency_overrides[get_games_source] = lambda: games or games_source
        app.dependency_overrides[get_plays_source] = lambda: plays or plays_source
        return TestClient(app)

    return build


class TestTheFits:
    def test_football_has_one(self) -> None:
        assert fit_for("nfl") is not None
        assert fit_for("ncaafb") is not None

    def test_basketball_doesnt(self) -> None:
        """Not a gap to fill -- there is no in-game win probability model for
        a basketball game here, and the games page lists every league."""
        assert fit_for("mens") is None
        assert fit_for("wnba") is None

    def test_an_unknown_league_doesnt(self) -> None:
        assert fit_for("quidditch") is None


class TestCurveFor:
    def test_no_plays_is_an_empty_curve(self) -> None:
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, [])
        assert curve.points == []
        assert curve.control is None
        assert curve.home_team_id is None

    def test_a_game_it_cant_place_is_an_empty_curve(self) -> None:
        """`group_by_game` drops a game whose scoring drives don't say which
        side the home score belongs to, rather than guessing and sign-flipping
        every feature in it."""
        from app.plays import FixturePlay

        fit = fit_for("nfl")
        assert fit is not None
        scoreless = [
            FixturePlay(
                league="nfl",
                season=2026,
                week=3,
                game_id="1",
                play_id=f"p{n}",
                play_number=n,
                period=1,
                clock_seconds=900 - n,
                down=1,
                distance=10,
                yardline=25,
                offense_team_id="3",
                home_score=0,
                away_score=0,
            )
            for n in range(1, 5)
        ]
        assert curve_for(fit, scoreless).points == []


class TestTheGameEndpoint:
    def test_serves_one_game(self, client: TestClient) -> None:
        body = client.get(GAME).json()
        assert body["home"] == "Chicago Bears"
        assert body["away"] == "Green Bay Packers"
        assert (body["home_score"], body["away_score"]) == (17, 24)
        assert body["market_spread"] == 6.5

    def test_carries_the_partition_its_plays_live_in(self, client: TestClient) -> None:
        body = client.get(GAME).json()
        assert (body["season"], body["week"]) == (2026, 3)

    def test_says_whether_a_curve_is_worth_asking_for(self, client: TestClient) -> None:
        """A property of the league, not of the game: it says the request
        can be answered at all, not that there are plays behind it."""
        assert client.get(GAME).json()["has_win_probability"] is True
        assert (
            client.get("/api/games/mens/401710101").json()["has_win_probability"]
            is False
        )

    def test_agrees_with_the_table_it_was_reached_from(
        self, client: TestClient
    ) -> None:
        """Same window, same release. A game page that disagreed with the row
        that linked to it would be worse than no game page."""
        row = next(
            game
            for game in client.get("/api/games", params={"back": 7}).json()["games"]
            if game["game_id"] == "401910101"
        )
        detail = client.get(GAME).json()
        assert {key: detail[key] for key in row} == row

    def test_a_game_outside_the_horizon_is_a_404(self, client: TestClient) -> None:
        """The window is a cost cap (§13.2), so a link that outlived it says
        so rather than rendering an empty page."""
        assert client.get("/api/games/nfl/000000").status_code == 404

    def test_an_unreadable_bucket_is_a_502(self, client_over: Any) -> None:
        client = client_over(games=_raises(GamesUnavailable("nope")))
        assert client.get(GAME).status_code == 502


class TestTheWinProbabilityEndpoint:
    def test_draws_the_curve(self, client: TestClient) -> None:
        body = client.get(f"{GAME}/win-probability").json()
        assert len(body["points"]) > 50
        assert all(0.0 <= p["home_win_prob"] <= 1.0 for p in body["points"])

    def test_the_points_run_down_the_clock(self, client: TestClient) -> None:
        """`seconds_remaining` is the time axis, so it has to be monotone --
        a fixture whose clock went backwards would draw a line that doubles
        back on itself."""
        points = client.get(f"{GAME}/win-probability").json()["points"]
        assert points == sorted(points, key=lambda p: -p["seconds_remaining"])

    def test_a_point_carries_what_a_tooltip_needs(self, client: TestClient) -> None:
        first = client.get(f"{GAME}/win-probability").json()["points"][0]
        assert first["period"] == 1
        assert (first["home_score"], first["away_score"]) == (0, 0)

    def test_names_the_fit_that_drew_it(self, client: TestClient) -> None:
        fit = client.get(f"{GAME}/win-probability").json()["fit"]
        assert fit["league"] == "nfl"
        assert fit["run_id"]
        assert 0 < fit["brier_score"] < 1

    def test_says_which_side_it_took_for_home(self, client: TestClient) -> None:
        """Inferred from the scoring drives, since nothing in the play data
        ties a team id to the home score -- so the page can show its work."""
        body = client.get(f"{GAME}/win-probability").json()
        assert (body["home_team_id"], body["away_team_id"]) == ("3", "9")

    def test_reports_game_control_over_the_clock_it_covers(
        self, client: TestClient
    ) -> None:
        control = client.get(f"{GAME}/win-probability").json()["control"]
        assert control["home"] + control["away"] == pytest.approx(1.0)
        assert 0 < control["seconds"] <= 3600

    def test_says_whether_the_fit_has_seen_this_season(
        self, client: TestClient
    ) -> None:
        assert (
            client.get(f"{GAME}/win-probability").json()["trained_on_this_season"]
            is False
        )

    def test_a_game_with_no_plays_is_an_empty_curve(self, client: TestClient) -> None:
        """A game that hasn't kicked off. 200 with nothing to draw, not a
        404: the page still has a game on it."""
        body = client.get("/api/games/nfl/401910102/win-probability").json()
        assert body["points"] == []
        assert body["control"] is None
        assert body["home"] == "Green Bay Packers"

    def test_a_league_with_no_fit_is_a_404(self, client: TestClient) -> None:
        assert (
            client.get("/api/games/mens/401710101/win-probability").status_code == 404
        )

    def test_a_game_outside_the_horizon_is_a_404(self, client: TestClient) -> None:
        assert client.get("/api/games/nfl/000000/win-probability").status_code == 404

    def test_an_unreadable_plays_prefix_is_a_502(self, client_over: Any) -> None:
        """The one case that is ours rather than the game's."""
        client = client_over(plays=_raises(PlaysUnavailable("denied")))
        assert client.get(f"{GAME}/win-probability").status_code == 502


def _raises(error: Exception) -> Any:
    class Broken:
        def window(self, days_back: int, days_ahead: int) -> GameWindow:
            raise error

        def game(self, league: str, season: int, week: int, game_id: str) -> list[Any]:
            raise error

    return Broken()
