"""The two parquet artifacts a run publishes beside its release.

DESIGN.md section 6, and cassandra's `serving/layout.py`. A publish writes four
objects into one directory, under one `run_id`:

    models/{league}/{model}/latest.json          # app.releases
    models/{league}/{model}/runs/{run_id}.json
    models/{league}/{model}/history.parquet      # here
    models/{league}/{model}/predictions.parquet  # here

`history.parquet` is what every team was rated at the end of every week, which
is the only thing that can answer "up 40 points and four spots since last
week" -- a release is a snapshot with no previous rating in it.
`predictions.parquet` is what the model said *before* each game was played,
which is what lets this app stop re-predicting games the release has already
trained on (`app.api.games`).

Kept apart from `app.releases` rather than folded into `ReleaseStore`, for the
reason `app.processed_plays` is kept apart from `app.games`: a release is a
small JSON object read whole with boto3, and these are footer-indexed parquet
read through Arrow's own filesystem, which is what turns "the games either
side of today" into a couple of byte ranges instead of a ten-megabyte
download. Same bucket, same prefix, same settings -- different read.

**A missing or unreadable artifact is an empty frame, not an error.** Neither
file is load-bearing enough to fail a page over: without history the ratings
table loses a column, and without predictions the games page loses the model's
number on games it can't speak to honestly. Both are worth degrading for, and
neither is worth a 502 -- so unlike `GamesUnavailable` there is no exception
type here, only a log line saying which league went quiet. The one thing this
must never do is let a *missing* prediction pass for "the model didn't train
on this"; that judgement belongs to the caller, which has the release's
watermark in front of it.
"""

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from datetime import time as clock
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

import pandas as pd

from app.schema import (
    HISTORY_COLUMNS,
    PREDICTION_COLUMNS,
    history_path,
    predictions_path,
)
from app.settings import Settings, get_settings

log = logging.getLogger(__name__)

# How many prediction windows to keep. The games page asks for the same span of
# days over and over, but a game page asks for a narrow one around its own
# game, so the key is unbounded in principle -- see `app.processed_plays`,
# which caps its own per-game cache for the same reason.
MAX_CACHED_WINDOWS = 32

# How far past the requested days the prediction read reaches.
#
# The window is a span of days in `GAME_TZ` and the column is a timestamp
# whose zone is whatever the season pickles carried, so the two don't line up
# exactly. That is fine, because this filter is a *pruning* device and not the
# answer: it decides which row groups Arrow fetches, and the caller matches
# rows to games by `game_id` afterwards. A day of slack either side costs one
# row group and removes every question about whose midnight is meant.
_SLACK = timedelta(days=1)


class ArtifactStore(Protocol):
    def history(self, league: str, model: str) -> pd.DataFrame: ...

    def predictions(
        self, league: str, model: str, since: date, until: date
    ) -> pd.DataFrame: ...


def _empty(columns: Sequence[str]) -> pd.DataFrame:
    """What a read of an artifact that isn't there returns.

    Empty *with the columns*, so a caller can index and filter without asking
    first whether anything came back.
    """
    return pd.DataFrame({column: [] for column in columns})


def _read(
    path: str,
    columns: Sequence[str],
    filesystem: Any | None,
    where: Any | None = None,
) -> pd.DataFrame:
    """One artifact, or an empty frame with the right columns.

    `where` is an Arrow expression or None for the whole file. Column
    projection is always applied: both schemas are cassandra's
    (`app.schema`), so asking for them by name is what makes a column added
    upstream cost this app nothing.
    """
    import pyarrow.dataset as ds

    try:
        dataset = ds.dataset(path, filesystem=filesystem, format="parquet")
        table = dataset.to_table(columns=list(columns), filter=where)
    except FileNotFoundError:
        # A model published before these artifacts existed, or a league whose
        # last publish predates the republish. Info rather than warning: it is
        # a state the app is meant to survive, and it resolves itself the next
        # time that model is published.
        log.info("no artifact at %s", path)
        return _empty(columns)
    except Exception:  # noqa: BLE001 - see the module docstring
        # AccessDenied, a lost connection, a footer that won't parse, a column
        # this build asks for that the file doesn't carry. There is no useful
        # list to enumerate -- it is "this reader and that object disagree" --
        # and none of the answers is worth taking a page down for.
        log.warning("could not read %s", path, exc_info=True)
        return _empty(columns)
    return table.to_pandas()


def _window(dataset_date_type: Any, since: date, until: date) -> Any:
    """The pruning filter for a span of days. See `_SLACK`."""
    import pyarrow.dataset as ds

    low = datetime.combine(since - _SLACK, clock.min)
    high = datetime.combine(until + _SLACK, clock.max)
    if getattr(dataset_date_type, "tz", None) is not None:
        low, high = low.replace(tzinfo=UTC), high.replace(tzinfo=UTC)
    return (ds.field("date") >= low) & (ds.field("date") <= high)


def _predictions(
    path: str, filesystem: Any | None, since: date, until: date
) -> pd.DataFrame:
    """The stored predictions for a span of days.

    The bounds go to the parquet reader rather than to pandas afterwards:
    cassandra sorts the file by date precisely so a consumer reading a few
    days out of sixteen seasons fetches a few row groups, which is the same
    trick `app.processed_plays` plays on endgame's play-by-play.
    """
    import pyarrow.dataset as ds

    try:
        dataset = ds.dataset(path, filesystem=filesystem, format="parquet")
    except FileNotFoundError:
        log.info("no artifact at %s", path)
        return _empty(PREDICTION_COLUMNS)
    except Exception:  # noqa: BLE001 - see the module docstring
        log.warning("could not open %s", path, exc_info=True)
        return _empty(PREDICTION_COLUMNS)

    where = _window(dataset.schema.field("date").type, since, until)
    try:
        table = dataset.to_table(columns=list(PREDICTION_COLUMNS), filter=where)
    except Exception:  # noqa: BLE001 - see the module docstring
        log.warning("could not read %s", path, exc_info=True)
        return _empty(PREDICTION_COLUMNS)
    return table.to_pandas()


class LocalArtifactStore:
    """Reads the artifacts from a directory laid out the way the bucket is.

    The same root `LocalReleaseStore` reads, because it is the same layout --
    `cassandra.serving.layout` owns it, and both paths come from there rather
    than from a string built here.

    Uncached, like `LocalReleaseStore`: a local file re-read per request is a
    few milliseconds, and a test that has just rewritten a fixture should see
    what it wrote.
    """

    def __init__(self, root: Path) -> None:
        self._root = root

    def history(self, league: str, model: str) -> pd.DataFrame:
        return _read(
            str(history_path(self._root, league, model)), HISTORY_COLUMNS, None
        )

    def predictions(
        self, league: str, model: str, since: date, until: date
    ) -> pd.DataFrame:
        """Every stored prediction, whatever days were asked for.

        The window is deliberately ignored here. `LocalGamesSource` re-bases a
        fixture's days so the newest completed game lands today, which no
        committed prediction file can follow -- filter it and the local page
        loses the model's number on exactly the games the fixtures exist to
        show. Correctness doesn't depend on it either way: the bounds are a
        pruning device and the caller matches rows to games by `game_id` (see
        `_SLACK`).

        What it costs is reading the whole file per request, which is a few
        megabytes off a local disk -- the same trade `LocalGamesSource` and
        `LocalPlaysSource` already make with their own files.
        """
        return _read(
            str(predictions_path(self._root, league, model)),
            PREDICTION_COLUMNS,
            None,
        )


class S3ArtifactStore:
    """Reads `{prefix}{league}/{model}/*.parquet` out of the artifact bucket.

    Through `pyarrow.fs.S3FileSystem` rather than boto3, for the reason
    `app.processed_plays` gives: everything else in this app reads whole
    objects, and this reads byte ranges out of a footer-indexed file. It
    resolves credentials from the same default chain boto3 does, so the
    instance role covers it.

    Cached with a TTL rather than on an ETag. The release cache re-checks
    cheaply with a conditional GET because it holds one small object; these
    are megabytes and a re-read is a real cost, so the TTL is longer and the
    staleness it buys is bounded by how often a model is published -- once a
    day. A release that lands mid-TTL is the one case worth naming: the table
    shows the new ratings against a history that is up to `ttl` old, which
    moves the *movement* column by one refresh and nothing else.

    Safe to share across threads: FastAPI runs sync endpoints in a threadpool.
    """

    def __init__(
        self,
        bucket: str,
        prefix: str = "models/",
        ttl_seconds: float = 300.0,
        filesystem: Any | None = None,
    ) -> None:
        self._bucket = bucket
        self._prefix = prefix.rstrip("/") + "/" if prefix else ""
        self._ttl = ttl_seconds
        self._filesystem = filesystem
        self._lock = threading.Lock()
        self._history: dict[tuple[str, str], tuple[pd.DataFrame, float]] = {}
        self._windows: OrderedDict[
            tuple[str, str, date, date], tuple[pd.DataFrame, float]
        ] = OrderedDict()

    @property
    def filesystem(self) -> Any:
        """Built on first use and kept; constructing one resolves the region."""
        if self._filesystem is None:
            import pyarrow.fs as fs

            self._filesystem = fs.S3FileSystem()
        return self._filesystem

    def history(self, league: str, model: str) -> pd.DataFrame:
        key = (league, model)
        with self._lock:
            hit = self._history.get(key)
            if hit is not None and not self._expired(hit[1]):
                return hit[0]

        frame = _read(
            f"{self._bucket}/{self._prefix}{league}/{model}/history.parquet",
            HISTORY_COLUMNS,
            self.filesystem,
        )
        with self._lock:
            self._history[key] = (frame, time.monotonic())
        return frame

    def predictions(
        self, league: str, model: str, since: date, until: date
    ) -> pd.DataFrame:
        key = (league, model, since, until)
        with self._lock:
            hit = self._windows.get(key)
            if hit is not None and not self._expired(hit[1]):
                self._windows.move_to_end(key)
                return hit[0]

        frame = _predictions(
            f"{self._bucket}/{self._prefix}{league}/{model}/predictions.parquet",
            self.filesystem,
            since,
            until,
        )
        with self._lock:
            self._windows[key] = (frame, time.monotonic())
            self._windows.move_to_end(key)
            while len(self._windows) > MAX_CACHED_WINDOWS:
                self._windows.popitem(last=False)
        return frame

    def _expired(self, checked_at: float) -> bool:
        return (time.monotonic() - checked_at) >= self._ttl


@lru_cache(maxsize=1)
def _build_store(settings: Settings) -> ArtifactStore:
    """S3 when a bucket is configured, otherwise the local directory.

    The same switch `app.releases` makes, off the same two settings, because
    the artifacts live in the same place as the release they were published
    with. Cached because the S3 store holds the caches.
    """
    if settings.releases_bucket:
        return S3ArtifactStore(
            bucket=settings.releases_bucket,
            prefix=settings.releases_prefix,
            ttl_seconds=settings.artifacts_cache_ttl_seconds,
        )
    return LocalArtifactStore(settings.releases_root)


def get_artifact_store() -> ArtifactStore:
    """FastAPI dependency. Overridden in tests with a fixture-backed one."""
    return _build_store(get_settings())
