"""Reading a league's seasons of players, published by cassandra's `publish`.

Files beside a league's models rather than under them,
`players_{season}.json.gz`: every directory under a league is read as a model.
Their own store rather than more of `ReleaseStore`, because nothing that
predicts reads them.

Held as the gzipped bytes they're published as, and handed to the browser that
way, never parsed. The server has 512 MB and often peaks past 90% of it: parsed,
the 22 files take about 180 MB; like this, about 8. Only the current season
moves, so S3 is re-checked on the releases' TTL with a conditional GET.
"""

import re
import threading
import time
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

import boto3
from botocore.exceptions import ClientError

from app.settings import Settings, get_settings

_FILE = re.compile(r"players_(?P<season>\d{4})\.json\.gz$")

_NOT_MODIFIED = {"304", "NotModified"}
_MISSING = {"NoSuchKey", "404"}


def default_season(seasons: list[int], today: date) -> int | None:
    """The season a page opens on: the one that starts this calendar year from
    October, a month before the opener, and the one before that until then.
    The newest published at or before it, so a new season's file arriving late
    leaves last season up rather than an empty table."""
    if not seasons:
        return None
    current = today.year if today.month >= 10 else today.year - 1
    return max((s for s in seasons if s <= current), default=min(seasons))


class PlayersStore(Protocol):
    def list_seasons(self, league: str) -> list[int]: ...

    def get_players(self, league: str, season: int) -> bytes | None:
        """A season's gzipped `PlayersFile`, or None if it has no file."""
        ...


class LocalPlayersStore:
    """`<root>/models/<league>/players_<season>.json.gz`."""

    def __init__(self, root: Path) -> None:
        self._models_dir = root / "models"

    def list_seasons(self, league: str) -> list[int]:
        found = (self._models_dir / league).glob("players_*.json.gz")
        return sorted(int(m["season"]) for p in found if (m := _FILE.search(p.name)))

    def get_players(self, league: str, season: int) -> bytes | None:
        path = self._models_dir / league / f"players_{season}.json.gz"
        try:
            return path.read_bytes()
        except FileNotFoundError:
            return None


@dataclass
class _CachedSeason:
    body: bytes
    etag: str
    checked_at: float


class S3PlayersStore:
    def __init__(
        self,
        bucket: str,
        prefix: str = "models/",
        ttl_seconds: float = 60.0,
        client: Any | None = None,
    ) -> None:
        self._bucket = bucket
        self._prefix = prefix.rstrip("/") + "/" if prefix else ""
        self._ttl = ttl_seconds
        self._client = client if client is not None else boto3.client("s3")
        self._lock = threading.Lock()
        self._seasons: dict[tuple[str, int], _CachedSeason] = {}
        self._listings: dict[str, tuple[list[int], float]] = {}

    def list_seasons(self, league: str) -> list[int]:
        with self._lock:
            hit = self._listings.get(league)
        if hit is not None and not self._expired(hit[1]):
            return list(hit[0])
        seasons: list[int] = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(
            Bucket=self._bucket, Prefix=f"{self._prefix}{league}/players_"
        ):
            for entry in page.get("Contents", []):
                if match := _FILE.search(entry["Key"]):
                    seasons.append(int(match["season"]))
        seasons.sort()
        with self._lock:
            self._listings[league] = (seasons, time.monotonic())
        return list(seasons)

    def get_players(self, league: str, season: int) -> bytes | None:
        cache_key = (league, season)
        with self._lock:
            hit = self._seasons.get(cache_key)
        if hit is not None and not self._expired(hit.checked_at):
            return hit.body

        kwargs: dict[str, Any] = {
            "Bucket": self._bucket,
            "Key": f"{self._prefix}{league}/players_{season}.json.gz",
        }
        if hit is not None and hit.etag:
            kwargs["IfNoneMatch"] = hit.etag
        try:
            response = self._client.get_object(**kwargs)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if hit is not None and (code in _NOT_MODIFIED or status == 304):
                with self._lock:
                    hit.checked_at = time.monotonic()
                return hit.body
            if code in _MISSING:
                return None
            raise

        body = response["Body"].read()
        with self._lock:
            self._seasons[cache_key] = _CachedSeason(
                body, response.get("ETag", ""), time.monotonic()
            )
        return body

    def _expired(self, checked_at: float) -> bool:
        return (time.monotonic() - checked_at) >= self._ttl


@lru_cache
def _build_store(settings: Settings) -> PlayersStore:
    if settings.releases_bucket:
        return S3PlayersStore(
            bucket=settings.releases_bucket,
            prefix=settings.releases_prefix,
            ttl_seconds=settings.releases_cache_ttl_seconds,
        )
    return LocalPlayersStore(settings.releases_root)


def get_players_store() -> PlayersStore:
    """FastAPI dependency. Overridden in tests with a fixture-backed one."""
    return _build_store(get_settings())
