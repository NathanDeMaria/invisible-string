"""The game page's two endpoints: one game, and its win probability curve.

The join these test is the point of the feature -- a game from the season
files, a fit from inside a package, and plays from a third prefix -- and every
one of the three can be absent for a reason that isn't a failure. What matters
is that each absence degrades to the right thing: a league with no fit gets no
chart, a game with no play-by-play gets an empty one, and only an upstream
that refused to be read is an error.
"""

from collections.abc import Callable, Mapping
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.games import GamesSource, GamesUnavailable, GameWindow, get_games_source
from app.jobs import JobsSource, get_jobs_source
from app.main import create_app
from app.plays import FixturePlay, PlaysSource, PlaysUnavailable, get_plays_source
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

    def test_no_plays_has_nothing_to_adjust_either(self) -> None:
        """The second curve is the first one's shape, so no game is no game
        twice over -- and `luck` is None rather than 0.00/0.00, which on a
        game that was played means "nothing bounced"."""
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, [])
        assert curve.adjusted == []
        assert curve.adjusted_control is None
        assert curve.luck is None
        assert curve.records_defended_passes is False

    def test_a_game_it_cant_place_is_an_empty_curve(self) -> None:
        """`group_by_game` drops a game whose scoring drives don't say which
        side the home score belongs to, rather than guessing and sign-flipping
        every feature in it."""
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


HOME, AWAY = "3", "9"


def synthetic_game(
    texts: Mapping[int, str] | None = None, length: int = 12
) -> list[FixturePlay]:
    """A whole game of ordinary snaps, with ESPN's sentence on the ones named.

    Four-snap drives, alternating, and one touchdown for the home side --
    which is the smallest thing `group_by_game` will take, since which team
    the home score belongs to is inferred from the scoring drives and nothing
    else.

    `texts` is what makes a play a bounce: the manner of a play is in the
    sentence or nowhere, so a game with no text in it has nothing to adjust
    however it was played. Keyed by play number, which is also where a drive
    boundary is -- a fumble on the last snap of a drive is one the other team
    came up with, and one in the middle of a drive is one the offense kept.
    """
    texts = texts or {}
    return [
        FixturePlay(
            league="nfl",
            season=2026,
            week=3,
            game_id="synthetic",
            play_id=f"p{number:03d}",
            play_number=number,
            period=1,
            clock_seconds=900 - number * 10,
            down=1,
            distance=10,
            yardline=25,
            offense_team_id=(HOME if (number - 1) // 4 % 2 else AWAY),
            drive_team_id=(HOME if (number - 1) // 4 % 2 else AWAY),
            home_score=0 if number < 8 else 7,
            away_score=0,
            text=texts.get(number),
        )
        for number in range(1, length + 1)
    ]


FUMBLE = "A.Jones up the middle for 2 yards, FUMBLES, RECOVERED by CHI-T.Edmunds"
INTERCEPTION = "J.Love pass deep left INTERCEPTED by CHI-J.Brown at CHI 20"
INCOMPLETE = "J.Love pass incomplete short right to A.Jones"
BROKEN_UP = "J.Love pass incomplete deep left to A.Jones (J.Brown)"


class TestSplittingTheBounces:
    """The second curve: the same game with its coin flips split evenly.

    DESIGN.md 16.7. What these hold onto is that the adjustment is a reading
    of the fit rather than a second model -- so a game with nothing to split
    reads identically both ways, and a game with a bounce in it differs from
    the bounce onward and stays different to the whistle.
    """

    def test_a_game_with_nothing_to_split_reads_the_same_both_ways(self) -> None:
        """Which is most games: a clean game has no fifty-fifty ball in it,
        and the pair of numbers under the chart is then one number twice."""
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, synthetic_game())
        assert curve.points == curve.adjusted
        assert curve.control == curve.adjusted_control
        assert curve.luck is not None
        assert (curve.luck.home, curve.luck.away, curve.luck.swings) == (0.0, 0.0, [])

    def test_a_fumble_moves_the_curve_from_the_bounce_onward(self) -> None:
        """And not before it. Everything up to the fumble happened the same
        way in both games; the adjustment starts where the ball did."""
        fit = fit_for("nfl")
        assert fit is not None
        # The last snap of a drive, so the next snap is the other team's --
        # which is how `find_lucky_plays` reads a fumble as lost.
        curve = curve_for(fit, synthetic_game({4: FUMBLE}))
        realized = [point.home_win_probability for point in curve.points]
        adjusted = [point.home_win_probability for point in curve.adjusted]
        assert realized[:4] == adjusted[:4]
        assert realized[4:] != adjusted[4:]

    def test_the_shift_carries_to_the_whistle(self) -> None:
        """A fumble returned in the first quarter is still on the scoreboard
        in the fourth, so a curve that discounts the recovery has to keep
        discounting it -- the gap doesn't close on its own."""
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, synthetic_game({4: FUMBLE}, length=20))
        assert curve.points[-1].home_win_probability != pytest.approx(
            curve.adjusted[-1].home_win_probability
        )

    def test_the_bounce_is_priced_and_attributed(self) -> None:
        """One swing, both branches, and a total on the side it fell for --
        the home team, since this is a fumble the away team lost to them."""
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, synthetic_game({4: FUMBLE}))
        assert curve.luck is not None
        (swing,) = curve.luck.swings
        assert swing.kind == "fumble_lost"
        assert swing.play_id == "p004"
        assert swing.retained == 0.5
        assert swing.home_delta == pytest.approx(
            0.5 * (swing.realized - swing.counterfactual)
        )
        assert curve.luck.home > 0 and curve.luck.away == 0

    def test_a_fumble_the_offense_kept_is_the_other_side_of_the_coin(self) -> None:
        """Both sides or neither: adjusting the fumbles a team lost without
        the ones it got away with would be a levy on whoever the recorded
        side happened to fall against."""
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, synthetic_game({2: FUMBLE}))
        assert curve.luck is not None
        (swing,) = curve.luck.swings
        assert swing.kind == "fumble_kept"

    def test_an_interception_is_left_alone_where_the_feed_says_nothing(self) -> None:
        """The gate. A feed that doesn't write down its broken-up passes still
        writes down all its interceptions, and charging a defense for the
        picks it made without crediting the balls it got a hand on is the one
        thing this must not do."""
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, synthetic_game({4: INTERCEPTION}))
        assert curve.records_defended_passes is False
        assert curve.luck is not None
        assert curve.luck.swings == []
        assert curve.points == curve.adjusted

    def test_and_is_split_where_the_feed_records_both_sides(self) -> None:
        """Ten incompletions with a defender named on two of them is enough
        of a rate for upstream to trust the pair, so the interception is
        adjusted here and wasn't above -- the same game, differently
        recorded."""
        fit = fit_for("nfl")
        assert fit is not None
        texts = {number: INCOMPLETE for number in range(5, 15)}
        texts[6] = BROKEN_UP
        texts[9] = BROKEN_UP
        texts[4] = INTERCEPTION
        curve = curve_for(fit, synthetic_game(texts, length=20))
        assert curve.records_defended_passes is True
        assert curve.luck is not None
        kinds = {swing.kind for swing in curve.luck.swings}
        assert "pass_defended_interception" in kinds
        assert "pass_defended_incomplete" in kinds


class TestTheGameEndpoint:
    def test_serves_one_game(self, client: TestClient) -> None:
        body = client.get(GAME).json()
        assert body["home"] == "Chicago Bears"
        assert body["away"] == "Green Bay Packers"
        assert (body["home_score"], body["away_score"]) == (10, 14)
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
        """One point per scrimmage snap. The fixture's six drives carry
        sixteen of them; its kickoffs and extra points are the rows
        `iter_states` drops, and the count is what says they were."""
        body = client.get(f"{GAME}/win-probability").json()
        assert len(body["points"]) == 16
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

    def test_every_point_carries_both_numbers(self, client: TestClient) -> None:
        """The realized curve and the adjusted one are the same snaps in the
        same order, so they travel as two numbers on one point rather than as
        two series for the page to line up."""
        points = client.get(f"{GAME}/win-probability").json()["points"]
        assert all(0.0 <= p["adjusted_win_prob"] <= 1.0 for p in points)
        # The fixture's two fumbles are both in the away team's favour on
        # net, so the adjusted curve parts from the realized one and doesn't
        # come back.
        assert points[0]["adjusted_win_prob"] == points[0]["home_win_prob"]
        assert points[-1]["adjusted_win_prob"] != points[-1]["home_win_prob"]

    def test_reports_the_control_both_ways(self, client: TestClient) -> None:
        """What happened, and what happened on purpose -- over the same
        clock, since it is the same game either way."""
        body = client.get(f"{GAME}/win-probability").json()
        control, adjusted = body["control"], body["adjusted_control"]
        assert adjusted["home"] + adjusted["away"] == pytest.approx(1.0)
        assert adjusted["seconds"] == control["seconds"]
        assert adjusted["home"] != control["home"]

    def test_lists_the_plays_the_bounces_turned_on(self, client: TestClient) -> None:
        """Each priced against the branch that didn't happen, so the page can
        show its work rather than asserting a number."""
        luck = client.get(f"{GAME}/win-probability").json()["luck"]
        assert [swing["kind"] for swing in luck["swings"]] == [
            "fumble_lost",
            "fumble_kept",
        ]
        assert luck["away"] > luck["home"] > 0
        for swing in luck["swings"]:
            assert swing["realized"] != swing["counterfactual"]
            assert swing["retained"] == 0.5

    def test_says_whether_the_feed_records_the_defended_passes(
        self, client: TestClient
    ) -> None:
        """The fixture has no incompletions at all, so the pass half of the
        coin is shut here: the fumbles were split and any interception would
        have been left alone. A smaller adjustment, said out loud, rather
        than a fabricated one."""
        body = client.get(f"{GAME}/win-probability").json()
        assert body["records_defended_passes"] is False

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

    def test_a_game_with_no_plays_has_no_bounces_either(
        self, client: TestClient
    ) -> None:
        """Not zero bounces -- none to count. A pair of zeroes on a page
        would read as "nothing went either team's way", which is a thing to
        say about a game that was played."""
        body = client.get("/api/games/nfl/401910102/win-probability").json()
        assert body["adjusted_control"] is None
        assert body["luck"] is None
        assert body["records_defended_passes"] is False

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
