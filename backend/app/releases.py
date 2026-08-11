"""Reading ModelRelease artifacts, and picking which one is the default.

The store is a Protocol so tests can inject a fake through FastAPI's
`dependency_overrides` instead of standing up S3. The S3-backed
implementation, and the cache in front of it, land in a later change.
"""

import json
import logging
from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from pydantic import ValidationError

from app.schema import ModelRelease
from app.settings import Settings, get_settings

log = logging.getLogger(__name__)


class ReleaseNotFound(LookupError):
    """No release exists for the requested league/model."""


class ReleaseUnreadable(ValueError):
    """A release object exists but doesn't match the current schema.

    Distinct from ReleaseNotFound because the two want opposite responses: a
    missing model is a 404, a *stale* one is the bucket and the code having
    drifted apart, and telling someone "not found" about an object that is
    plainly sitting there sends them looking in the wrong place.

    In practice this means an artifact written before a cassandra rev bump.
    Renaming `spread_calibration` to `margin_calibration` did exactly this to
    every release published before it.
    """


def parse_release(raw: str | bytes, league: str, model: str) -> ModelRelease:
    """Validate one artifact, naming which one when it doesn't validate.

    Both stores go through here so the failure looks the same locally and in
    S3, and so pydantic's error never escapes as a bare 500.
    """
    try:
        return ModelRelease.model_validate(json.loads(raw))
    except (ValidationError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ReleaseUnreadable(
            f"{league}/{model} does not match the current ModelRelease schema"
        ) from exc


class ReleaseStore(Protocol):
    def list_leagues(self) -> list[str]: ...

    def list_models(self, league: str) -> list[str]: ...

    def get_latest(self, league: str, model: str) -> ModelRelease: ...


def pick_default(releases: Sequence[ModelRelease]) -> ModelRelease:
    """The release a league shows by default: the lowest Brier score.

    Brier is an *error* measure, so this is a min, not a max. Worth being
    deliberate about, because getting it backwards surfaces the worst model on
    the front page and looks entirely plausible while doing it. Note also that
    cassandra's `optimize.py` maximizes negative Brier, so a `target` copied
    from a PredictorConfig arrives already negated -- this reads
    `metrics.brier_score`, which is the un-negated value.

    Ties break on run_id so the choice is stable across calls.
    """
    if not releases:
        raise ReleaseNotFound("no releases to pick a default from")
    return min(releases, key=lambda r: (r.metrics.brier_score, r.run_id))


class LocalReleaseStore:
    """Reads releases from a directory laid out the way the S3 bucket is.

    `<root>/models/<league>/<model>/latest.json`
    """

    def __init__(self, root: Path) -> None:
        self._models_dir = root / "models"

    def list_leagues(self) -> list[str]:
        if not self._models_dir.is_dir():
            return []
        return sorted(p.name for p in self._models_dir.iterdir() if p.is_dir())

    def list_models(self, league: str) -> list[str]:
        league_dir = self._models_dir / league
        if not league_dir.is_dir():
            return []
        return sorted(
            p.name for p in league_dir.iterdir() if (p / "latest.json").is_file()
        )

    def get_latest(self, league: str, model: str) -> ModelRelease:
        path = self._models_dir / league / model / "latest.json"
        try:
            raw = path.read_text()
        except FileNotFoundError as exc:
            raise ReleaseNotFound(f"no release for {league}/{model}") from exc
        return parse_release(raw, league, model)


def latest_releases(store: ReleaseStore, league: str) -> list[ModelRelease]:
    """Every model's *readable* current release, in Brier order (best first).

    One bad object must not take down the league. Before this skipped, a single
    artifact left over from an older schema turned `/api/leagues` -- the index
    for every league -- into a 500, because the validation error escaped from
    the middle of a list comprehension. Degrading to "that model is missing" is
    the behavior worth having; the log line is where the detail goes.
    """
    releases: list[ModelRelease] = []
    unreadable: list[str] = []

    for model in store.list_models(league):
        try:
            releases.append(store.get_latest(league, model))
        except ReleaseNotFound:
            # Listed a moment ago and gone now, or never written. Not an error
            # worth failing the whole league over either.
            continue
        except ReleaseUnreadable as exc:
            log.warning("skipping unreadable release: %s", exc)
            unreadable.append(model)

    if not releases:
        # Only claim "not found" when nothing is there. If objects exist and
        # every one of them is stale, say so -- that's a different problem with
        # a different fix, and it's the one that follows a rev bump.
        if unreadable:
            raise ReleaseUnreadable(
                f"every release for league {league!r} is unreadable: "
                f"{', '.join(sorted(unreadable))}"
            )
        raise ReleaseNotFound(f"no releases for league {league!r}")

    return sorted(releases, key=lambda r: (r.metrics.brier_score, r.run_id))


@lru_cache(maxsize=1)
def _build_store(settings: Settings) -> ReleaseStore:
    """S3 when a bucket is configured, otherwise the local directory.

    Cached, because the S3 store holds the release cache -- rebuilding it per
    request would throw that away and call S3 every time.
    """
    if settings.releases_bucket:
        # Imported here rather than at module scope: app.s3 imports
        # ReleaseNotFound from this module, and boto3 is a slow import that
        # local-only runs shouldn't pay for.
        from app.s3 import S3ReleaseStore

        return S3ReleaseStore(
            bucket=settings.releases_bucket,
            prefix=settings.releases_prefix,
            ttl_seconds=settings.releases_cache_ttl_seconds,
        )
    return LocalReleaseStore(settings.releases_root)


def get_release_store() -> ReleaseStore:
    """FastAPI dependency. Overridden in tests with a fake."""
    return _build_store(get_settings())
