"""The games window, and the model's number beside each game.

Like the job fixtures, `fixtures/games/games.json` is re-based to now by
`LocalGamesSource` (DESIGN.md section 13), so these assert *relationships* --
which games fall in the window, which rows carry a prediction -- rather than
dates, which is what keeps them from expiring a week after they were written.
"""

import json
import logging
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.api.games import MatchupUnsupported
from app.artifacts import ArtifactStore, LocalArtifactStore, get_artifact_store
from app.games import (
    MAX_DAYS_AHEAD,
    MAX_DAYS_BACK,
    GamesSource,
    GamesUnavailable,
    GameWindow,
    LocalGamesSource,
    PlayedGame,
    ScheduledGame,
    as_aware,
    game_day,
    get_games_source,
    window_bounds,
)
from app.main import create_app
from app.releases import ReleaseStore, get_release_store, resolve_release

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
    status: str = "",
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
        status=status,
        home_score=home_score,
        away_score=away_score,
    )


class StubGames:
    """A source that answers with whatever the test handed it."""

    def __init__(
        self,
        *games: ScheduledGame,
        schedule: list[PlayedGame] | None = None,
        archive: list[ScheduledGame] | None = None,
    ) -> None:
        self._games = list(games)
        self._schedule = schedule or []
        self._archive = list(archive or [])

    def window(self, days_back: int, days_ahead: int) -> GameWindow:
        since, until = window_bounds(days_back, days_ahead)
        return GameWindow(since=since, until=until, games=self._games)

    def find_in_season(
        self, league: str, game_id: str, season: int
    ) -> ScheduledGame | None:
        """The games only a season file could reach.

        Kept apart from `window`'s on purpose: a real source answers these two
        out of different reads, and a stub that served one list for both
        couldn't tell a test that found a game the cheap way from one that
        needed the fallback.
        """
        for game in self._archive:
            if (
                game.league == league
                and game.game_id == game_id
                and game.season == season
            ):
                return game
        return None

    def season_schedule(self, league: str, season: int) -> list[PlayedGame]:
        """Whatever the test handed it, unfiltered.

        A real source returns one league's one season; a test that passes a
        schedule at all is already asking about one game.
        """
        return self._schedule


class RecordingArtifacts:
    """A real store that remembers which prediction windows it was asked for.

    The bounds are a pruning device, so what they *are* is invisible from the
    rows that come back -- `LocalArtifactStore` ignores them outright and
    returns the whole file. Against S3 they decide which row groups get
    fetched, which is the difference between finding an old game's forecast
    and reading the wrong end of sixteen seasons for nothing.
    """

    def __init__(self, inner: ArtifactStore) -> None:
        self._inner = inner
        self.windows: list[tuple[date, date]] = []

    def history(self, league: str, model: str) -> pd.DataFrame:
        return self._inner.history(league, model)

    def predictions(
        self, league: str, model: str, since: date, until: date
    ) -> pd.DataFrame:
        self.windows.append((since, until))
        return self._inner.predictions(league, model, since, until)

    def team_predictions(self, league: str, model: str, team: str) -> pd.DataFrame:
        return self._inner.team_predictions(league, model, team)


# A model published before the parquet artifacts existed, which is what the
# real class does with a directory that isn't there. The default for a test
# about something else, so those keep exercising the live-prediction path.
NO_ARTIFACTS = LocalArtifactStore(Path("no-such-directory"))


def client_for(
    source: GamesSource,
    store: ReleaseStore,
    artifacts: ArtifactStore = NO_ARTIFACTS,
) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_release_store] = lambda: store
    app.dependency_overrides[get_artifact_store] = lambda: artifacts
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

    def test_a_prediction_carries_the_two_ratings_behind_it(
        self, client: TestClient, store: ReleaseStore
    ) -> None:
        """The numbers the win probability was computed from, joined to the row.

        Not needed to render one -- the ratings endpoint already serves them
        per team -- but a page that wants the night's best matchup first would
        otherwise fetch a whole ratings table per league to find out which
        game that is.
        """
        mens = _by_league(client, "mens")
        predicted = [g for g in mens if g["prediction"]]
        assert predicted

        release = resolve_release(store, "mens", None)
        for row in predicted:
            assert row["prediction"]["home_rating"] == pytest.approx(
                release.ratings[row["home"]].rating
            )
            assert row["prediction"]["away_rating"] == pytest.approx(
                release.ratings[row["away"]].rating
            )

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

    def test_every_row_says_what_state_it_is_in(self, client: TestClient) -> None:
        """`completed` alone can't render a row once the season files carry
        fixtures: a game with no score is on tonight, being played, called off
        or moved, and those are four different things to say."""
        rows = client.get("/api/games").json()["games"]
        assert all("status" in row for row in rows)

    def test_the_status_is_espns_own(self, client: TestClient) -> None:
        # Verbatim rather than mapped onto an enum here: it is a value ESPN
        # sends, so one nobody has seen before should reach the page as an odd
        # string rather than as a category error.
        assert _game(client, "401710106")["status"] == "STATUS_IN_PROGRESS"
        assert _game(client, "401810102")["status"] == "STATUS_POSTPONED"
        assert _game(client, "401810103")["status"] == "STATUS_CANCELED"

    def test_a_game_saved_before_the_flip_has_no_status(
        self, client: TestClient
    ) -> None:
        """Most of `seasons/` still, and all of it final -- but nothing
        recorded that, so the row says nothing rather than claiming it."""
        row = _game(client, "401710102")
        assert row["completed"] is True
        assert row["status"] == ""

    def test_a_game_in_progress_shows_no_score(self, client: TestClient) -> None:
        """A season file is rewritten once a day, so a partial score in it is
        a snapshot from whenever the job ran -- and it renders exactly like a
        final."""
        row = _game(client, "401710106")
        assert (row["home_score"], row["away_score"]) == (None, None)

    def test_caps_the_window(self, client: TestClient) -> None:
        assert client.get("/api/games", params={"back": 30}).status_code == 422
        assert client.get("/api/games", params={"ahead": 30}).status_code == 422

    def test_unreadable_upstream_is_a_502(self, store: ReleaseStore) -> None:
        """Not an empty 200: an offseason and an AccessDenied must not render
        the same, or the page reports a broken bucket as a quiet evening."""

        class Broken:
            def window(self, days_back: int, days_ahead: int) -> GameWindow:
                raise GamesUnavailable("could not read s3: AccessDenied")

            def find_in_season(
                self, league: str, game_id: str, season: int
            ) -> ScheduledGame | None:
                raise GamesUnavailable("could not read s3: AccessDenied")

            def season_schedule(self, league: str, season: int) -> list[PlayedGame]:
                # Unreachable here -- the window throws first -- but a source
                # is the whole protocol or it isn't one.
                raise GamesUnavailable("could not read s3: AccessDenied")

        response = client_for(Broken(), store).get("/api/games")
        assert response.status_code == 502


class TestStoredPredictions:
    """A completed game shows what the model said before it was played.

    Releases are rebuilt nightly, so re-predicting last night's game asks a
    model that has already trained on the result. `predictions.parquet` is
    what makes that unnecessary -- the forecast it made at the time is on
    file -- and the page used to carry a dagger precisely because it wasn't.
    """

    def test_a_completed_game_uses_the_forecast_that_was_made(
        self, client: TestClient
    ) -> None:
        """The fixture's stored row, not a number computed from today's
        ratings. Distinguishable on purpose: a live prediction for
        Duke-North Carolina out of this release is nowhere near 0.62."""
        row = _game(client, "401710101")
        assert row["prediction"]["home_win_prob"] == pytest.approx(0.62)
        # The market's sign, applied to the margin the run's own calibration
        # implied: +5.5 for the home team is a spread of -5.5.
        assert row["prediction"]["predicted_spread"] == pytest.approx(-5.5)

    def test_an_unplayed_game_is_predicted_live(self, client: TestClient) -> None:
        """The other half of the rule. Nothing has trained on tonight's game,
        so the release itself is the honest answer."""
        row = _game(client, "401710105")
        assert row["completed"] is False
        assert row["prediction"] is not None
        # Not a stored row: the fixture has none for this game.
        assert row["prediction"]["run_id"] == "2026-08-08T09:00:12Z"

    def test_a_game_the_release_trained_on_shows_no_number(
        self, store: ReleaseStore, caplog
    ) -> None:
        """The mismatch cassandra's publish order exists to prevent: a release
        that has folded a result in, with no forecast on file for it. There is
        nothing honest left to show, so the row goes without a number rather
        than carrying hindsight dressed as a forecast.

        The mens fixture's watermark is 2026-08-07, so a game dated well
        before it is one the ratings already contain.
        """
        played = game(game_id="old", completed=True, home_score=70, away_score=68)
        played = played.model_copy(
            update={"start": datetime(2026, 8, 1, 19, 0, tzinfo=UTC)}
        )
        with caplog.at_level(logging.WARNING):
            body = client_for(StubGames(played), store).get("/api/games").json()
        assert body["games"][0]["prediction"] is None
        # Said out loud, because the fix is a republish and nothing on the
        # page will say so.
        assert "stored no prediction" in caplog.text

    def test_that_warning_lands_once_per_league(
        self, store: ReleaseStore, caplog
    ) -> None:
        played = [
            game(
                game_id=f"old-{i}", completed=True, home_score=70, away_score=68
            ).model_copy(update={"start": datetime(2026, 8, 1, 19, 0, tzinfo=UTC)})
            for i in range(3)
        ]
        with caplog.at_level(logging.WARNING):
            client_for(StubGames(*played), store).get("/api/games")
        assert caplog.text.count("stored no prediction") == 1

    def test_a_game_after_the_watermark_is_still_a_forecast(
        self, store: ReleaseStore
    ) -> None:
        """Completed, unstored, and *not* trained on -- a game that finished
        after the last publish. Predicting it live is out of sample, so the
        row keeps its number."""
        just_played = game(game_id="new", completed=True, home_score=70, away_score=68)
        body = client_for(StubGames(just_played), store).get("/api/games").json()
        assert body["games"][0]["prediction"] is not None

    def test_a_game_with_no_result_is_never_trained_on(
        self, store: ReleaseStore
    ) -> None:
        """A postponed game sits at its original tip-off, behind a watermark
        that has moved past it. There is no result to have learned from, so
        the number beside it is a forecast whatever the watermark says."""
        moved = game(game_id="postponed", status="STATUS_POSTPONED").model_copy(
            update={"start": datetime(2026, 8, 1, 19, 0, tzinfo=UTC)}
        )
        body = client_for(StubGames(moved), store).get("/api/games").json()
        assert body["games"][0]["prediction"] is not None

    def test_the_same_game_played_would_be(self, store: ReleaseStore) -> None:
        """The other half: the guard is about the result, not about the date,
        so it must not let a trained-on game through as a forecast."""
        played = game(
            game_id="postponed",
            completed=True,
            status="STATUS_FINAL",
            home_score=70,
            away_score=68,
        ).model_copy(update={"start": datetime(2026, 8, 1, 19, 0, tzinfo=UTC)})
        body = client_for(StubGames(played), store).get("/api/games").json()
        assert body["games"][0]["prediction"] is None

    def test_a_model_with_no_artifacts_still_predicts_tonight(
        self, store: ReleaseStore
    ) -> None:
        """A league published before any of this existed keeps its slate: only
        the games the release has trained on lose their number."""
        body = client_for(StubGames(game(game_id="new")), store).get("/api/games")
        assert body.json()["games"][0]["prediction"] is not None

    def test_the_game_page_agrees_with_the_table(self, client: TestClient) -> None:
        """Same rule, same window, same number -- a game page that disagreed
        with the row it was reached from would be worse than no game page."""
        row = _game(client, "401710101")
        detail = client.get("/api/games/mens/401710101").json()
        assert detail["prediction"] == row["prediction"]


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


class Football:
    """The mens fixture release, relabelled a football one and priced.

    Two synthetic parts, both necessary and neither interesting. The league
    name, because `has_matchup_terms` is the gate and only football passes it.
    The two weights, because a term worth 0 cannot move a number, and a test
    that toggled one and asserted nothing changed would pass for the wrong
    reason -- which is the live state of the published fits, and exactly why
    this has to be stated here rather than read off a release.

    Everything else is the real fixture: a real predictor class over real
    ratings, rebuilt through the same `from_ratings` production calls. The
    teams are consequently basketball ones, which costs the test nothing.
    """

    def __init__(self, inner: ReleaseStore, **params: float) -> None:
        self._inner = inner
        self._params = params or {"qb_out_penalty": 40.0, "rest_advantage": 6.0}

    def list_leagues(self) -> list[str]:
        return ["nfl"]

    def list_models(self, league: str) -> list[str]:
        return self._inner.list_models("mens")

    def get_latest(self, league: str, model: str):
        release = self._inner.get_latest("mens", model)
        return release.model_copy(
            update={"league": "nfl", "params": {**release.params, **self._params}}
        )


NOTHING_STATED = {
    "qb_out_home": False,
    "qb_out_away": False,
    "rest_home": False,
    "rest_away": False,
}


class TestTheMatchupTerms:
    """Stating a quarterback or a bye, and reading back what was true."""

    def kickoff(self, store: ReleaseStore, **kwargs) -> TestClient:
        source = StubGames(game(league="nfl", game_id="g1", **kwargs))
        return client_for(source, Football(store))

    def prob(self, client: TestClient, **flags: bool) -> float:
        response = client.get("/api/games/nfl/g1", params=flags)
        assert response.status_code == 200, response.text
        return response.json()["prediction"]["home_win_prob"]

    def test_a_league_without_the_terms_reports_none(self, store: ReleaseStore) -> None:
        """Not four falses: "no such signal" isn't "nobody is out"."""
        source = StubGames(game(game_id="g1"))
        detail = client_for(source, store).get("/api/games/mens/g1").json()

        assert detail["matchup"] is None

    def test_a_fixture_starts_with_nothing_stated(self, store: ReleaseStore) -> None:
        detail = self.kickoff(store).get("/api/games/nfl/g1").json()

        assert detail["matchup"] == NOTHING_STATED

    def test_stating_nothing_predicts_exactly_as_before(
        self, store: ReleaseStore
    ) -> None:
        """The defaults have to be the untouched model, or every page moves."""
        client = self.kickoff(store)

        assert self.prob(client) == self.prob(
            client, qb_out_home=False, rest_away=False
        )

    def test_an_out_away_quarterback_helps_the_home_team(
        self, store: ReleaseStore
    ) -> None:
        client = self.kickoff(store)

        assert self.prob(client, qb_out_away=True) > self.prob(client)

    def test_an_out_home_quarterback_hurts_it(self, store: ReleaseStore) -> None:
        client = self.kickoff(store)

        assert self.prob(client, qb_out_home=True) < self.prob(client)

    def test_two_out_quarterbacks_are_nobody_s_edge(self, store: ReleaseStore) -> None:
        client = self.kickoff(store)

        assert self.prob(client, qb_out_home=True, qb_out_away=True) == pytest.approx(
            self.prob(client)
        )

    def test_a_rested_home_side_is_favored_more(self, store: ReleaseStore) -> None:
        client = self.kickoff(store)

        assert self.prob(client, rest_home=True) > self.prob(client)
        assert self.prob(client, rest_away=True) < self.prob(client)

    def test_the_response_echoes_what_was_applied(self, store: ReleaseStore) -> None:
        """The page renders its toggles from this, so it can't disagree."""
        detail = (
            self.kickoff(store)
            .get("/api/games/nfl/g1", params={"qb_out_away": True, "rest_home": True})
            .json()
        )

        assert detail["matchup"] == {
            **NOTHING_STATED,
            "qb_out_away": True,
            "rest_home": True,
        }

    def played(
        self, store: ReleaseStore, schedule: list[PlayedGame] | None = None
    ) -> TestClient:
        """Yesterday's game, with a season so the schedule is worth asking for."""
        source = StubGames(
            game(
                league="nfl",
                game_id="g1",
                days=-1,
                completed=True,
                home_score=21,
                away_score=17,
                status="STATUS_FINAL",
            ).model_copy(update={"season": 2026}),
            schedule=schedule,
        )
        return client_for(source, Football(store))

    def test_a_played_game_reports_what_was_true(self, store: ReleaseStore) -> None:
        """The whole point of the season schedule: a bye is a week outside the
        widest window this API serves, so reading only the window would answer
        "nobody was rested" for exactly the games where somebody was."""
        kickoff = datetime.now(UTC) - timedelta(days=1)
        detail = (
            self.played(
                store,
                schedule=[
                    PlayedGame(
                        date=kickoff - timedelta(days=14),
                        home="Duke",
                        away="Someone",
                        completed=True,
                    ),
                    PlayedGame(
                        date=kickoff - timedelta(days=7),
                        home="Houston",
                        away="Someone",
                        completed=True,
                    ),
                ],
            )
            .get("/api/games/nfl/g1")
            .json()
        )

        # Duke is home and came off the fortnight; Houston played a week ago.
        assert detail["matchup"] == {
            "qb_out_home": False,
            "qb_out_away": False,
            "rest_home": True,
            "rest_away": False,
        }

    def test_a_played_game_with_no_schedule_cannot_say(
        self, store: ReleaseStore
    ) -> None:
        """Null rather than false: a source that knows nothing about the season
        has not established that nobody was rested."""
        detail = self.played(store).get("/api/games/nfl/g1").json()

        assert detail["matchup"]["rest_home"] is None
        assert detail["matchup"]["rest_away"] is None

    def test_a_played_game_refuses_a_what_if(self, store: ReleaseStore) -> None:
        """It shows the forecast made before it, which no flag can reach."""
        client = self.kickoff(
            store,
            days=-1,
            completed=True,
            home_score=21,
            away_score=17,
            status="STATUS_FINAL",
        )
        response = client.get("/api/games/nfl/g1", params={"qb_out_home": True})

        assert response.status_code == 422
        assert "has been played" in response.json()["detail"]

    def test_a_league_without_the_terms_refuses_one(self, store: ReleaseStore) -> None:
        source = StubGames(game(game_id="g1"))
        response = client_for(source, store).get(
            "/api/games/mens/g1", params={"qb_out_home": True}
        )

        assert response.status_code == 422
        assert "no quarterback or rest term" in response.json()["detail"]

    def test_a_model_that_cannot_be_told_is_a_422(self, store: ReleaseStore) -> None:
        """Not a row quietly losing its number: the request asked for
        something this release's class has no parameter for."""
        client = self.kickoff(store)
        with patch(
            "app.api.games._stated_predictor",
            side_effect=MatchupUnsupported("takes no sources"),
        ):
            response = client.get("/api/games/nfl/g1", params={"qb_out_home": True})

        assert response.status_code == 422
        assert "takes no sources" in response.json()["detail"]


class TestAGameOutsideTheWindow:
    """The horizon is a cost cap on the window, not a retention ceiling.

    A team page lists every game a model has a forecast for -- sixteen seasons
    of them -- and links into this endpoint. A link that only worked for the
    fortnight either side of today would make most of that list dead, so a
    caller that knows the season can name it and get one game out of one
    season file (`app.games.find_game`).

    The fixture keeps two nfl games well outside the widest window this API
    serves, which is what makes them the ones to ask for: no window test can
    see them, and until now neither could this endpoint.
    """

    def test_found_when_the_link_names_its_season(self, client: TestClient) -> None:
        response = client.get("/api/games/nfl/401910099", params={"season": 2026})

        assert response.status_code == 200
        body = response.json()
        assert (body["home"], body["away"]) == ("Chicago Bears", "Detroit Lions")
        assert (body["home_score"], body["away_score"]) == (20, 17)

    def test_404_without_one(self, client: TestClient) -> None:
        """Unchanged for a caller that doesn't know which season it was: there
        is no by-id read to make, and walking every season file in the bucket
        is the cost the horizon exists to refuse."""
        response = client.get("/api/games/nfl/401910099")

        assert response.status_code == 404
        assert "week either side of today" in response.json()["detail"]

    def test_404_for_a_season_it_isnt_in(self, client: TestClient) -> None:
        """And the message names the season that was looked in, rather than
        repeating a horizon this request had already reached past."""
        response = client.get("/api/games/nfl/401910099", params={"season": 2019})

        assert response.status_code == 404
        assert "2019 season" in response.json()["detail"]

    def test_the_window_answers_first(self, store: ReleaseStore) -> None:
        """A game both reads could answer comes back the window's way.

        The window is the fresher of the two -- its games carry the line off
        today's odds pulls, and a season file carries no line at all -- so a
        game page reached from the games table must not lose its spread to a
        copy of the same game out of the archive.
        """
        tonight = game(game_id="g1").model_copy(
            update={"season": 2026, "market_spread": -4.5}
        )
        lineless = tonight.model_copy(update={"market_spread": None})
        client = client_for(StubGames(tonight, archive=[lineless]), store)

        body = client.get("/api/games/mens/g1", params={"season": 2026}).json()
        assert body["market_spread"] == pytest.approx(-4.5)


class TestTheForecastOnAnOldGame:
    """A game found by season still shows what the model said before it.

    `predictions.parquet` is read by date, and an old game's row is nowhere
    near today's. Reading the usual window for it comes back empty -- which
    `_trained_on` reads as a release and a predictions file out of step, logs
    as a mismatch, and renders as a page with no model on it at all. The point
    of reaching an old game page is mostly the forecast on it, so the read
    moves to the game.
    """

    def test_the_stored_forecast_is_served(
        self, store: ReleaseStore, artifacts: ArtifactStore
    ) -> None:
        old = game(game_id="401710101", completed=True).model_copy(
            update={
                "season": 2026,
                "start": datetime(2026, 8, 20, 19, 0, tzinfo=UTC),
                "home": "Duke",
                "away": "North Carolina",
                "home_score": 78,
                "away_score": 71,
            }
        )
        client = client_for(StubGames(archive=[old]), store, artifacts)

        body = client.get("/api/games/mens/401710101", params={"season": 2026}).json()

        assert body["prediction"]["home_win_prob"] == pytest.approx(0.62)
        assert body["prediction"]["predicted_spread"] == pytest.approx(-5.5)

    def test_no_mismatch_is_reported_for_one(
        self, store: ReleaseStore, artifacts: ArtifactStore, caplog
    ) -> None:
        """The warning that says a republish is needed. An old game that finds
        its forecast must not trip it -- a log line crying mismatch on every
        page of last season would bury the ones that mean it."""
        old = game(game_id="401710101", completed=True).model_copy(
            update={
                "season": 2026,
                "start": datetime(2026, 8, 20, 19, 0, tzinfo=UTC),
                "home": "Duke",
                "away": "North Carolina",
                "home_score": 78,
                "away_score": 71,
            }
        )
        client = client_for(StubGames(archive=[old]), store, artifacts)

        with caplog.at_level(logging.WARNING):
            client.get("/api/games/mens/401710101", params={"season": 2026})

        assert "stored no prediction" not in caplog.text

    def test_the_predictions_are_read_at_the_game_not_at_today(
        self, store: ReleaseStore, artifacts: ArtifactStore
    ) -> None:
        """The half a local store cannot show on its own.

        `LocalArtifactStore` returns every row whatever window it is handed,
        so the two tests above would pass even if the endpoint had asked about
        today -- and against S3, where the bounds prune row groups, asking
        about today finds nothing. So this asserts the span requested.
        """
        old = game(game_id="401710101", days=-40, completed=True).model_copy(
            update={"season": 2026, "home_score": 78, "away_score": 71}
        )
        recording = RecordingArtifacts(artifacts)
        client = client_for(StubGames(archive=[old]), store, recording)

        client.get("/api/games/mens/401710101", params={"season": 2026})

        assert recording.windows == [(old.day, old.day)]

    def test_a_game_in_the_window_still_reads_the_whole_window(
        self, store: ReleaseStore, artifacts: ArtifactStore
    ) -> None:
        """The other half: a game near today keeps the widest window, so a
        page reached from the far edge of the games table shows the number the
        table showed."""
        recording = RecordingArtifacts(artifacts)
        client = client_for(StubGames(game(game_id="g1")), store, recording)

        client.get("/api/games/mens/g1")

        assert recording.windows == [window_bounds(MAX_DAYS_BACK, MAX_DAYS_AHEAD)]
