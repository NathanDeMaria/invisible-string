"""Reading `history.parquet` and `predictions.parquet` (`app.artifacts`).

The two stores are tested through the same fixtures, and the S3 one through
Arrow's local filesystem rather than moto: what separates it from the local
store is a filesystem object and a cache, not a protocol, so pointing it at a
directory exercises every line that matters except the one that constructs
`S3FileSystem`.
"""

import logging
from datetime import date
from pathlib import Path

import pandas as pd
import pyarrow.fs as fs
import pytest
from cassandra.serving import (
    HISTORY_COLUMNS,
    PREDICTION_COLUMNS,
    predictions_path,
    write_predictions,
)

from app.artifacts import LocalArtifactStore, S3ArtifactStore


@pytest.fixture
def local(artifact_root: Path) -> LocalArtifactStore:
    return LocalArtifactStore(artifact_root)


def s3_like(root: Path, ttl_seconds: float = 300.0) -> S3ArtifactStore:
    """The S3 store, reading a directory. See the module docstring."""
    return S3ArtifactStore(
        bucket=str(root),
        prefix="models/",
        ttl_seconds=ttl_seconds,
        filesystem=fs.LocalFileSystem(),
    )


class TestReadingWhatWasPublished:
    def test_history_comes_back_in_the_published_schema(
        self, local: LocalArtifactStore
    ) -> None:
        frame = local.history("mens", "glicko_tuned")
        assert list(frame.columns) == list(HISTORY_COLUMNS)
        # Four teams over two seasons -- six weeks of 2025 and two of 2026.
        assert len(frame) == 32
        assert set(frame["year"]) == {2025, 2026}

    def test_predictions_come_back_in_the_published_schema(
        self, local: LocalArtifactStore
    ) -> None:
        frame = local.predictions("mens", "glicko_tuned", date.today(), date.today())
        assert list(frame.columns) == list(PREDICTION_COLUMNS)
        assert set(frame["game_id"]) == {
            "401710101",
            "401710102",
            "401710103",
            "401710104",
        }

    def test_the_s3_store_reads_the_same_rows(self, artifact_root: Path) -> None:
        mine = s3_like(artifact_root).history("mens", "glicko_tuned")
        theirs = LocalArtifactStore(artifact_root).history("mens", "glicko_tuned")
        pd.testing.assert_frame_equal(
            mine.sort_values(["team", "week"]).reset_index(drop=True),
            theirs.sort_values(["team", "week"]).reset_index(drop=True),
        )


class TestAnArtifactThatIsntThere:
    """A model published before these existed, which is every model in the
    bucket until it is republished. The page degrades; it does not fail."""

    def test_a_missing_file_is_an_empty_frame(self, tmp_path: Path) -> None:
        frame = LocalArtifactStore(tmp_path).history("mens", "glicko_tuned")
        assert frame.empty
        # With the columns, so a caller can filter without asking first.
        assert list(frame.columns) == list(HISTORY_COLUMNS)

    def test_a_missing_league_is_an_empty_frame(
        self, local: LocalArtifactStore
    ) -> None:
        assert local.history("wnba", "glicko_tuned").empty

    def test_an_unreadable_file_is_an_empty_frame(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        """AccessDenied, a truncated object, a footer that won't parse. None of
        them is a fact about the season, so none may take the page down -- but
        each is worth a line, because unlike a missing file they don't resolve
        themselves."""
        path = predictions_path(tmp_path, "mens", "glicko_tuned")
        path.parent.mkdir(parents=True)
        path.write_bytes(b"not a parquet file")

        with caplog.at_level(logging.WARNING):
            frame = LocalArtifactStore(tmp_path).predictions(
                "mens", "glicko_tuned", date.today(), date.today()
            )
        assert frame.empty
        assert "could not read" in caplog.text


class TestTheWindow:
    """The bounds the S3 read prunes row groups with. Correctness doesn't hang
    on them -- the caller matches rows to games by id -- but a window that
    dropped the days being rendered would cost every completed game its
    number."""

    @pytest.fixture
    def spread_out(self, tmp_path: Path) -> Path:
        """Predictions across a fortnight, one game a day."""
        rows = pd.DataFrame(
            [
                {
                    "game_id": f"g{day:02d}",
                    "date": pd.Timestamp(f"2026-08-{day:02d}T23:00:00Z"),
                    "year": 2026,
                    "week": 1,
                    "home_team": "Duke",
                    "away_team": "North Carolina",
                    "neutral_site": False,
                    "team1_win_prob": 0.6,
                    "predicted_margin": 4.0,
                    "home_score": 70,
                    "away_score": 68,
                    "spread": -3.5,
                    "run_id": "2026-08-08T09:00:12Z",
                }
                for day in range(10, 25)
            ]
        )
        write_predictions(rows, predictions_path(tmp_path, "mens", "glicko_tuned"))
        return tmp_path

    def test_only_the_days_asked_for(self, spread_out: Path) -> None:
        frame = s3_like(spread_out).predictions(
            "mens", "glicko_tuned", date(2026, 8, 15), date(2026, 8, 17)
        )
        # A day of slack either side, deliberately: the window is a span of
        # days in one zone and the column is an instant in another.
        assert set(frame["game_id"]) == {"g14", "g15", "g16", "g17", "g18"}

    def test_a_window_with_nothing_in_it(self, spread_out: Path) -> None:
        frame = s3_like(spread_out).predictions(
            "mens", "glicko_tuned", date(2026, 9, 1), date(2026, 9, 2)
        )
        assert frame.empty
        assert list(frame.columns) == list(PREDICTION_COLUMNS)


class TestTheCache:
    def test_a_republish_inside_the_ttl_is_not_seen(self, artifact_root: Path) -> None:
        """The trade the TTL makes, stated as a test: these files are
        megabytes, so they are re-read on a clock rather than re-checked per
        request the way a release is."""
        store = s3_like(artifact_root)
        first = store.history("mens", "glicko_tuned")
        assert store.history("mens", "glicko_tuned") is first

    def test_and_is_seen_once_it_lapses(self, artifact_root: Path) -> None:
        store = s3_like(artifact_root, ttl_seconds=0)
        assert store.history("mens", "glicko_tuned") is not store.history(
            "mens", "glicko_tuned"
        )


class TestOneTeamsGames:
    """The third way to read the predictions file.

    The other two read a span of days, which is what the file is sorted for.
    A team's games are spread across every row group in it, so this one is a
    filtered read rather than a range read -- and the filter is what keeps it
    from materializing sixteen seasons to answer about one team.
    """

    def test_finds_a_team_on_either_side_of_the_fixture(
        self, local: LocalArtifactStore
    ) -> None:
        """Duke is home in one of the fixture's games and away in another.

        cassandra stores a game once, under whichever team was home, so a
        team's schedule is the union of the two columns -- a filter on one of
        them would silently serve half a season.
        """
        frame = local.team_predictions("mens", "glicko_tuned", "Duke")

        assert set(frame["game_id"]) == {"401710101", "401710103"}
        assert list(frame.columns) == list(PREDICTION_COLUMNS)

    def test_leaves_out_the_games_it_wasnt_in(self, local: LocalArtifactStore) -> None:
        frame = local.team_predictions("mens", "glicko_tuned", "Duke")
        assert "401710102" not in set(frame["game_id"])

    def test_a_team_with_no_games_is_an_empty_frame(
        self, local: LocalArtifactStore
    ) -> None:
        """With the columns, so the caller can filter without asking first --
        the same contract a missing file has."""
        frame = local.team_predictions("mens", "glicko_tuned", "Vermont")

        assert frame.empty
        assert list(frame.columns) == list(PREDICTION_COLUMNS)

    def test_a_missing_file_is_an_empty_frame(self, tmp_path: Path) -> None:
        frame = LocalArtifactStore(tmp_path).team_predictions(
            "mens", "glicko_tuned", "Duke"
        )
        assert frame.empty
        assert list(frame.columns) == list(PREDICTION_COLUMNS)

    def test_the_s3_store_reads_the_same_rows(self, artifact_root: Path) -> None:
        mine = s3_like(artifact_root).team_predictions("mens", "glicko_tuned", "Duke")
        theirs = LocalArtifactStore(artifact_root).team_predictions(
            "mens", "glicko_tuned", "Duke"
        )
        pd.testing.assert_frame_equal(
            mine.sort_values("game_id").reset_index(drop=True),
            theirs.sort_values("game_id").reset_index(drop=True),
        )

    def test_a_second_read_inside_the_ttl_is_cached(self, artifact_root: Path) -> None:
        store = s3_like(artifact_root)
        first = store.team_predictions("mens", "glicko_tuned", "Duke")
        assert store.team_predictions("mens", "glicko_tuned", "Duke") is first

    def test_the_cache_is_bounded(self, artifact_root: Path) -> None:
        """The key is a team name and the college leagues have hundreds, so
        this can't be allowed to grow with who has been looked at."""
        from app.artifacts import MAX_CACHED_TEAMS

        store = s3_like(artifact_root)
        for i in range(MAX_CACHED_TEAMS + 4):
            store.team_predictions("mens", "glicko_tuned", f"team-{i}")

        assert len(store._teams) == MAX_CACHED_TEAMS
