"""Reading ModelRelease artifacts, and picking which one is the default.

The store is a Protocol so tests can inject a fake through FastAPI's
`dependency_overrides` instead of standing up S3. The S3-backed
implementation, and the cache in front of it, land in a later change.
"""

import json
from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from app.schema import ModelRelease
from app.settings import Settings, get_settings


class ReleaseNotFound(LookupError):
    """No release exists for the requested league/model."""


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
        return ModelRelease.model_validate(json.loads(raw))


def latest_releases(store: ReleaseStore, league: str) -> list[ModelRelease]:
    """Every model's current release for a league, in Brier order (best first)."""
    releases = [store.get_latest(league, m) for m in store.list_models(league)]
    if not releases:
        raise ReleaseNotFound(f"no releases for league {league!r}")
    return sorted(releases, key=lambda r: (r.metrics.brier_score, r.run_id))


@lru_cache(maxsize=1)
def _build_store(settings: Settings) -> ReleaseStore:
    return LocalReleaseStore(settings.releases_root)


def get_release_store() -> ReleaseStore:
    """FastAPI dependency. Overridden in tests with a fake."""
    return _build_store(get_settings())
