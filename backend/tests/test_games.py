"""The games window, and the model's number beside each game.

Like the job fixtures, `fixtures/games/games.json` is re-based to now by
`LocalGamesSource` (DESIGN.md section 13), so these assert *relationships* --
which games fall in the window, which rows carry a prediction -- rather than
dates, which is what keeps them from expiring a week after they were written.
"""

import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.games import (
    GamesSource,
    GamesUnavailable,
    GameWindow,
    LocalGamesSource,
    ScheduledGame,
    as_aware,
    game_day,
    get_games_source,
    window_bounds,
)
from app.main import create_app
from app.releases import ReleaseStore, get_release_store

from .conftest import FIXTURES

NOON_UTC = datetime(2026, 8, 22, 17, 0, tzinfo=UTC)


def game(
    league: str = "mens",
    *,
    game_id: str = "g1",
    days: int = 0,
    hour: int = 19,
    home: str = "Duke",
    away: str = "Houston",
    completed: bool = False,
    home_score: int | None = None,
    away_score: int | None = None,
) -> ScheduledGame:
    start = datetime.now(UTC) + timedelta(days=days)
    return ScheduledGame(
        league=league,
        game_id=game_id,
        start=start.replace(hour=hour, minute=0, second=0, microsecond=0),
        home=home,
        away=away,
        neutral=False,
        completed=completed,
        home_score=home_score,
        away_score=away_score,
    )


class StubGames:
    """A source that answers with whatever the test handed it."""

    def __init__(self, *games: ScheduledGame) -> None:
        self._games = list(games)

    def window(self, days_back: int, days_ahead: int) -> GameWindow:
        since, until = window_bounds(days_back, days_ahead)
        return GameWindow(since=since, until=until, games=self._games)


def client_for(source: GamesSource, store: ReleaseStore) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_release_store] = lambda: store
    app.dependency_overrides[get_games_source] = lambda: source
    return TestClient(app)


class TestWindow:
    def test_counts_days_in_the_zone_the_jobs_think_in(self) -> None:
        # 17:00 UTC is midday in Chicago, so both bounds are that same day
        # regardless of which side of the date line UTC is on.
        since, until = window_bounds(2, 1, now=NOON_UTC)
        assert (since.isoformat(), until.isoformat()) == ("2026-08-20", "2026-08-23")

    def test_late_evening_still_belongs_to_today(self) -> None:
        """The boundary the whole page turns on.

        A 04:00 UTC read is 23:00 the previous day in Chicago. Counting the
        window in UTC would have rolled the page over to tomorrow while the
        night's games were still being played.
        """
        _, until = window_bounds(0, 0, now=datetime(2026, 8, 23, 4, 0, tzinfo=UTC))
        assert until.isoformat() == "2026-08-22"

    def test_zero_ahead_is_today(self) -> None:
        since, until = window_bounds(0, 0, now=NOON_UTC)
        assert since == until


class TestGameDay:
    def test_naive_dates_are_read_at_face_value(self) -> None:
        """A season file can carry a naive date; it must not move.

        Reading it as UTC would convert a 20:00 tip into the next morning,
        which is exactly the day boundary this page is about.
        """
        assert game_day(datetime(2026, 8, 22, 20, 0)).isoformat() == "2026-08-22"
        assert as_aware(datetime(2026, 8, 22, 20, 0)).utcoffset() is not None

    def test_aware_dates_are_converted(self) -> None:
        # 02:00 UTC on the 23rd is the evening of the 22nd in Chicago.
        assert (
            game_day(datetime(2026, 8, 23, 2, 0, tzinfo=UTC)).isoformat()
            == "2026-08-22"
        )


class TestLocalSource:
    def test_rebases_the_fixture_onto_today(self, games_source: GamesSource) -> None:
        window = games_source.window(2, 1)
        days = {g.day for g in window.games}
        assert max(days) == window.until
        assert min(days) == window.since

    def test_unplayed_games_stay_in_the_future(self, games_source: GamesSource) -> None:
        """The anchor is the newest *completed* game, not the newest game.

        Anchoring on the latest game of all would drag tomorrow's slate back
        onto today and leave the page with nothing scheduled -- which is the
        half of it that isn't a box score.
        """
        window = games_source.window(2, 1)
        today = window.until - timedelta(days=1)
        assert any(not g.completed and g.day > today for g in window.games)
        assert all(g.day <= today for g in window.games if g.completed)

    def test_window_is_a_real_filter(self, games_source: GamesSource) -> None:
        wide = games_source.window(2, 1)
        narrow = games_source.window(0, 0)
        assert {g.game_id for g in narrow.games} <= {g.game_id for g in wide.games}
        assert len(narrow.games) < len(wide.games)

    def test_a_missing_file_is_an_empty_window(self, tmp_path: Path) -> None:
        # Not an error: a checkout that hasn't seeded fixtures should show a
        # page with no games, which is what an offseason looks like too.
        assert LocalGamesSource(tmp_path).window(2, 1).games == []

    def test_unreadable_data_is_not_an_empty_window(self, tmp_path: Path) -> None:
        (tmp_path / "games").mkdir()
        (tmp_path / "games" / "games.json").write_text("{oops")
        with pytest.raises(GamesUnavailable):
            LocalGamesSource(tmp_path).window(2, 1)

    def test_the_fixture_matches_the_schema(self) -> None:
        """Guards every test above: a fixture key nobody validates is a lie."""
        raw = json.loads((FIXTURES / "games" / "games.json").read_text())
        assert [ScheduledGame.model_validate(g) for g in raw["games"]]


class TestGamesEndpoint:
    def test_serves_the_window(self, client: TestClient) -> None:
        body = client.get("/api/games").json()
        assert body["days_back"] == 2
        assert body["days_ahead"] == 1
        assert body["games"]

    def test_games_are_chronological(self, client: TestClient) -> None:
        starts = [g["start"] for g in client.get("/api/games").json()["games"]]
        assert starts == sorted(starts)

    def test_predicts_from_the_leagues_default_model(self, client: TestClient) -> None:
        """Lowest Brier, the same rule the leaderboard defaults to.

        The mens fixtures make elo the *worse* model on Brier and the better
        one on ATS accuracy, so a page that picked either the max or the
        betting metric would say `elo` here.
        """
        mens = _by_league(client, "mens")
        predicted = [g["prediction"] for g in mens if g["prediction"]]
        assert predicted
        assert {p["model"] for p in predicted} == {"glicko_tuned"}

    def test_a_league_with_no_release_still_shows_its_games(
        self, client: TestClient
    ) -> None:
        # endgame scrapes leagues this app has no model for; the score and the
        # line are still worth the row.
        nfl = _by_league(client, "nfl")
        assert nfl
        assert all(g["prediction"] is None for g in nfl)
        assert any(g["market_spread"] is not None for g in nfl)

    def test_no_prediction_for_a_team_the_release_never_rated(
        self, client: TestClient
    ) -> None:
        """The guard `/api/predict` makes a 404 of.

        Every predictor defaults an unseen team to its base rating, so without
        this the row would carry a confident number computed against a ghost.
        """
        row = _game(client, "401710106")
        assert row["away"] == "Vermont"
        assert row["prediction"] is None

    def test_spreads_are_quoted_from_the_home_side(self, client: TestClient) -> None:
        """Both numbers in the row use the market's sign, or they can't be read
        side by side: negative means the home team is favoured."""
        row = _game(client, "401710101")
        assert row["home"] == "Duke"
        assert row["prediction"]["home_win_prob"] > 0.5
        assert row["prediction"]["predicted_spread"] < 0
        assert row["market_spread"] < 0

    def test_unplayed_games_have_no_score(self, client: TestClient) -> None:
        # The season file stores 0-0 for a game that hasn't happened; passing
        # that through would render tonight's schedule as scoreless finals.
        for row in client.get("/api/games").json()["games"]:
            if not row["completed"]:
                assert row["home_score"] is None and row["away_score"] is None

    def test_finished_games_carry_their_score(self, client: TestClient) -> None:
        row = _game(client, "401710101")
        assert (row["home_score"], row["away_score"]) == (78, 71)

    def test_caps_the_window(self, client: TestClient) -> None:
        assert client.get("/api/games", params={"back": 30}).status_code == 422
        assert client.get("/api/games", params={"ahead": 30}).status_code == 422

    def test_unreadable_upstream_is_a_502(self, store: ReleaseStore) -> None:
        """Not an empty 200: an offseason and an AccessDenied must not render
        the same, or the page reports a broken bucket as a quiet evening."""

        class Broken:
            def window(self, days_back: int, days_ahead: int) -> GameWindow:
                raise GamesUnavailable("could not read s3: AccessDenied")

        response = client_for(Broken(), store).get("/api/games")
        assert response.status_code == 502


class TestInSample:
    """Releases are rebuilt nightly, so last night's result is usually already
    in the ratings that "predicted" it. The flag is what keeps the page from
    calling that a forecast."""

    def test_a_game_the_release_trained_on_is_flagged(
        self, store: ReleaseStore
    ) -> None:
        # The mens fixture's watermark is 2026-08-07, so a game dated well
        # before it is one the ratings already contain.
        played = game(game_id="old", completed=True, home_score=70, away_score=68)
        played = played.model_copy(
            update={"start": datetime(2026, 8, 1, 19, 0, tzinfo=UTC)}
        )
        body = client_for(StubGames(played), store).get("/api/games").json()
        assert body["games"][0]["prediction"]["in_sample"] is True

    def test_a_game_after_the_watermark_is_not(self, store: ReleaseStore) -> None:
        upcoming = game(game_id="new")
        body = client_for(StubGames(upcoming), store).get("/api/games").json()
        assert body["games"][0]["prediction"]["in_sample"] is False


def _by_league(client: TestClient, league: str) -> list[dict]:
    return [
        g for g in client.get("/api/games").json()["games"] if g["league"] == league
    ]


def _game(client: TestClient, game_id: str) -> dict:
    return next(
        g for g in client.get("/api/games").json()["games"] if g["game_id"] == game_id
    )


class TestARelaseThisBuildCantRebuild:
    """The bug that 500'd the live page.

    A release's `params` are free-form by design, so one tuned against a newer
    cassandra arrives carrying a knob this build's constructor has never heard
    of -- production's was `season_regression` on `GlickoPredictor` -- and
    `from_ratings` raises a bare `TypeError` out of `cls(league, **params)`.
    `_build` caught three specific errors and not that one, so one league's
    drifted artifact took down every league's games with it.

    The knob below is deliberately synthetic rather than `season_regression`:
    bumping the pin to a cassandra that *accepts* that parameter turned these
    green, which is the right outcome for production and the wrong one for a
    regression test. What is being tested is "a parameter this build's
    constructor won't take", and only a name no cassandra will ever add keeps
    testing it.
    """

    def test_the_window_survives(self, store: ReleaseStore, caplog) -> None:
        source = StubGames(
            game(game_id="mens-1", home="Duke", away="Houston"),
            game(league="nfl", game_id="nfl-1", home="Bears", away="Packers"),
        )
        with caplog.at_level(logging.WARNING):
            response = client_for(source, Drifted(store)).get("/api/games")

        assert response.status_code == 200
        body = response.json()
        # Every row survives, including the league that never had a model.
        assert [g["game_id"] for g in body["games"]] == ["mens-1", "nfl-1"]
        assert all(g["prediction"] is None for g in body["games"])

    def test_it_names_the_class_and_the_params(
        self, store: ReleaseStore, caplog
    ) -> None:
        """The log line is the fix for the next one of these.

        Placing this took a round trip through production logs precisely
        because nothing said which league, which class, or which knobs.
        """
        with caplog.at_level(logging.WARNING):
            client_for(StubGames(game(game_id="g")), Drifted(store)).get("/api/games")

        assert "mens" in caplog.text
        assert "GlickoPredictor" in caplog.text
        assert "a_knob_from_the_future" in caplog.text

    def test_predict_answers_502_rather_than_500(self, store: ReleaseStore) -> None:
        """/api/predict has had this hole since it shipped.

        It never surfaced because the matchup page only asks about the league
        you are looking at; /api/games builds a predictor for every league at
        once, which is what found it. 502 for the reason an unknown predictor
        class is one: the artifact is there and it is the upstream data this
        build can't use.
        """
        app = create_app()
        app.dependency_overrides[get_release_store] = lambda: Drifted(store)
        response = TestClient(app).get(
            "/api/predict", params={"league": "mens", "home": "Duke", "away": "Houston"}
        )

        assert response.status_code == 502
        assert "GlickoPredictor" in response.json()["detail"]


class Drifted:
    """A store whose releases carry a param this build's constructor rejects.

    Wraps the real fixtures rather than hand-rolling a release, so the failure
    is cassandra's own `TypeError` out of `cls(league, **params)` -- the same
    call, raising the same way, as the one in production.

    The parameter is synthetic on purpose; see the test class above.
    """

    def __init__(self, inner: ReleaseStore) -> None:
        self._inner = inner

    def list_leagues(self) -> list[str]:
        return self._inner.list_leagues()

    def list_models(self, league: str) -> list[str]:
        return self._inner.list_models(league)

    def get_latest(self, league: str, model: str):
        release = self._inner.get_latest(league, model)
        return release.model_copy(
            update={"params": {**release.params, "a_knob_from_the_future": 0.25}}
        )


class TestAPredictorThatThrowsMidWindow:
    """Rebuilding can succeed and predicting still fail.

    Rarer than the above, and guarded the same way: cassandra's code over a
    release this build didn't write has no useful list of exception types.
    """

    def test_one_bad_matchup_costs_one_row(self, store: ReleaseStore, caplog) -> None:
        source = StubGames(game(game_id="g", home="Duke", away="Houston"))
        with (
            patch(
                "app.api.games.predict_matchup",
                side_effect=RuntimeError("ratings moved under the predictor"),
            ),
            caplog.at_level(logging.WARNING),
        ):
            response = client_for(source, store).get("/api/games")

        assert response.status_code == 200
        assert response.json()["games"][0]["prediction"] is None
        assert "predictor failed for mens" in caplog.text

    def test_it_logs_once_per_league(self, store: ReleaseStore, caplog) -> None:
        source = StubGames(
            *(game(game_id=f"g{i}", home="Duke", away="Houston") for i in range(5))
        )
        with (
            patch("app.api.games.predict_matchup", side_effect=RuntimeError("boom")),
            caplog.at_level(logging.WARNING),
        ):
            client_for(source, store).get("/api/games")

        # A busy night is hundreds of games; one traceback each is a log
        # nobody reads.
        assert caplog.text.count("predictor failed for mens") == 1
