"""Reading one game out of a week's parquet.

The AWS source is tested against a real parquet file through Arrow's *local*
filesystem rather than a mock, because the thing worth checking is the part
that would be mocked away: that the key is built the way endgame writes it,
that the filter really selects one game out of a week, and that a week nobody
has processed is an empty answer rather than an exception. Swap the filesystem
and the same code path reads S3 -- that is what `filesystem` is an argument
for.
"""

from datetime import datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.fs as pafs
import pyarrow.parquet as pq
import pytest

from app.plays import PlaysUnavailable
from app.processed_plays import MAX_CACHED_GAMES, AwsPlaysSource, week_key

# The columns `lucky_ones.arrow.ArrowPlay` reads, in endgame's own types where
# they matter. Only `wallclock` is fussy: parquet has no second-resolution
# timestamp, so the schema declares milliseconds.
SCHEMA = pa.schema(
    [
        pa.field("league", pa.string()),
        pa.field("season", pa.int16()),
        pa.field("week", pa.int8()),
        pa.field("game_id", pa.string()),
        pa.field("play_id", pa.string()),
        pa.field("play_number", pa.int16()),
        pa.field("period", pa.int8()),
        pa.field("clock_seconds", pa.int16()),
        pa.field("wallclock", pa.timestamp("ms", tz="UTC")),
        pa.field("home_score", pa.int16()),
        pa.field("away_score", pa.int16()),
        pa.field("offense_team_id", pa.string()),
        pa.field("defense_team_id", pa.string()),
        pa.field("down", pa.int8()),
        pa.field("distance", pa.int16()),
        pa.field("yardline", pa.int8()),
        pa.field("play_type", pa.string()),
        pa.field("text", pa.string()),
        pa.field("scoring_play", pa.bool_()),
        pa.field("is_penalty", pa.bool_()),
        pa.field("is_turnover", pa.bool_()),
        pa.field("drive_id", pa.string()),
        pa.field("drive_number", pa.int16()),
        pa.field("drive_team_id", pa.string()),
        pa.field("drive_result", pa.string()),
        pa.field("drive_is_score", pa.bool_()),
    ]
)


def row(game_id: str, play_number: int) -> dict[str, Any]:
    return {
        "league": "nfl",
        "season": 2026,
        "week": 3,
        "game_id": game_id,
        "play_id": f"{game_id}-{play_number}",
        "play_number": play_number,
        "period": 1,
        "clock_seconds": 900 - play_number,
        "wallclock": datetime(2026, 9, 6, 17, 0),
        "home_score": 0,
        "away_score": 0,
        "offense_team_id": "3",
        "defense_team_id": "9",
        "down": 1,
        "distance": 10,
        "yardline": 25,
        "play_type": "Rush",
        "text": "A.Jones up the middle for 3 yards",
        "scoring_play": False,
        "is_penalty": False,
        "is_turnover": False,
        "drive_id": f"{game_id}-1",
        "drive_number": 1,
        "drive_team_id": "3",
        "drive_result": "Punt",
        "drive_is_score": False,
    }


def write_week(bucket: Path, rows: list[dict[str, Any]]) -> None:
    key = bucket / week_key("nfl", 2026, 3)
    key.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), key)


@pytest.fixture
def source(tmp_path: Path) -> AwsPlaysSource:
    """The AWS source with a local filesystem under it -- the same reader."""
    return AwsPlaysSource(bucket=str(tmp_path), filesystem=pafs.LocalFileSystem())


class TestTheKey:
    def test_is_endgames_own(self) -> None:
        """Mirrored from `endgame_aws.pbp_parquet`, zero-padding and all: a
        week written as `week=03` and read as `week=3` is a 404 that looks
        like a game with no plays."""
        assert (
            week_key("ncaafb", 2025, 4)
            == "processed/plays/league=ncaafb/season=2025/week=04/data.parquet"
        )

    def test_pads_a_two_digit_week(self) -> None:
        assert week_key("nfl", 2026, 12).endswith("week=12/data.parquet")


class TestReadingAGame:
    def test_reads_only_the_game_asked_for(
        self, source: AwsPlaysSource, tmp_path: Path
    ) -> None:
        """The reason a week is one object: the filter goes to the parquet
        reader, so one game costs a fraction of its week."""
        write_week(tmp_path, [row("1", 1), row("2", 1), row("1", 2)])
        plays = source.game("nfl", 2026, 3, "1")
        assert [p.play_number for p in plays] == [1, 2]
        assert {p.game_id for p in plays} == {"1"}

    def test_orders_the_plays(self, source: AwsPlaysSource, tmp_path: Path) -> None:
        write_week(tmp_path, [row("1", 3), row("1", 1), row("1", 2)])
        assert [p.play_number for p in source.game("nfl", 2026, 3, "1")] == [1, 2, 3]

    def test_a_game_not_in_the_week_is_empty(
        self, source: AwsPlaysSource, tmp_path: Path
    ) -> None:
        """Every game ESPN had no play-by-play for, which on an NCAAFB week
        is most of them."""
        write_week(tmp_path, [row("1", 1)])
        assert source.game("nfl", 2026, 3, "999") == []

    def test_an_unprocessed_week_is_empty(self, source: AwsPlaysSource) -> None:
        """Not an error: the transform runs after the scrape, so the week a
        game was played in has no parquet until it does."""
        assert source.game("nfl", 2026, 3, "1") == []

    def test_an_unreadable_object_is_not(
        self, source: AwsPlaysSource, tmp_path: Path
    ) -> None:
        key = tmp_path / week_key("nfl", 2026, 3)
        key.parent.mkdir(parents=True, exist_ok=True)
        key.write_bytes(b"not a parquet file")
        with pytest.raises(PlaysUnavailable):
            source.game("nfl", 2026, 3, "1")

    def test_a_week_without_play_columns_is_not(
        self, source: AwsPlaysSource, tmp_path: Path
    ) -> None:
        """What a raw (drive JSON) object under the processed prefix would
        look like, or a schema that moved under us."""
        key = tmp_path / week_key("nfl", 2026, 3)
        key.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.table({"game_id": ["1"], "nonsense": [2]}), key)
        with pytest.raises(PlaysUnavailable):
            source.game("nfl", 2026, 3, "1")


class TestTheCache:
    def test_a_second_read_doesnt_touch_the_file(
        self, source: AwsPlaysSource, tmp_path: Path
    ) -> None:
        write_week(tmp_path, [row("1", 1)])
        first = source.game("nfl", 2026, 3, "1")
        (tmp_path / week_key("nfl", 2026, 3)).unlink()
        assert source.game("nfl", 2026, 3, "1") == first

    def test_it_expires(self, tmp_path: Path) -> None:
        write_week(tmp_path, [row("1", 1)])
        source = AwsPlaysSource(
            bucket=str(tmp_path), ttl_seconds=0, filesystem=pafs.LocalFileSystem()
        )
        assert source.game("nfl", 2026, 3, "1")
        (tmp_path / week_key("nfl", 2026, 3)).unlink()
        assert source.game("nfl", 2026, 3, "1") == []

    def test_it_is_bounded(self, source: AwsPlaysSource, tmp_path: Path) -> None:
        """The key holds a game id, so an unbounded cache would grow with
        every link anybody follows."""
        write_week(tmp_path, [row(str(n), 1) for n in range(MAX_CACHED_GAMES + 5)])
        for n in range(MAX_CACHED_GAMES + 5):
            source.game("nfl", 2026, 3, str(n))
        assert len(source._games) == MAX_CACHED_GAMES
