"""What a metric usually looks like in a league, as a hundred checkpoints.

The game page can say a team averaged +0.37 expected points a snap. It has
never been able to say whether that is a good game, because the only thing
that answers it is every other game -- and those metrics are computed per
request out of one game's play-by-play (`app.win_probability.curve_for`).
There is no table of them to rank against, and building one on read would
mean processing a decade of plays to label a single page.

So the distribution is precomputed and the *shape* is what gets stored:
101 checkpoints, the metric's value at each percentile from 0 to 100. That is
a couple of hundred bytes a metric, which is what makes this a small JSON
object read whole rather than a table -- and it inverts, which is the only
operation anybody wants. Find where a value falls between two checkpoints and
you have its percentile, to well under a percentile through the middle.

Three decisions worth keeping straight.

**The population is the team-game, not the game.** `epa.home` and `epa.away`
are two offensive performances, and a control share belongs to one side. So a
metric with one distribution is built from about two rows per game rather than
one, and the `unit` field says so out loud rather than leaving it to be
inferred from `n`.

**Five seasons, not all of them.** These leagues span enough years that the
rules move underneath the metric -- college scoring in 2008 is not college
scoring now -- so a percentile against all time answers a question nobody
asked. The window is named in the artifact rather than assumed here, because
it is a property of how the thing was built and a reader of the page deserves
to be told which seasons they are being compared against.

**The checkpoints are values, and they are sorted.** Index `i` is the value at
the `i`th percentile, so the array is non-decreasing by construction. A file
that isn't is refused rather than served: the lookup is a search through it,
and an unsorted array doesn't fail there, it quietly answers wrong.

What this module does *not* do is the lookup. That happens in the browser,
because a page holding the curve can label any number it already has without a
round trip per metric -- and every metric on that page arrived in one response
it had to fetch anyway.
"""

import json
import logging
import threading
import time
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ValidationError, field_validator

from app.settings import Settings, get_settings

log = logging.getLogger(__name__)

# p0 through p100 inclusive. The resolution is deliberately coarse -- this is
# for saying "about the 80th percentile", not for inference -- and the two ends
# are the least trustworthy entries in it: p0 and p100 are single extreme
# games and move every time the artifact is rebuilt. They are clamps rather
# than numbers anyone should read.
CHECKPOINTS = 101


class DistributionsNotFound(LookupError):
    """No distribution artifact exists for this league.

    The ordinary case rather than a failure: only football has the play-level
    metrics these describe, and a league with none is a game page that shows
    its numbers without percentile labels beside them.
    """


class DistributionsUnreadable(ValueError):
    """The artifact is there and doesn't match the schema.

    Kept apart from missing for the reason `ReleaseUnreadable` is: a 404 sends
    someone hunting for an object that is plainly sitting in the bucket, and
    the fix for this one is a republish rather than a different request.
    """


class MetricDistribution(BaseModel):
    """One metric's shape, as the value at each percentile.

    `unit` names what one observation was -- "team-game" for every metric here
    so far -- because `n` on its own can't distinguish a metric sampled once
    per game from one sampled once per side, and those are different claims
    about the same season.
    """

    unit: str
    n: int
    values: list[float]

    @field_validator("values")
    @classmethod
    def _checkpoints(cls, values: list[float]) -> list[float]:
        if len(values) != CHECKPOINTS:
            raise ValueError(
                f"expected {CHECKPOINTS} checkpoints (p0 through p100), "
                f"got {len(values)}"
            )
        # Non-decreasing rather than strictly increasing: a metric with a mass
        # of ties -- a luck total that is 0 for most games -- legitimately
        # repeats a value across a run of percentiles.
        for i in range(1, len(values)):
            if values[i] < values[i - 1]:
                raise ValueError(
                    f"checkpoints must not decrease: p{i} ({values[i]}) is "
                    f"below p{i - 1} ({values[i - 1]})"
                )
        return values


class LeagueDistributions(BaseModel):
    """Every metric this league has a shape for, and what built them."""

    schema_version: Literal[1] = 1
    league: str
    run_id: str
    created_at: datetime
    # The seasons the population was drawn from, listed rather than given as a
    # count: "the last five" is only meaningful with the year it was built.
    seasons: list[int]
    metrics: dict[str, MetricDistribution]


def parse_distributions(raw: str | bytes, league: str) -> LeagueDistributions:
    """Validate one artifact, naming the league when it doesn't validate.

    Both stores go through here, so a bad object looks the same locally and in
    S3 and pydantic's error never escapes as a bare 500.
    """
    try:
        return LeagueDistributions.model_validate(json.loads(raw))
    except (ValidationError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise DistributionsUnreadable(
            f"{league} distributions do not match the current schema"
        ) from exc


class DistributionStore(Protocol):
    def get(self, league: str) -> LeagueDistributions: ...


class LocalDistributionStore:
    """Reads `<root>/distributions/<league>.json`.

    The same root the releases and the parquet artifacts come out of, laid out
    the way the bucket is. Uncached like `LocalReleaseStore`: a local file is a
    few milliseconds, and a test that has just written one should see it.
    """

    def __init__(self, root: Path) -> None:
        self._dir = root / "distributions"

    def get(self, league: str) -> LeagueDistributions:
        path = self._dir / f"{league}.json"
        try:
            raw = path.read_text()
        except FileNotFoundError as exc:
            raise DistributionsNotFound(f"no distributions for {league}") from exc
        return parse_distributions(raw, league)


class S3DistributionStore:
    """Reads `{prefix}{league}.json` out of the artifact bucket.

    Cached on a TTL rather than on an ETag, unlike the release store. The
    trade is the other way round from `app.artifacts`: these objects are tiny,
    so re-reading is cheap, but they are rebuilt about as often as the rules
    change -- which is to say almost never. A long TTL on a file that moves
    once a season costs nothing and saves a GET per game page.

    Safe to share across threads: FastAPI runs sync endpoints in a threadpool.
    """

    def __init__(
        self,
        bucket: str,
        prefix: str = "distributions/",
        ttl_seconds: float = 900.0,
        client: Any | None = None,
    ) -> None:
        self._bucket = bucket
        self._prefix = prefix.rstrip("/") + "/" if prefix else ""
        self._ttl = ttl_seconds
        self._client = client
        self._lock = threading.Lock()
        self._cached: dict[str, tuple[LeagueDistributions | None, float]] = {}

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3

            self._client = boto3.client("s3")
        return self._client

    def get(self, league: str) -> LeagueDistributions:
        with self._lock:
            hit = self._cached.get(league)
        if hit is not None and (time.monotonic() - hit[1]) < self._ttl:
            # A miss is cached too. Only football has these, so a basketball
            # game page would otherwise send a doomed GET every time somebody
            # opened one.
            if hit[0] is None:
                raise DistributionsNotFound(f"no distributions for {league}")
            return hit[0]

        from botocore.exceptions import BotoCoreError, ClientError

        key = f"{self._prefix}{league}.json"
        try:
            raw = self.client.get_object(Bucket=self._bucket, Key=key)["Body"].read()
        except (ClientError, BotoCoreError) as exc:
            # Every failure to fetch is "no distributions" here, including the
            # ones that aren't really: AccessDenied and a lost connection get
            # the same answer a missing object does. That is the right trade
            # for a file whose entire job is an optional label -- the page
            # renders its numbers unlabelled either way, and a 502 would take
            # down a game page over an annotation.
            log.info("no distributions at s3://%s/%s: %s", self._bucket, key, exc)
            with self._lock:
                self._cached[league] = (None, time.monotonic())
            raise DistributionsNotFound(f"no distributions for {league}") from exc

        parsed = parse_distributions(raw, league)
        with self._lock:
            self._cached[league] = (parsed, time.monotonic())
        return parsed


@lru_cache(maxsize=1)
def _build_store(settings: Settings) -> DistributionStore:
    """S3 when a bucket is configured, otherwise the local directory.

    The same switch `app.releases` and `app.artifacts` make, off the same
    setting, because this artifact lives in the same bucket they do.
    """
    if settings.releases_bucket:
        return S3DistributionStore(
            bucket=settings.releases_bucket,
            prefix=settings.distributions_prefix,
            ttl_seconds=settings.distributions_cache_ttl_seconds,
        )
    return LocalDistributionStore(settings.releases_root)


def get_distribution_store() -> DistributionStore:
    """FastAPI dependency. Overridden in tests with a fixture-backed one."""
    return _build_store(get_settings())
