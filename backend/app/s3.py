"""Reading ModelRelease artifacts from S3, with an in-process cache.

The cache is what makes a warm long-lived container the right shape for this
app (DESIGN.md section 7): releases change at most once a day, so almost every
request should be served from memory.

Staleness is bounded two ways. A TTL keeps us from calling S3 on every request,
and once the TTL lapses we re-check with a conditional GET rather than
re-downloading -- S3 answers 304 when the object hasn't moved, which is the
common case. Several tasks converge on a new release within one TTL of it being
written without any shared state, cache-bust endpoint or sticky routing.
"""

import threading
import time
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.exceptions import ClientError

from app.releases import ReleaseNotFound, parse_release
from app.schema import ModelRelease

# S3 answers a matching If-None-Match with 304, which botocore raises rather
# than returns. It surfaces under more than one code depending on the path.
_NOT_MODIFIED = {"304", "NotModified"}


@dataclass
class _Cached:
    release: ModelRelease
    etag: str
    checked_at: float


@dataclass
class _CachedListing:
    names: list[str]
    checked_at: float


class S3ReleaseStore:
    """Reads `{prefix}{league}/{model}/latest.json` out of a bucket.

    Safe to share across threads: FastAPI runs sync endpoints in a threadpool,
    so several requests can land here at once.
    """

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
        self._releases: dict[tuple[str, str], _Cached] = {}
        self._listings: dict[str, _CachedListing] = {}

    # -- listing ---------------------------------------------------------

    def list_leagues(self) -> list[str]:
        return self._list_common_prefixes(self._prefix)

    def list_models(self, league: str) -> list[str]:
        return self._list_common_prefixes(f"{self._prefix}{league}/")

    def _list_common_prefixes(self, prefix: str) -> list[str]:
        """The directory-ish names one level under `prefix`.

        Delimited so S3 returns the ~handful of child prefixes rather than
        every object beneath them.
        """
        with self._lock:
            hit = self._listings.get(prefix)
            if hit is not None and not self._expired(hit.checked_at):
                return list(hit.names)

        names: list[str] = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(
            Bucket=self._bucket, Prefix=prefix, Delimiter="/"
        ):
            for entry in page.get("CommonPrefixes", []):
                names.append(entry["Prefix"][len(prefix) :].rstrip("/"))
        names.sort()

        with self._lock:
            self._listings[prefix] = _CachedListing(names, time.monotonic())
        return list(names)

    # -- releases --------------------------------------------------------

    def get_latest(self, league: str, model: str) -> ModelRelease:
        key = f"{self._prefix}{league}/{model}/latest.json"
        cache_key = (league, model)

        with self._lock:
            hit = self._releases.get(cache_key)
        if hit is not None and not self._expired(hit.checked_at):
            return hit.release

        try:
            response = self._get_object(key, if_none_match=hit.etag if hit else None)
        except _NotModifiedError:
            # Still current. Restamp so the next TTL window starts now rather
            # than re-checking on every subsequent request.
            assert hit is not None
            with self._lock:
                hit.checked_at = time.monotonic()
            return hit.release

        # Deliberately outside the cache write below: an unreadable object is
        # never cached, so fixing the artifact takes effect on the next
        # request rather than after the TTL. The cost is one GET per request
        # while it stays broken, which at a handful of models is fine.
        release = parse_release(response["Body"].read(), league, model)
        with self._lock:
            self._releases[cache_key] = _Cached(
                release=release,
                etag=response.get("ETag", ""),
                checked_at=time.monotonic(),
            )
        return release

    def _get_object(self, key: str, if_none_match: str | None) -> Any:
        kwargs: dict[str, Any] = {"Bucket": self._bucket, "Key": key}
        if if_none_match:
            kwargs["IfNoneMatch"] = if_none_match
        try:
            return self._client.get_object(**kwargs)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if code in _NOT_MODIFIED or status == 304:
                raise _NotModifiedError from exc
            if code in ("NoSuchKey", "404", "NoSuchBucket"):
                raise ReleaseNotFound(
                    f"no release at s3://{self._bucket}/{key}"
                ) from exc
            raise

    def _expired(self, checked_at: float) -> bool:
        return (time.monotonic() - checked_at) >= self._ttl


class _NotModifiedError(Exception):
    """S3 said 304 -- the cached copy is still current."""
