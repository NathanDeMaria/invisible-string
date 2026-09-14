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

from cassandra.predictor import QbOutIndex, UnknownPredictorClass, load_predictor_class
from cassandra.predictor.qb_out import QbOutFile
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


def parse_qb_out(raw: str | bytes, league: str) -> QbOutIndex:
    """The league's published quarterback index, as the models read it.

    `models/{league}/qb_out.json` is the same `QbOutFile` the sweep wrote
    and the football models were replayed with, published beside the
    league's models so that what a page says was true of a played game is
    what the model priced. Validated with cassandra's own schema, like a
    release, and for the same reason.
    """
    try:
        return QbOutIndex(QbOutFile.model_validate(json.loads(raw)).games)
    except (ValidationError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ReleaseUnreadable(
            f"{league}/qb_out.json does not match the current QbOutFile schema"
        ) from exc


class ReleaseStore(Protocol):
    def list_leagues(self) -> list[str]: ...

    def list_models(self, league: str) -> list[str]: ...

    def get_latest(self, league: str, model: str) -> ModelRelease: ...

    def get_qb_out(self, league: str) -> QbOutIndex:
        """Who was missing their quarterback, by game, for a league.

        Empty when the bucket has no index for the league -- which is every
        league but football, and football before a sweep has run. Empty is
        the index the models replay with in that case too, so the page and
        the number agree; what it must never be is empty *because the file
        was looked for on the wrong machine*. `QbOutIndex.for_league` reads
        `~/.cassandra`, and a container that called it told every page both
        quarterbacks had started for a month.
        """
        ...


def pick_default(releases: Sequence[ModelRelease]) -> ModelRelease:
    """The release a league shows by default: the lowest Brier score, among
    the releases this build can actually rebuild a predictor from.

    Brier is an *error* measure, so this is a min, not a max. Worth being
    deliberate about, because getting it backwards surfaces the worst model on
    the front page and looks entirely plausible while doing it. Note also that
    cassandra's `optimize.py` maximizes negative Brier, so a `target` copied
    from a PredictorConfig arrives already negated -- this reads
    `metrics.brier_score`, which is the un-negated value.

    Ties break on run_id so the choice is stable across calls.

    **A release naming a predictor class this build doesn't have is passed
    over.** cassandra ships new predictor classes before this image is
    rebuilt against them, and `latest.json` is rewritten nightly by whichever
    cassandra ran -- so a class that is one deploy newer than this build can
    win the Brier comparison and take the league's whole slate down with it.
    That is not hypothetical: it is what emptied every ncaafb prediction on
    2026-09-05, on a margin of 0.00013 Brier over a release this build could
    have served perfectly well.

    The alternative to declining is the one the consumer had before, which was
    no choice at all: `rating_predictor()` raises, and every caller downstream
    degrades to "no model for this league" -- a games page with no numbers on
    it, and a `/predict` that 502s. Falling back to the next-best release
    costs whatever the Brier gap is, and that gap is bounded by the fact that
    the skipped release won on it. A silent four-decimal-place downgrade is a
    much better failure than a league-wide outage.

    Only the *unbuildable* ones are skipped, and only for that reason. A
    release whose predictor rates nobody (`RatingsUnsupported` -- FlatPredictor
    is the case) is a real modelling result rather than version skew, and
    demoting it would be this function lying about which model scored best.
    """
    if not releases:
        raise ReleaseNotFound("no releases to pick a default from")

    ordered = sorted(releases, key=lambda r: (r.metrics.brier_score, r.run_id))
    for release in ordered:
        if _has_predictor_class(release):
            return release

    # Nothing here is buildable, so there is no downgrade to make and the
    # honest answer is the one the rule asks for. Every caller that needs a
    # predictor already handles this -- `/games` drops the league's
    # predictions, `/predict` 502s -- and the two that don't, `/leagues` and
    # `/ratings`, read the artifact's own ratings and are unaffected. Raising
    # instead would take a working leaderboard down over a model nobody asked
    # it to run.
    return ordered[0]


# The run_ids already warned about, so a league stuck in this state costs one
# log line rather than one per request. Same reason `_Models` in
# `app.api.games` keeps its own: the count is what made the first outage here
# slow to place, and a warning per request buries it just as well as silence.
_skipped: set[str] = set()


def _has_predictor_class(release: ModelRelease) -> bool:
    """Whether this build has the class `release` names, and can rebuild it.

    The class lookup rather than the full `rating_predictor()`: this runs on
    the way to serving a request, and rehydrating every candidate's ratings to
    find out is real work in front of every page. The lookup catches the case
    that actually happens -- a name this build has never heard of -- and the
    rarer "same class, different constructor signature" stays where it is
    already handled, one layer down, with the params in the log line.
    """
    try:
        load_predictor_class(release.predictor_class)
    except UnknownPredictorClass:
        if release.run_id not in _skipped:
            _skipped.add(release.run_id)
            log.warning(
                "passing over %s/%s (run %s): this build has no predictor "
                "class %r. Serving the next-best release instead; rebuild "
                "against a newer cassandra to get this one back.",
                release.league,
                release.model,
                release.run_id,
                release.predictor_class,
            )
        return False
    return True


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

    def get_qb_out(self, league: str) -> QbOutIndex:
        path = self._models_dir / league / "qb_out.json"
        try:
            raw = path.read_text()
        except FileNotFoundError:
            return QbOutIndex()
        return parse_qb_out(raw, league)


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


def resolve_release(
    store: ReleaseStore, league: str, model: str | None
) -> ModelRelease:
    """The release an endpoint should answer from.

    Named model, or the league's default. One definition so `/ratings` and
    `/predict` can never disagree about which run a caller is looking at --
    a matchup computed from a different release than the table beside it
    would be a very quiet kind of wrong.
    """
    if model:
        return store.get_latest(league, model)
    return pick_default(latest_releases(store, league))


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
