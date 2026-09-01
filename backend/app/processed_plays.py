"""The AWS half of a win probability curve: one game out of one parquet object.

DESIGN.md section 16.3. endgame's processed play-by-play is one object per
league-week at

    processed/plays/league={league}/season={season}/week={week:02d}/data.parquet

sorted by `game_id` and written in small row groups precisely so that one game
can be read out of one without moving the week. That is the property this
module spends: the filter goes to the parquet reader, which compares it
against each row group's min/max `game_id` in the footer and fetches only the
byte ranges that can match -- ~150 KB of a ~930 KB NCAAFB week.

Three things follow from that, and they are why this is a separate module from
`app.plays` rather than another class in it:

- **It needs pyarrow, and pyarrow is the heaviest thing in the image.** Nothing
  imports this until a request actually asks for a curve against a configured
  bucket (`app.plays._build_source` defers it), the same way `app.releases`
  defers `app.s3`.
- **It reads through `pyarrow.fs.S3FileSystem`, not boto3.** Everything else in
  this app reads whole objects, where boto3 is the right client; this reads
  byte ranges out of a footer-indexed file, and Arrow's own filesystem is what
  turns a filter into those ranges. It resolves credentials from the same
  default chain boto3 does, so the instance role covers it.
- **The path is built, never listed.** The partition directories are the
  layout, not the lookup -- which is the whole reason `ScheduledGame` carries
  the season and week it was read under.
"""

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Sequence
from typing import Any

from lucky_ones.plays import Play

log = logging.getLogger(__name__)

# endgame's `_PREFIX`, and its zero-padding. Mirrored rather than imported for
# the reason `app.endgame_pickle` mirrors a field order: `endgame_aws` arrives
# transitively at whatever rev cassandra pins, and a key this app builds should
# not depend on which one that is.
PREFIX = "processed/plays"

# How many games' plays to keep. A game is a few hundred rows of a NamedTuple,
# so this is kilobytes rather than the megabytes a season file costs -- but it
# is bounded anyway, because the key includes a game id and an unbounded cache
# keyed by one grows with every link anybody follows.
MAX_CACHED_GAMES = 32


def week_key(league: str, season: int, week: int) -> str:
    """The object a league-week's plays live in."""
    return f"{PREFIX}/league={league}/season={season}/week={week:02d}/data.parquet"


class AwsPlaysSource:
    """Live reads against endgame's processed play-by-play.

    Safe to share across threads: FastAPI runs sync endpoints in a threadpool,
    so several requests can land here at once.
    """

    def __init__(
        self,
        bucket: str,
        ttl_seconds: float = 300.0,
        filesystem: Any | None = None,
    ) -> None:
        self._bucket = bucket
        self._ttl = ttl_seconds
        self._filesystem = filesystem
        self._lock = threading.Lock()
        self._games: OrderedDict[tuple[str, int, int, str], tuple[Any, float]] = (
            OrderedDict()
        )

    @property
    def filesystem(self) -> Any:
        """Built on first use and kept.

        Constructing one resolves the bucket's region, which is a request --
        doing it per read would double the cost of the small reads this exists
        to make cheap. endgame's store keeps one for exactly this reason.
        """
        if self._filesystem is None:
            import pyarrow.fs as fs

            self._filesystem = fs.S3FileSystem()
        return self._filesystem

    def game(self, league: str, season: int, week: int, game_id: str) -> Sequence[Play]:
        key = (league, season, week, game_id)
        cached = self._cached(key)
        if cached is not None:
            return cached

        plays = self._read(league, season, week, game_id)
        with self._lock:
            self._games[key] = (plays, time.monotonic())
            self._games.move_to_end(key)
            while len(self._games) > MAX_CACHED_GAMES:
                self._games.popitem(last=False)
        return plays

    def _read(
        self, league: str, season: int, week: int, game_id: str
    ) -> Sequence[Play]:
        import pyarrow.dataset as ds
        from lucky_ones.arrow import PLAY_COLUMNS, sort_plays, table_to_plays

        from app.plays import PlaysUnavailable

        path = f"{self._bucket}/{week_key(league, season, week)}"
        try:
            dataset = ds.dataset(path, filesystem=self.filesystem, format="parquet")
            table = dataset.to_table(
                columns=list(PLAY_COLUMNS),
                filter=ds.field("game_id") == game_id,
            )
        except FileNotFoundError:
            # A week nobody has processed yet, which is every week of a season
            # in progress past the current one -- and the normal state of the
            # week a game is played in until the transform runs. Not an error:
            # the page says the plays aren't in yet.
            log.info("no processed plays at s3://%s", path)
            return []
        except Exception as exc:  # noqa: BLE001 - see below
            # Everything else opening that object can be: AccessDenied and a
            # lost connection out of Arrow's filesystem (OSError), a footer
            # that won't parse out of the parquet reader (ArrowInvalid, which
            # is a ValueError), a schema the two ends disagree about. There is
            # no useful list to enumerate -- it is "this build's reader and
            # that bucket's object disagree", which is open-ended by nature,
            # and the same reasoning `app.api.games` gives for its bare
            # excepts. What matters is that none of them is a fact about the
            # game, so none of them may be reported as one.
            log.warning("could not read s3://%s", path, exc_info=True)
            raise PlaysUnavailable(f"could not read play-by-play: {exc}") from exc

        try:
            return sort_plays(table_to_plays(table))
        except KeyError as exc:
            # The week exists and doesn't carry the columns a play has, which
            # is what a raw (drive JSON) object under the processed prefix
            # would look like, or a schema that moved under us.
            log.warning("s3://%s isn't processed play-by-play: %s", path, exc)
            raise PlaysUnavailable(f"could not read play-by-play: {exc}") from exc

    def _cached(self, key: tuple[str, int, int, str]) -> Sequence[Play] | None:
        with self._lock:
            hit = self._games.get(key)
            if hit is None or (time.monotonic() - hit[1]) >= self._ttl:
                return None
            self._games.move_to_end(key)
            return hit[0]
