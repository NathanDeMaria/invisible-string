import logging
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app import releases as releases_module
from app.releases import (
    LocalReleaseStore,
    ReleaseNotFound,
    ReleaseStore,
    latest_releases,
    pick_default,
)
from app.schema import ModelRelease

from .conftest import FIXTURES


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


@pytest.fixture
def unwarned() -> Iterator[None]:
    """A clean warning ledger, so these don't depend on each other's order.

    `pick_default` remembers which run_ids it has already complained about --
    see `_skipped` -- and a test asserting the log line would otherwise pass
    or fail depending on whether an earlier one had already used up the
    warning for that run.
    """
    releases_module._skipped.clear()
    yield
    releases_module._skipped.clear()


def _fixture_release(league: str = "mens", model: str = "glicko_tuned") -> ModelRelease:
    return LocalReleaseStore(FIXTURES).get_latest(league, model)


def _from_the_future(release: ModelRelease) -> ModelRelease:
    """The same release, written by a cassandra this build isn't."""
    return release.model_copy(update={"predictor_class": "NeuralPredictor9000"})


@pytest.mark.usefixtures("unwarned")
class TestSkipsWhatThisBuildCannotRun:
    """The 2026-09-05 ncaafb outage, in miniature.

    cassandra publishes a new predictor class, the nightly job rewrites
    `latest.json` before this image is rebuilt against it, and that release
    wins the Brier comparison by a rounding error. Every consumer downstream
    then asks for a predictor that cannot be constructed, and the league loses
    its whole slate -- for a model that was 0.00013 better than one sitting
    right there.
    """

    def test_passes_over_a_class_this_build_lacks(self, store: ReleaseStore) -> None:
        releases = latest_releases(store, "mens")
        assert pick_default(releases).model == "glicko_tuned"

        # The same comparison, with the winner written by a newer cassandra.
        future = [
            _from_the_future(r) if r.model == "glicko_tuned" else r for r in releases
        ]
        assert pick_default(future).model == "elo"

    def test_the_skipped_release_is_still_the_better_one(
        self, store: ReleaseStore
    ) -> None:
        """The point of the trade: what's given up is the Brier gap, and the
        gap is bounded by the fact that the skipped release won on it."""
        releases = latest_releases(store, "mens")
        best, fallback = (
            next(r for r in releases if r.model == "glicko_tuned"),
            next(r for r in releases if r.model == "elo"),
        )
        assert best.metrics.brier_score < fallback.metrics.brier_score

    def test_falls_back_to_the_best_when_none_are_buildable(
        self, store: ReleaseStore
    ) -> None:
        """No downgrade available, so no downgrade is invented.

        `/leagues` and `/ratings` read the artifact's own ratings and do not
        need a predictor at all -- raising here would take a working
        leaderboard down over a model nobody asked it to run.
        """
        future = [_from_the_future(r) for r in latest_releases(store, "mens")]
        assert pick_default(future).model == "glicko_tuned"

    def test_only_the_unbuildable_ones(self, store: ReleaseStore) -> None:
        """Narrow on purpose. A release whose constructor signature has moved
        under it names a class this build *does* have, and is left to the
        layer that can say which params disagreed."""
        releases = latest_releases(store, "mens")
        odd = [
            r.model_copy(update={"params": {"nonsense": 1.0}})
            if r.model == "glicko_tuned"
            else r
            for r in releases
        ]
        assert pick_default(odd).model == "glicko_tuned"

    def test_warns_once_per_release(
        self, store: ReleaseStore, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A league can sit in this state for days, and it is the count that
        made the first outage slow to place. One line, not one per request."""
        future = [
            _from_the_future(r) if r.model == "glicko_tuned" else r
            for r in latest_releases(store, "mens")
        ]
        with caplog.at_level(logging.WARNING, logger="app.releases"):
            for _ in range(3):
                pick_default(future)

        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        assert "NeuralPredictor9000" in warnings[0].getMessage()


class TestListLeagues:
    def test_lists_every_league_with_a_servable_release(
        self, client: TestClient
    ) -> None:
        body = client.get("/api/leagues").json()
        assert [entry["league"] for entry in body] == [
            "mens",
            "ncaafb",
            "wnba",
            "womens",
        ]

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


class TestUnitRatings:
    """The offense and the defense, where a model rates them apart.

    The ncaafb fixture is a compound Glicko: its children are rated on EPA per
    play rather than on the result, so a team carries a pair of Glicko numbers
    under its record. Every other fixture is a model that rates the result
    alone, and those have to come back as nulls rather than as zeroes.
    """

    def test_served_for_a_model_that_rates_units(self, client: TestClient) -> None:
        rows = client.get("/api/leagues/ncaafb/ratings").json()["ratings"]
        georgia = next(r for r in rows if r["team"] == "Georgia")
        assert georgia["offense"] == {"rating": 1861.0, "rd": 74.5}
        assert georgia["defense"] == {"rating": 1923.8, "rd": 69.1}

    def test_null_for_a_model_that_rates_only_the_result(
        self, client: TestClient
    ) -> None:
        rows = client.get("/api/leagues/mens/ratings").json()["ratings"]
        assert all(r["offense"] is None and r["defense"] is None for r in rows)

    def test_null_for_a_team_the_model_has_no_plays_for(
        self, client: TestClient
    ) -> None:
        """Alabama is in the fixture on its record alone.

        A team the play-by-play index never had a game for has earned nothing
        under the parent, and the release carries no units for it. Nulls rather
        than the team's own rating copied into both sides, which would read as
        a measurement.
        """
        rows = client.get("/api/leagues/ncaafb/ratings").json()["ratings"]
        alabama = next(r for r in rows if r["team"] == "Alabama")
        assert alabama["rating"] == 1751.9
        assert alabama["offense"] is None
        assert alabama["defense"] is None

    def test_the_units_are_not_the_rank(self, client: TestClient) -> None:
        """The best offense in the fixture isn't the top of the table.

        Georgia leads on a defense nobody else has and Ohio State has the
        better offense, so a bug that served the team rating under both names
        -- or sorted the units by rank -- fails here rather than looking
        plausible.
        """
        rows = client.get("/api/leagues/ncaafb/ratings").json()["ratings"]
        assert rows[0]["team"] == "Georgia"
        rated = [r for r in rows if r["offense"]]
        best_offense = max(rated, key=lambda r: r["offense"]["rating"])
        best_defense = max(rated, key=lambda r: r["defense"]["rating"])
        assert best_offense["team"] == "Ohio State"
        assert best_defense["team"] == "Georgia"


class TestMovement:
    """The column the ratings page has been missing: what the week did.

    The mens fixture's history holds two weeks, and its second week is the
    release -- which is what a healthy publish writes, since both come out of
    one replay. So every number here is the first week subtracted from the
    table beside it.
    """

    def test_rating_movement_is_the_week_that_just_happened(
        self, client: TestClient
    ) -> None:
        rows = client.get("/api/leagues/mens/ratings").json()["ratings"]
        moved = {row["team"]: row["movement"] for row in rows}
        assert moved["Houston"]["rating"] == pytest.approx(34.2)
        assert moved["North Carolina"]["rating"] == pytest.approx(-10.5)

    def test_places_gained_are_positive(self, client: TestClient) -> None:
        """Houston went third to second. The reader sees "up one", so the sign
        follows the team rather than the rank integer."""
        rows = client.get("/api/leagues/mens/ratings").json()["ratings"]
        moved = {row["team"]: row["movement"] for row in rows}
        assert moved["Houston"]["rank"] == 1
        assert moved["North Carolina"]["rank"] == -1
        assert moved["Duke"]["rank"] == 0

    def test_the_record_the_week_produced(self, client: TestClient) -> None:
        rows = client.get("/api/leagues/mens/ratings").json()["ratings"]
        moved = {row["team"]: row["movement"] for row in rows}
        assert (moved["Duke"]["wins"], moved["Duke"]["losses"]) == (2, 0)
        assert (moved["Kansas"]["wins"], moved["Kansas"]["losses"]) == (1, 1)

    def test_the_page_can_name_the_day_it_compares_against(
        self, client: TestClient
    ) -> None:
        """ "Last week" said as a date, so the column doesn't have to be taken
        on trust -- and so a league that hasn't played in a fortnight says so
        rather than implying a week."""
        body = client.get("/api/leagues/mens/ratings").json()
        assert body["movement_since"]["year"] == 2026
        assert body["movement_since"]["week"] == 1
        assert body["movement_since"]["date"].startswith("2026-07-31")

    def test_a_model_with_no_history_still_serves_its_table(
        self, client: TestClient
    ) -> None:
        """Every model published before the artifact existed. The column is
        absent, the leaderboard isn't."""
        body = client.get("/api/leagues/womens/ratings").json()
        assert body["movement_since"] is None
        assert body["ratings"]
        assert all(row["movement"] is None for row in body["ratings"])

    def test_history_is_per_model_not_per_league(self, client: TestClient) -> None:
        """mens has two models and one of them has a history. Reading the
        wrong one would put glicko's movement beside elo's ratings."""
        body = client.get("/api/leagues/mens/ratings?model=elo").json()
        assert body["movement_since"] is None
        assert all(row["movement"] is None for row in body["ratings"])


class TestTheLocalQuarterbackIndex:
    """The local store reads `models/{league}/qb_out.json` the way the S3
    one does, from the same layout, so a fixture directory and the bucket
    answer the game page identically."""

    def test_reads_the_fixture_index(self, store: ReleaseStore) -> None:
        index = store.get_qb_out("ncaafb")
        assert index.is_out("401752895", "Nebraska Cornhuskers")

    def test_a_league_without_one_is_empty(self, store: ReleaseStore) -> None:
        assert len(store.get_qb_out("mens")) == 0

    def test_a_league_dir_holding_the_index_still_lists_only_models(
        self, store: ReleaseStore
    ) -> None:
        """The file sits beside the model directories; it isn't one."""
        assert "qb_out.json" not in store.list_models("ncaafb")
