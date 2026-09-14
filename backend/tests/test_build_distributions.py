"""Building the metric shapes the game page reads.

The generator's job is to turn a decade of play-by-play into 101 numbers per
metric, and almost everything that could go wrong with it is silent: a
percentile off a wrong population, or off a sample too small to mean anything,
still renders as a confident ordinal beside a number. So these test the two
halves separately -- the arithmetic, against samples whose answer is known,
and the walk, against the one game the fixtures carry.
"""

import json
import logging
from pathlib import Path
from typing import Any

import pytest

from app.build_distributions import (
    METRICS,
    MIN_SAMPLES,
    AwsWeeks,
    LocalWeeks,
    build,
    by_game,
    checkpoints,
    collect,
    main,
    observe,
    recent_seasons,
    write,
)
from app.distributions import CHECKPOINTS, LocalDistributionStore
from app.win_probability import EMPTY, curve_for, fit_for

from .conftest import FIXTURES


class TestCheckpoints:
    def test_a_value_at_each_percentile(self) -> None:
        assert len(checkpoints([float(i) for i in range(1000)])) == CHECKPOINTS

    def test_the_ends_are_the_extremes(self) -> None:
        """p0 and p100 are the widest values actually seen, which is what the
        page clamps against."""
        values = checkpoints([float(i) for i in range(101)])
        assert values[0] == 0.0
        assert values[-1] == 100.0

    def test_a_uniform_sample_comes_back_linear(self) -> None:
        """The property the page's lookup depends on: a value that went in at
        the kth percentile reads back out at the kth. Uniform is the sample
        where that is checkable by eye."""
        values = checkpoints([i / 1000 for i in range(1001)])
        for percentile in (10, 25, 50, 75, 90):
            assert values[percentile] == pytest.approx(percentile / 100, abs=0.005)

    def test_never_decreases(self) -> None:
        """What `MetricDistribution` refuses on the way in, produced correctly
        here rather than caught there."""
        values = checkpoints([3.0, -1.0, 7.5, 0.0, 2.2, -4.0, 1.1])
        assert values == sorted(values)

    def test_a_sample_with_no_spread_is_still_valid(self) -> None:
        """Every game scoring the same is a legitimate artifact, not a
        degenerate one -- the page reads a run of ties as its middle."""
        values = checkpoints([0.5] * 400)
        assert set(values) == {0.5}


class TestBuild:
    def sample(self, n: int = 500) -> list[float]:
        return [i / n for i in range(n)]

    def test_validates_on_the_way_out(self) -> None:
        """Through the reader's own model, so a build that produced something
        unservable fails where the person who ran it is watching."""
        artifact = build("nfl", [2024, 2025], {"epa_per_play": self.sample()})

        assert artifact.league == "nfl"
        assert artifact.seasons == [2024, 2025]
        assert len(artifact.metrics["epa_per_play"].values) == CHECKPOINTS

    def test_counts_and_names_the_population(self) -> None:
        artifact = build("nfl", [2025], {"epa_per_play": self.sample(400)})
        metric = artifact.metrics["epa_per_play"]

        assert metric.n == 400
        assert metric.unit == "team-game"

    def test_leaves_out_a_metric_below_the_floor(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A hundred checkpoints off thirty games is a hundred numbers that
        look authoritative and are noise. Left out entirely rather than
        carried with a small `n`: the reader can't weigh that and the page has
        nowhere to say it."""
        with caplog.at_level(logging.WARNING):
            artifact = build(
                "nfl",
                [2025],
                {"epa_per_play": self.sample(500), "game_control": [0.5] * 12},
            )

        assert set(artifact.metrics) == {"epa_per_play"}
        assert "below the" in caplog.text

    def test_the_floor_is_adjustable(self) -> None:
        artifact = build("nfl", [2025], {"game_control": [0.5] * 12}, min_samples=10)
        assert set(artifact.metrics) == {"game_control"}

    def test_an_empty_sample_produces_no_metric(self) -> None:
        assert build("nfl", [2025], {"epa_per_play": []}).metrics == {}


class TestSplittingAWeek:
    def test_groups_plays_by_the_game_they_belong_to(self) -> None:
        plays = LocalWeeks(FIXTURES).plays("nfl", 2026, 3)
        assert by_game(plays).keys() == {"401910101"}

    def test_orders_each_game_the_way_the_fit_reads_it(self) -> None:
        """A game walked out of order scores a game that never happened, and
        the bucket's objects are sorted by game id rather than by clock."""
        plays = list(LocalWeeks(FIXTURES).plays("nfl", 2026, 3))
        shuffled = list(reversed(plays))

        ordered = by_game(shuffled)["401910101"]
        assert [play.play_number for play in ordered] == sorted(
            play.play_number for play in plays
        )


class TestObserving:
    def test_counts_both_sides_of_a_game(self) -> None:
        """One game is two observations of every metric, because that is what
        these metrics are *of* -- an offense's EPA, a side's share."""
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, LocalWeeks(FIXTURES).plays("nfl", 2026, 3))

        samples: dict[str, list[float]] = {name: [] for name in METRICS}
        observe(curve, samples)

        assert len(samples["epa_per_play"]) == 2
        assert len(samples["game_control"]) == 2

    def test_a_game_with_nothing_to_score_adds_nothing(self) -> None:
        """Not a pair of zeroes: an offense that never had the ball did not
        average zero, and folding the two together pulls every percentile
        toward the middle."""
        samples: dict[str, list[float]] = {name: [] for name in METRICS}
        observe(EMPTY, samples)

        assert samples == {name: [] for name in METRICS}

    def test_the_two_control_shares_are_a_game(self) -> None:
        fit = fit_for("nfl")
        assert fit is not None
        curve = curve_for(fit, LocalWeeks(FIXTURES).plays("nfl", 2026, 3))

        samples: dict[str, list[float]] = {name: [] for name in METRICS}
        observe(curve, samples)

        assert sum(samples["game_control"]) == pytest.approx(1.0)


class TestTheLocalTree:
    def test_finds_the_seasons_and_weeks_on_disk(self) -> None:
        source = LocalWeeks(FIXTURES)
        assert source.seasons("nfl") == [2026]
        assert source.weeks("nfl", 2026) == [3]

    def test_a_league_with_no_plays_is_empty(self) -> None:
        assert LocalWeeks(FIXTURES).seasons("mens") == []

    def test_reads_every_game_in_a_week(self) -> None:
        assert len(LocalWeeks(FIXTURES).plays("nfl", 2026, 3)) > 0


class TestTheSeasonWindow:
    class Seasons:
        def __init__(self, years: list[int]) -> None:
            self._years = years

        def seasons(self, league: str) -> list[int]:
            return self._years

    def test_takes_the_newest_it_has(self) -> None:
        source = self.Seasons([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025])
        assert recent_seasons(source, "nfl", 5) == [2021, 2022, 2023, 2024, 2025]  # ty: ignore[invalid-argument-type]

    def test_takes_what_there_is_when_there_are_fewer(self) -> None:
        """Off the partitions rather than the calendar, so a rebuild in
        January reaches back five *processed* seasons."""
        source = self.Seasons([2024, 2025])
        assert recent_seasons(source, "nfl", 5) == [2024, 2025]  # ty: ignore[invalid-argument-type]


class TestCollecting:
    def test_scores_the_games_it_walks(self) -> None:
        samples = collect(LocalWeeks(FIXTURES), "nfl", [2026])

        # One game in the fixture tree, two sides of it.
        assert len(samples["epa_per_play"]) == 2
        assert len(samples["game_control"]) == 2

    def test_a_league_with_no_fit_is_refused(self) -> None:
        """Not an empty artifact: basketball has none of these metrics and
        never will, so a build for it is a mistake worth naming."""
        with pytest.raises(LookupError, match="no win probability fit"):
            collect(LocalWeeks(FIXTURES), "mens", [2026])

    def test_an_unreadable_week_costs_that_week_and_no_more(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The rule every reader of a foreign object here follows. A
        five-season walk must not be abandoned over one bad object."""
        week = tmp_path / "plays" / "nfl" / "2026" / "3"
        week.mkdir(parents=True)
        (week / "broken.json").write_text("{oops")
        good = tmp_path / "plays" / "nfl" / "2026" / "4"
        good.mkdir(parents=True)
        (good / "401910101.json").write_text(
            (FIXTURES / "plays" / "nfl" / "2026" / "3" / "401910101.json").read_text()
        )

        with caplog.at_level(logging.WARNING):
            samples = collect(LocalWeeks(tmp_path), "nfl", [2026])

        assert "could not read nfl 2026 week 3" in caplog.text
        assert len(samples["epa_per_play"]) == 2


class TestTheArtifactItWrites:
    def test_lands_where_the_store_reads_it(self, tmp_path: Path) -> None:
        """The round trip that matters: what this writes is what
        `app.distributions` serves, at the path it looks in."""
        artifact = build(
            "nfl", [2024, 2025], {"epa_per_play": [i / 400 for i in range(400)]}
        )

        path = write(artifact, tmp_path)

        assert path == tmp_path / "distributions" / "nfl.json"
        read_back = LocalDistributionStore(tmp_path).get("nfl")
        assert read_back.metrics["epa_per_play"].values == (
            artifact.metrics["epa_per_play"].values
        )
        assert read_back.seasons == [2024, 2025]

    def test_is_json_a_person_can_read(self, tmp_path: Path) -> None:
        artifact = build("nfl", [2025], {"epa_per_play": [i / 300 for i in range(300)]})
        path = write(artifact, tmp_path)

        parsed = json.loads(path.read_text())
        assert parsed["league"] == "nfl"
        # Rounded rather than seventeen digits of float noise, so the file is
        # a diff somebody can read.
        assert all(
            len(str(value).split(".")[-1]) <= 6
            for value in parsed["metrics"]["epa_per_play"]["values"]
        )


class TestTheCommandLine:
    def test_builds_and_writes_from_the_local_tree(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app import settings as settings_module

        monkeypatch.setenv("INVISIBLE_STRING_RELEASES_ROOT", str(FIXTURES))
        monkeypatch.delenv("INVISIBLE_STRING_ENDGAME_BUCKET", raising=False)
        settings_module.get_settings.cache_clear()

        code = main(
            [
                "--league",
                "nfl",
                "--out",
                str(tmp_path),
                # The fixture tree is one game, which is the point of the
                # floor being adjustable rather than absolute.
                "--min-samples",
                "1",
            ]
        )
        settings_module.get_settings.cache_clear()

        assert code == 0
        assert LocalDistributionStore(tmp_path).get("nfl").metrics.keys() == {
            "epa_per_play",
            "game_control",
        }

    def test_refuses_to_write_a_league_with_no_plays(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
    ) -> None:
        from app import settings as settings_module

        monkeypatch.setenv("INVISIBLE_STRING_RELEASES_ROOT", str(FIXTURES))
        monkeypatch.delenv("INVISIBLE_STRING_ENDGAME_BUCKET", raising=False)
        settings_module.get_settings.cache_clear()

        with caplog.at_level(logging.ERROR):
            code = main(["--league", "mens", "--out", str(tmp_path)])
        settings_module.get_settings.cache_clear()

        assert code == 1
        assert "no processed play-by-play" in caplog.text
        assert not (tmp_path / "distributions").exists()

    def test_writes_nothing_when_no_metric_clears_the_floor(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
    ) -> None:
        """A run that scored real games and still has too few of them must not
        leave a confident-looking artifact behind."""
        from app import settings as settings_module

        monkeypatch.setenv("INVISIBLE_STRING_RELEASES_ROOT", str(FIXTURES))
        monkeypatch.delenv("INVISIBLE_STRING_ENDGAME_BUCKET", raising=False)
        settings_module.get_settings.cache_clear()

        with caplog.at_level(logging.ERROR):
            code = main(["--league", "nfl", "--out", str(tmp_path)])
        settings_module.get_settings.cache_clear()

        assert code == 1
        assert f"reached {MIN_SAMPLES} observations" in caplog.text
        assert not (tmp_path / "distributions").exists()


class FakePaginator:
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self._pages = pages

    def paginate(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.kwargs = kwargs
        return self._pages


class FakeS3:
    def __init__(self, prefixes: dict[str, list[str]]) -> None:
        self._prefixes = prefixes
        self.asked: list[str] = []

    def get_paginator(self, name: str) -> Any:
        return self

    def paginate(self, **kwargs: Any) -> list[dict[str, Any]]:
        prefix = kwargs["Prefix"]
        self.asked.append(prefix)
        return [
            {
                "CommonPrefixes": [
                    {"Prefix": f"{prefix}{child}/"}
                    for child in self._prefixes.get(prefix, [])
                ]
            }
        ]


class TestListingTheBucket:
    """The partition names are parsed, and a parse that silently returns
    nothing looks exactly like a league with no plays."""

    def test_reads_the_season_partitions(self) -> None:
        s3 = FakeS3(
            {
                "processed/plays/league=nfl/": [
                    "season=2023",
                    "season=2024",
                    "season=2025",
                ]
            }
        )
        assert AwsWeeks("endgame", client=s3).seasons("nfl") == [2023, 2024, 2025]

    def test_reads_the_week_partitions(self) -> None:
        s3 = FakeS3(
            {
                "processed/plays/league=nfl/season=2025/": [
                    "week=01",
                    "week=02",
                    "week=18",
                ]
            }
        )
        assert AwsWeeks("endgame", client=s3).weeks("nfl", 2025) == [1, 2, 18]

    def test_ignores_anything_that_isnt_a_partition(self) -> None:
        s3 = FakeS3({"processed/plays/league=nfl/": ["season=2025", "_temporary"]})
        assert AwsWeeks("endgame", client=s3).seasons("nfl") == [2025]
