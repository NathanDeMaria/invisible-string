"""`/api/predict` -- win probability and predicted spread for a hypothetical.

Two things here are worth more attention than the rest.

The **sign**: the calibration predicts margin of victory and the wire format is
the market's spread, so the boundary negates. A favourite must come back with a
*negative* spread. Getting this backwards produces numbers that look completely
plausible, which is why it's asserted from several directions rather than once.

The **unknown team**: every predictor defaults an unseen team to its base
rating, so without an explicit check a typo returns a confident probability
computed against a 1500-rated ghost. That's the worst failure this endpoint can
have, because nothing about the response looks wrong.
"""

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.releases import LocalReleaseStore, ReleaseStore, get_release_store
from app.schema import ModelRelease

from .conftest import FIXTURES


def _client(store: ReleaseStore) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_release_store] = lambda: store
    return TestClient(app)


class _OneReleaseStore:
    """A store holding a single hand-built release, for the odd shapes the
    golden fixtures don't cover."""

    def __init__(self, release: ModelRelease) -> None:
        self._release = release

    def list_leagues(self) -> list[str]:
        return [self._release.league]

    def list_models(self, league: str) -> list[str]:
        return [self._release.model] if league == self._release.league else []

    def get_latest(self, league: str, model: str) -> ModelRelease:
        return self._release


def _fixture_release(league: str = "mens", model: str = "glicko_tuned"):
    return LocalReleaseStore(FIXTURES).get_latest(league, model)


def predict(client: TestClient, **params: str | int | float) -> httpx.Response:
    return client.get("/api/predict", params=params)


class TestTheHappyPath:
    def test_the_stronger_home_team_is_favoured(self, client: TestClient) -> None:
        body = predict(client, league="mens", home="Duke", away="Kansas").json()
        assert body["home_win_prob"] > 0.5
        assert body["home_rating"] > body["away_rating"]

    def test_probabilities_are_complementary(self, client: TestClient) -> None:
        body = predict(client, league="mens", home="Duke", away="Kansas").json()
        assert body["home_win_prob"] + body["away_win_prob"] == pytest.approx(1.0)

    def test_it_says_which_release_answered(self, client: TestClient) -> None:
        """A spread computed from a different run than the table beside it
        would be a very quiet kind of wrong."""
        body = predict(client, league="mens", home="Duke", away="Kansas").json()
        assert body["model"] == "glicko_tuned"
        assert body["run_id"] == "2026-08-08T09:00:12Z"

    def test_an_explicit_model_is_honoured(self, client: TestClient) -> None:
        body = predict(
            client, league="mens", home="Duke", away="Kansas", model="elo"
        ).json()
        assert body["model"] == "elo"


class TestTheSign:
    """DESIGN.md section 1: negative spread = home favoured."""

    def test_a_favourite_gets_a_negative_spread(self, client: TestClient) -> None:
        body = predict(client, league="mens", home="Duke", away="Kansas").json()
        assert body["home_win_prob"] > 0.5
        assert body["predicted_spread"] < 0, "a favourite must lay points, not get them"

    def test_swapping_the_sides_flips_it(self, client: TestClient) -> None:
        """The same matchup from the other end.

        On a neutral court, because the fixture's home advantage (95) is larger
        than any rating gap in it -- so with home advantage on, the home team is
        favoured in *every* matchup these four teams can play. That's correct
        model behaviour, not a fixture bug, but it means an away favourite only
        exists here at a neutral site.
        """
        duke_home = predict(
            client, league="mens", home="Duke", away="Kansas", neutral="true"
        ).json()
        duke_away = predict(
            client, league="mens", home="Kansas", away="Duke", neutral="true"
        ).json()

        assert duke_home["home_win_prob"] > 0.5
        assert duke_home["predicted_spread"] < 0
        assert duke_away["home_win_prob"] < 0.5
        assert duke_away["predicted_spread"] > 0

    @pytest.mark.parametrize(
        ("home", "away", "neutral", "model"),
        [
            ("Duke", "Kansas", "false", "glicko_tuned"),
            ("Kansas", "Duke", "false", "glicko_tuned"),
            ("Duke", "Kansas", "true", "glicko_tuned"),
            ("Kansas", "Duke", "true", "glicko_tuned"),
            ("North Carolina", "Houston", "false", "glicko_tuned"),
            ("Duke", "Kansas", "false", "elo"),
            ("Kansas", "Duke", "true", "elo"),
        ],
    )
    def test_the_spread_always_opposes_the_probability(
        self, client: TestClient, home: str, away: str, neutral: str, model: str
    ) -> None:
        """The invariant, stated once and checked everywhere.

        Whoever is more likely to win lays the points. Both calibration kinds,
        both venues, both directions -- a sign error anywhere in the chain
        breaks at least one of these rows.
        """
        body = predict(
            client,
            league="mens",
            home=home,
            away=away,
            neutral=neutral,
            model=model,
        ).json()
        favoured = body["home_win_prob"] > 0.5
        assert (body["predicted_spread"] < 0) is favoured, body

    def test_the_logistic_fit_agrees(self, client: TestClient) -> None:
        """The mens/elo fixture stores a logistic calibration rather than
        isotonic knots, so this covers the other arm of the union."""
        body = predict(
            client, league="mens", home="Duke", away="Kansas", model="elo"
        ).json()
        assert body["home_win_prob"] > 0.5
        assert body["predicted_spread"] < 0

    def test_a_bigger_edge_lays_more_points(self, client: TestClient) -> None:
        """Monotonicity, which a constant would satisfy the sign tests without."""
        close = predict(client, league="mens", home="Duke", away="Houston").json()
        lopsided = predict(client, league="mens", home="Duke", away="Kansas").json()
        assert lopsided["predicted_spread"] < close["predicted_spread"]


class TestUnknownTeams:
    def test_a_team_the_model_has_never_seen_is_a_404(self, client: TestClient) -> None:
        response = predict(client, league="mens", home="Duke", away="Belmont")
        assert response.status_code == 404
        assert "Belmont" in response.json()["detail"]

    def test_a_typo_is_a_404_rather_than_a_plausible_number(
        self, client: TestClient
    ) -> None:
        """The failure this endpoint is most likely to hide. A trailing space
        is a different dict key, and the predictor would happily rate the ghost
        at 1500 and return a confident probability."""
        response = predict(client, league="mens", home="Duke ", away="Kansas")
        assert response.status_code == 404

    def test_both_unknown_teams_are_named(self, client: TestClient) -> None:
        detail = predict(client, league="mens", home="Belmont", away="Rice").json()[
            "detail"
        ]
        assert "Belmont" in detail and "Rice" in detail

    def test_a_team_cannot_play_itself(self, client: TestClient) -> None:
        response = predict(client, league="mens", home="Duke", away="Duke")
        assert response.status_code == 422


class TestNeutralSite:
    def test_neutral_lowers_the_home_teams_chances(self, client: TestClient) -> None:
        home = predict(client, league="mens", home="Duke", away="Kansas").json()
        neutral = predict(
            client, league="mens", home="Duke", away="Kansas", neutral="true"
        ).json()
        assert neutral["home_win_prob"] < home["home_win_prob"]

    def test_it_is_echoed_back(self, client: TestClient) -> None:
        body = predict(
            client, league="mens", home="Duke", away="Kansas", neutral="true"
        ).json()
        assert body["neutral"] is True


class TestHomeAdvantageOverride:
    def test_more_home_advantage_helps_the_home_team(self, client: TestClient) -> None:
        base = predict(client, league="mens", home="Duke", away="Kansas").json()
        boosted = predict(
            client,
            league="mens",
            home="Duke",
            away="Kansas",
            home_advantage=400,
        ).json()
        assert boosted["home_win_prob"] > base["home_win_prob"]

    def test_it_does_not_leak_into_the_next_request(self) -> None:
        """Applying the override in place would poison every later caller.

        Deliberately *not* run through the `client` fixture: LocalReleaseStore
        re-reads and re-validates from disk on every call, so there is no
        shared object to corrupt and this test would pass against a version
        that mutates. S3ReleaseStore is the one that caches the parsed release
        in memory, which is where the bug would actually live. `_OneReleaseStore`
        hands back the same instance every time, reproducing that.

        Confirmed to fail when `_with_home_advantage` mutates `release.params`
        instead of returning a copy.
        """
        client = _client(_OneReleaseStore(_fixture_release()))

        before = predict(client, league="mens", home="Duke", away="Kansas").json()
        predict(client, league="mens", home="Duke", away="Kansas", home_advantage=400)
        after = predict(client, league="mens", home="Duke", away="Kansas").json()

        assert after["home_win_prob"] == pytest.approx(before["home_win_prob"])

    def test_422_when_the_model_has_no_such_parameter(self) -> None:
        release = _fixture_release().model_copy(update={"params": {"k": 20.0}})
        response = predict(
            _client(_OneReleaseStore(release)),
            league="mens",
            home="Duke",
            away="Kansas",
            home_advantage=400,
        )
        assert response.status_code == 422
        assert "home_advantage" in response.json()["detail"]


class TestDegradedReleases:
    def test_no_calibration_means_no_spread_rather_than_a_made_up_one(self) -> None:
        release = _fixture_release().model_copy(update={"margin_calibration": None})
        body = predict(
            _client(_OneReleaseStore(release)),
            league="mens",
            home="Duke",
            away="Kansas",
        ).json()
        assert body["predicted_spread"] is None
        # The probability is unaffected -- it doesn't come from the calibration.
        assert body["home_win_prob"] > 0.5

    def test_a_predictor_class_this_build_lacks_is_a_502(self) -> None:
        """The expected outcome for a release written by a newer cassandra.
        Upstream data this build can't read, same as a schema mismatch."""
        release = _fixture_release().model_copy(
            update={"predictor_class": "NeuralPredictor9000"}
        )
        response = predict(
            _client(_OneReleaseStore(release)),
            league="mens",
            home="Duke",
            away="Kansas",
        )
        assert response.status_code == 502

    def test_unknown_league_is_a_404(self, client: TestClient) -> None:
        assert (
            predict(client, league="nfl", home="Duke", away="Kansas").status_code == 404
        )
