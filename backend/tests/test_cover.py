"""Cover, push and lose at a line, on every surface that shows a line.

The mens `glicko_tuned` fixture carries a margin kernel
(`fixtures/kernel/make_margin_kernel.py` says how it was fit: football-shaped
on purpose, so 3 and 7 carry a visible push) and `elo` beside it doesn't,
which is what a release published before cassandra shipped kernels looks
like.

Every expected number is cassandra's own `p_cover` on the same kernel, so
these tests are about which win probability goes in, which line it is read
at and which side the answer is quoted from -- the three things this app
decides -- rather than about the kernel's arithmetic.
"""

import pytest
from cassandra.predictor import PlayerRatingIndex, QbOutIndex
from cassandra.predictor.distribution import Cover
from fastapi.testclient import TestClient

from app.artifacts import ArtifactStore, get_artifact_store
from app.cover import cover, flipped
from app.main import create_app
from app.releases import LocalReleaseStore, ReleaseStore, get_release_store
from app.schema import ModelRelease

from .conftest import FIXTURES
from .test_games import StubGames, client_for, game


def _kernel():
    kernel = LocalReleaseStore(FIXTURES).get_latest("mens", "glicko_tuned").kernel()
    assert kernel is not None
    return kernel


def _priced(prob: float, spread: float) -> Cover:
    return _kernel().distribution(prob).p_cover(spread)


def _assert_home(prediction: dict, expected: Cover) -> None:
    assert prediction["home_cover_prob"] == pytest.approx(expected.cover)
    assert prediction["away_cover_prob"] == pytest.approx(expected.lose)
    assert prediction["push_prob"] == pytest.approx(expected.push)


def _game(client: TestClient, game_id: str) -> dict:
    return next(
        g for g in client.get("/api/games").json()["games"] if g["game_id"] == game_id
    )


class _NoKernelStore:
    """The real fixtures, as they were before releases carried a kernel."""

    def __init__(self, inner: ReleaseStore) -> None:
        self._inner = inner

    def list_leagues(self) -> list[str]:
        return self._inner.list_leagues()

    def list_models(self, league: str) -> list[str]:
        return self._inner.list_models(league)

    def get_qb_out(self, league: str) -> QbOutIndex:
        return self._inner.get_qb_out(league)

    def get_player_ratings(self, league: str) -> PlayerRatingIndex:
        return PlayerRatingIndex()

    def get_latest(self, league: str, model: str) -> ModelRelease:
        release = self._inner.get_latest(league, model)
        return release.model_copy(update={"margin_kernel": None})


class TestCover:
    def test_none_without_a_line_or_a_kernel(self) -> None:
        assert cover(None, 0.6, -3.5) is None
        assert cover(_kernel(), 0.6, None) is None

    def test_the_three_add_to_one(self) -> None:
        priced = cover(_kernel(), 0.6, -3.0)
        assert priced is not None
        assert sum(priced) == pytest.approx(1.0)

    def test_flipping_swaps_cover_and_lose_and_keeps_push(self) -> None:
        home = Cover(cover=0.4, push=0.1, lose=0.5)
        assert flipped(home) == Cover(cover=0.5, push=0.1, lose=0.4)

    def test_a_whole_number_on_a_key_number_has_a_push(self) -> None:
        """The case the kernel exists for: a model at -7 against a book at -7
        isn't a coin flip, because a share of games land exactly on it."""
        priced = cover(_kernel(), 0.7, -7.0)
        assert priced is not None
        assert priced.push > 0.05


class TestGamesTable:
    def test_a_stored_row_uses_the_stored_win_probability(
        self, client: TestClient
    ) -> None:
        """Duke-North Carolina is a completed game with a stored 0.62. The
        cover numbers go through that, not through a live prediction from a
        release that has since trained on the result -- which, for this
        fixture, is nowhere near 0.62."""
        row = _game(client, "401710101")
        assert row["prediction"]["home_win_prob"] == pytest.approx(0.62)
        _assert_home(row["prediction"], _priced(0.62, row["market_spread"]))

        live = client.get(
            "/api/predict",
            params={"league": "mens", "home": "Duke", "away": "North Carolina"},
        ).json()["home_win_prob"]
        assert abs(live - 0.62) > 0.05
        assert row["prediction"]["home_cover_prob"] != pytest.approx(
            _priced(live, row["market_spread"]).cover
        )

    def test_a_live_row_uses_the_win_probability_it_shows(
        self, client: TestClient
    ) -> None:
        row = _game(client, "401710105")
        assert row["completed"] is False
        prob = row["prediction"]["home_win_prob"]
        _assert_home(row["prediction"], _priced(prob, row["market_spread"]))

    def test_a_half_point_line_has_no_push(self, client: TestClient) -> None:
        row = _game(client, "401710101")
        assert row["market_spread"] == -4.5
        assert row["prediction"]["push_prob"] == 0.0
        assert row["prediction"]["home_cover_prob"] + row["prediction"][
            "away_cover_prob"
        ] == pytest.approx(1.0)

    def test_the_line_is_read_from_the_home_side(self, store: ReleaseStore) -> None:
        """Negative means home is favoured, so the same matchup is far likelier
        to cover getting ten than laying ten."""
        getting = game(game_id="getting").model_copy(update={"market_spread": 10.0})
        laying = game(game_id="laying").model_copy(update={"market_spread": -10.0})
        body = client_for(StubGames(getting, laying), store).get("/api/games").json()
        by_id = {g["game_id"]: g["prediction"] for g in body["games"]}
        assert by_id["getting"]["home_cover_prob"] > 0.5
        assert by_id["laying"]["away_cover_prob"] > 0.5
        assert by_id["getting"]["home_cover_prob"] > by_id["laying"]["home_cover_prob"]

    def test_a_whole_number_line_carries_its_push(self, store: ReleaseStore) -> None:
        on_seven = game().model_copy(update={"market_spread": -7.0})
        body = client_for(StubGames(on_seven), store).get("/api/games").json()
        prediction = body["games"][0]["prediction"]
        assert prediction["push_prob"] > 0.05
        assert sum(
            prediction[k] for k in ("home_cover_prob", "away_cover_prob", "push_prob")
        ) == pytest.approx(1.0)

    def test_no_line_is_no_cover(self, store: ReleaseStore) -> None:
        body = client_for(StubGames(game()), store).get("/api/games").json()
        prediction = body["games"][0]["prediction"]
        assert prediction is not None
        assert prediction["home_cover_prob"] is None
        assert prediction["away_cover_prob"] is None
        assert prediction["push_prob"] is None

    def test_a_release_without_a_kernel_has_no_cover(self, store: ReleaseStore) -> None:
        """A release from before cassandra shipped kernels still predicts; it
        just can't price a line."""
        lined = game().model_copy(update={"market_spread": -3.5})
        body = (
            client_for(StubGames(lined), _NoKernelStore(store)).get("/api/games").json()
        )
        prediction = body["games"][0]["prediction"]
        assert prediction["home_win_prob"] is not None
        assert prediction["home_cover_prob"] is None
        assert prediction["away_cover_prob"] is None
        assert prediction["push_prob"] is None


class TestTeamGames:
    def _row(self, client: TestClient, team: str, game_id: str) -> dict:
        rows = client.get(f"/api/leagues/mens/teams/{team}/games").json()["games"]
        return next(r for r in rows if r["game_id"] == game_id)

    def test_a_home_row_is_the_home_side(self, client: TestClient) -> None:
        row = self._row(client, "Duke", "401710101")
        assert row["home"] is True
        expected = _priced(0.62, -4.5)
        assert row["cover_prob"] == pytest.approx(expected.cover)
        assert row["opponent_cover_prob"] == pytest.approx(expected.lose)
        assert row["push_prob"] == pytest.approx(expected.push)

    def test_an_away_row_is_turned_around(self, client: TestClient) -> None:
        """Houston were 0.55 at home laying 1.5. Duke's row is that game's
        away side: Duke covers when Houston doesn't."""
        row = self._row(client, "Duke", "401710103")
        assert row["home"] is False
        expected = _priced(0.55, -1.5)
        assert row["cover_prob"] == pytest.approx(expected.lose)
        assert row["opponent_cover_prob"] == pytest.approx(expected.cover)
        assert row["push_prob"] == pytest.approx(expected.push)

    def test_the_two_sides_of_one_game_agree(self, client: TestClient) -> None:
        duke = self._row(client, "Duke", "401710103")
        houston = self._row(client, "Houston", "401710103")
        assert duke["cover_prob"] == pytest.approx(houston["opponent_cover_prob"])
        assert duke["opponent_cover_prob"] == pytest.approx(houston["cover_prob"])
        assert duke["push_prob"] == pytest.approx(houston["push_prob"])

    def test_a_release_without_a_kernel_has_no_cover(
        self, store: ReleaseStore, artifacts: ArtifactStore
    ) -> None:
        app = create_app()
        app.dependency_overrides[get_release_store] = lambda: _NoKernelStore(store)
        app.dependency_overrides[get_artifact_store] = lambda: artifacts
        row = self._row(TestClient(app), "Duke", "401710101")
        assert row["win_prob"] == 0.62
        assert row["cover_prob"] is None
        assert row["opponent_cover_prob"] is None
        assert row["push_prob"] is None


class TestPredict:
    PARAMS = {"league": "mens", "home": "Duke", "away": "Houston"}

    def test_a_stated_spread_is_priced(self, client: TestClient) -> None:
        body = client.get("/api/predict", params={**self.PARAMS, "spread": -7}).json()
        _assert_home(body, _priced(body["home_win_prob"], -7.0))
        assert body["push_prob"] > 0

    def test_a_half_point_has_no_push(self, client: TestClient) -> None:
        body = client.get("/api/predict", params={**self.PARAMS, "spread": 3.5}).json()
        assert body["push_prob"] == 0.0
        _assert_home(body, _priced(body["home_win_prob"], 3.5))

    def test_no_spread_prices_nothing(self, client: TestClient) -> None:
        body = client.get("/api/predict", params=self.PARAMS).json()
        assert body["home_cover_prob"] is None
        assert body["away_cover_prob"] is None
        assert body["push_prob"] is None

    def test_a_model_without_a_kernel_prices_nothing(self, client: TestClient) -> None:
        body = client.get(
            "/api/predict", params={**self.PARAMS, "model": "elo", "spread": -7}
        ).json()
        assert body["home_win_prob"] is not None
        assert body["home_cover_prob"] is None
        assert body["push_prob"] is None
