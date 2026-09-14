"""Builds the metric distributions the game page labels its numbers against.

`app.distributions` reads the artifact; this writes it. One league at a time:

    python -m app.build_distributions --league nfl

It walks the last five seasons of endgame's processed play-by-play, scores
every game in them, and reduces each metric to the 101 checkpoints the page
interpolates through. The output lands at `<out>/distributions/{league}.json`,
which is where `LocalDistributionStore` reads it from -- so a local run is
immediately visible on a local page, and publishing to the bucket is a copy.

**Every metric goes through `curve_for`, the same function the game page
calls.** That is the whole correctness argument for this file. A generator
that computed EPA per play its own way -- even a way that was defensible on
its own -- would be measuring a population of one quantity and labelling a
different one, and the two would drift apart silently on the next upstream
change. Scoring a game here costs what scoring it for a page costs, and the
run is offline, so there is nothing to buy by being clever about it.

**The population is the team-game.** Each game contributes two observations to
every metric, one per side, because that is what these metrics are *of*: an
offense's EPA per play, a side's share of the game. Any metric added below has
to answer the same question about itself before it goes in.

**Five seasons, from whatever the bucket has.** The window is a count rather
than a range so a rebuild in any year does the right thing, and it is counted
over the season partitions that actually exist rather than off the calendar --
a league whose newest season hasn't been processed yet should reach back five
processed seasons, not four and an empty one.

What this deliberately does not do is publish. It writes a file and stops:

    bucket="$(cd infra && terraform output -raw artifacts_bucket)"
    aws s3 cp <out>/distributions/nfl.json \\
      "s3://$bucket/distributions/nfl.json" --content-type application/json

Kept out of `seed-artifacts.sh` rather than added to it, and not because
publishing is hard. That script's default source is the committed fixtures,
whose distributions are *synthetic* -- shapes invented to give the tests a
realistic curve. A flag on it would make "publish the golden fixtures" one
keystroke away from putting made-up percentiles on the live site, and a
percentile is exactly the kind of label nobody would think to doubt. Building
a distribution from a decade of plays and putting it where the site reads
from stay two things a person does on purpose.
"""

import argparse
import json
import logging
import sys
from collections import defaultdict
from collections.abc import Callable, Iterator, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from lucky_ones.plays import Play

from app.distributions import (
    CHECKPOINTS,
    LeagueDistributions,
    MetricDistribution,
)
from app.plays import in_game_order
from app.processed_plays import PREFIX, week_key
from app.settings import get_settings
from app.win_probability import Curve, curve_for, fit_for

log = logging.getLogger(__name__)

# How many seasons back the population reaches. Five, because the rules move
# underneath these metrics on a longer horizon than that -- see
# `app.distributions` -- and because a page comparing tonight against 2009 is
# answering a question nobody asked.
DEFAULT_SEASONS = 5

# The fewest observations worth publishing a shape from. A hundred checkpoints
# off thirty games is a hundred numbers that look authoritative and are noise,
# and a percentile is exactly the kind of label a reader takes at face value.
# Below this the metric is left out of the artifact and the page renders that
# number unlabelled, which is the honest outcome.
MIN_SAMPLES = 200

# What one observation is. On the wire in every metric, because `n` on its own
# cannot say whether a metric was sampled once a game or once a side.
UNIT = "team-game"


def _epa(curve: Curve) -> tuple[float | None, float | None]:
    """Each offense's expected points added per snap, garbage-time weighted.

    The weighted number rather than the flat one, because that is the column
    the page labels: the flat one is explicitly an estimate of the *team*
    rather than of this game, and a per-game percentile against it would
    answer a question that column isn't asking.

    Upstream's own None -- an offense with nothing to average -- passes
    through as None and is dropped from the sample rather than counted as a
    zero, which would be a real EPA.
    """
    if curve.epa is None:
        return (None, None)
    return (curve.epa.home, curve.epa.away)


def _control(curve: Curve) -> tuple[float | None, float | None]:
    """Each side's share of the game held.

    The realized curve rather than the bounce-adjusted one, for the same
    reason the page leads with it: it is what happened. The two sides sum to
    1, so this population is symmetric about 0.5 by construction whatever the
    seasons in it looked like -- which is worth knowing when reading a
    percentile off it, and is why the median is not an interesting fact about
    the league.
    """
    if curve.control is None:
        return (None, None)
    return (curve.control.home, curve.control.away)


# The metrics this builds, and how each is read off a scored game. Adding one
# is a line here plus a page that renders it -- and an answer to "what is one
# observation of this", which for everything so far is one side of one game.
METRICS: Mapping[str, Callable[[Curve], tuple[float | None, float | None]]] = {
    "epa_per_play": _epa,
    "game_control": _control,
}


class WeekSource(Protocol):
    """Where a league's processed play-by-play is read from, in bulk.

    Deliberately not `app.plays.PlaysSource`. That one answers for a single
    game by partition, which is what a page needs and what its whole design is
    tuned for -- a filtered read of a footer-indexed object. This reads every
    play of every week, which is the opposite access pattern, and widening the
    serving protocol with a method the API would never call would be putting
    an offline job's needs into a request path.
    """

    def seasons(self, league: str) -> list[int]:
        """Every season with processed plays, oldest first."""
        ...

    def weeks(self, league: str, season: int) -> list[int]:
        """Every week of one season with processed plays, in order."""
        ...

    def plays(self, league: str, season: int, week: int) -> Sequence[Play]:
        """Every play of one league-week, in whatever order it was stored."""
        ...


def by_game(plays: Sequence[Play]) -> dict[str, list[Play]]:
    """A week's plays split into the games they belong to.

    Ordered per game before it goes anywhere near the fit, because that is the
    promise both serving sources make and the one `lucky_ones.state` reads
    against -- a game walked out of order scores a game that never happened.
    """
    grouped: dict[str, list[Play]] = defaultdict(list)
    for play in plays:
        grouped[play.game_id].append(play)
    return {game_id: in_game_order(rows) for game_id, rows in grouped.items()}


def observe(curve: Curve, into: dict[str, list[float]]) -> None:
    """Add one scored game's sides to the running samples.

    A side with no reading is dropped rather than counted. The distinction
    matters more than it sounds: a game where one offense never had the ball
    is not a game where that offense averaged zero, and folding the two
    together would pull every percentile toward the middle by exactly the
    number of games with a missing side.
    """
    for name, read in METRICS.items():
        for value in read(curve):
            if value is None:
                continue
            into[name].append(float(value))


def checkpoints(values: Sequence[float]) -> list[float]:
    """One metric's sample as the value at each percentile, 0 through 100.

    Linear interpolation between the order statistics, which is numpy's
    default and the inverse of what the page does between two checkpoints --
    so a value read back out lands where it went in.

    Non-decreasing by construction, which is what `MetricDistribution`
    validates on the way in. A sample with no spread at all comes back as 101
    copies of one number, and that is a legitimate artifact rather than a
    degenerate one: it says every game in five seasons scored the same, and
    the page's tie handling reads it as the middle.
    """
    import numpy as np

    quantiles = np.quantile(
        np.asarray(values, dtype=float),
        np.linspace(0.0, 1.0, CHECKPOINTS),
        method="linear",
    )
    # Rounded for the same reason the artifact is 101 points rather than the
    # whole sample: this is for saying "about the 80th", and seventeen digits
    # of float noise in a committed JSON file is a diff nobody can read.
    return [round(float(value), 6) for value in quantiles]


def build(
    league: str,
    seasons: Sequence[int],
    samples: Mapping[str, Sequence[float]],
    *,
    run_id: str | None = None,
    now: datetime | None = None,
    min_samples: int = MIN_SAMPLES,
) -> LeagueDistributions:
    """The artifact, validated on the way out.

    Through `LeagueDistributions` rather than `json.dump` of a dict, so a
    build that produced something the reader would refuse fails here -- where
    the person who ran it is watching -- rather than at the next page view.

    A metric below the floor is left out entirely, not carried with a small
    `n` for a caller to judge. The reader has no way to weigh that and the
    page has nowhere to say it, so the only honest version is a metric that
    isn't there and a number that renders unlabelled.
    """
    at = now or datetime.now(UTC)
    metrics: dict[str, MetricDistribution] = {}
    for name, values in sorted(samples.items()):
        if len(values) < min_samples:
            log.warning(
                "leaving %s out of %s: %d observations, below the %d needed to "
                "publish a shape",
                name,
                league,
                len(values),
                min_samples,
            )
            continue
        metrics[name] = MetricDistribution(
            unit=UNIT, n=len(values), values=checkpoints(values)
        )

    return LeagueDistributions(
        league=league,
        run_id=run_id or at.strftime("%Y%m%d-%H%M%S"),
        created_at=at,
        seasons=list(seasons),
        metrics=metrics,
    )


def collect(
    source: WeekSource, league: str, seasons: Sequence[int]
) -> dict[str, list[float]]:
    """Every game of those seasons, scored, as one sample per metric.

    Best-effort per week and per game, for the reason every reader of a
    foreign object in this app is: a week that won't open costs that week, a
    game the fit can't score costs that game, and neither is worth abandoning
    a five-season walk over. The counts go out at the end, because a run that
    quietly skipped half a season should not look like one that didn't.
    """
    fit = fit_for(league)
    if fit is None:
        raise LookupError(f"no win probability fit for {league}")

    samples: dict[str, list[float]] = {name: [] for name in METRICS}
    scored = 0
    skipped = 0

    for season in seasons:
        for week in source.weeks(league, season):
            try:
                plays = source.plays(league, season, week)
            except Exception:  # noqa: BLE001 - see the docstring
                log.warning(
                    "could not read %s %s week %s", league, season, week, exc_info=True
                )
                continue

            for game_id, rows in by_game(plays).items():
                try:
                    curve = curve_for(fit, rows)
                except Exception:  # noqa: BLE001 - see the docstring
                    skipped += 1
                    log.warning("could not score game %s", game_id, exc_info=True)
                    continue
                observe(curve, samples)
                scored += 1

        log.info("%s %s: %d games scored so far", league, season, scored)

    log.info(
        "%s: scored %d games over %s, skipped %d; %s",
        league,
        scored,
        _range(seasons),
        skipped,
        ", ".join(
            f"{name} n={len(values)}" for name, values in sorted(samples.items())
        ),
    )
    return samples


def recent_seasons(
    source: WeekSource, league: str, count: int = DEFAULT_SEASONS
) -> list[int]:
    """The newest `count` seasons the bucket actually has, oldest first.

    Off the partitions rather than off the calendar, so a rebuild in January
    doesn't reach back four processed seasons and one empty one.
    """
    return source.seasons(league)[-count:]


def _range(seasons: Sequence[int]) -> str:
    if not seasons:
        return "no seasons"
    if len(seasons) == 1:
        return str(seasons[0])
    return f"{seasons[0]}-{seasons[-1]}"


class LocalWeeks:
    """Reads the fixture tree `app.plays.LocalPlaysSource` reads one game of.

    `<root>/plays/{league}/{season}/{week}/{game_id}.json`, which is a file per
    game rather than the bucket's object per week -- so a "week" here is the
    directory, and reading one is reading every file in it. Same root as every
    other local source, so one env var points a local build at the fixtures.
    """

    def __init__(self, root: Path) -> None:
        self._dir = root / "plays"

    def seasons(self, league: str) -> list[int]:
        return sorted(
            int(entry.name)
            for entry in self._children(self._dir / league)
            if entry.name.isdigit()
        )

    def weeks(self, league: str, season: int) -> list[int]:
        return sorted(
            int(entry.name)
            for entry in self._children(self._dir / league / str(season))
            if entry.name.isdigit()
        )

    def plays(self, league: str, season: int, week: int) -> Sequence[Play]:
        from app.plays import FixturePlay

        found: list[Play] = []
        directory = self._dir / league / str(season) / str(week)
        for path in sorted(directory.glob("*.json")):
            raw = json.loads(path.read_text())
            found.extend(FixturePlay.model_validate(item) for item in raw)
        return found

    def _children(self, directory: Path) -> list[Path]:
        if not directory.is_dir():
            return []
        return [entry for entry in directory.iterdir() if entry.is_dir()]


class AwsWeeks:
    """Reads whole week objects out of endgame's processed play-by-play.

    The same objects `app.processed_plays` reads one game out of, and the same
    key layout -- built from `week_key` rather than spelled again here. What
    differs is the read: no `game_id` filter, so the whole object comes back,
    which is the point. A league-week is under a megabyte and this is an
    offline job, so there is nothing to prune for.

    The partitions are *listed* here, unlike in the serving path, because a
    build has no game to tell it which season and week to look in -- finding
    out what exists is half of what it does.
    """

    def __init__(self, bucket: str, client: Any | None = None) -> None:
        self._bucket = bucket
        self._client = client
        self._filesystem: Any | None = None

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3

            self._client = boto3.client("s3")
        return self._client

    @property
    def filesystem(self) -> Any:
        if self._filesystem is None:
            import pyarrow.fs as fs

            self._filesystem = fs.S3FileSystem()
        return self._filesystem

    def seasons(self, league: str) -> list[int]:
        return sorted(
            int(name.removeprefix("season="))
            for name in self._names(f"{PREFIX}/league={league}/")
            if name.startswith("season=") and name.removeprefix("season=").isdigit()
        )

    def weeks(self, league: str, season: int) -> list[int]:
        return sorted(
            int(name.removeprefix("week="))
            for name in self._names(f"{PREFIX}/league={league}/season={season}/")
            if name.startswith("week=") and name.removeprefix("week=").isdigit()
        )

    def plays(self, league: str, season: int, week: int) -> Sequence[Play]:
        import pyarrow.dataset as ds
        from lucky_ones.arrow import PLAY_COLUMNS, table_to_plays

        path = f"{self._bucket}/{week_key(league, season, week)}"
        dataset = ds.dataset(path, filesystem=self.filesystem, format="parquet")
        return table_to_plays(dataset.to_table(columns=list(PLAY_COLUMNS)))

    def _names(self, prefix: str) -> Iterator[str]:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(
            Bucket=self._bucket, Prefix=prefix, Delimiter="/"
        ):
            for entry in page.get("CommonPrefixes", []):
                yield entry["Prefix"][len(prefix) :].rstrip("/")


def source_for(bucket: str | None, root: Path) -> WeekSource:
    """The bucket when one is configured, otherwise the local tree.

    The same switch every other reader in this app makes, off the same
    setting -- `endgame_bucket`, because these are endgame's objects rather
    than ours.
    """
    return AwsWeeks(bucket) if bucket else LocalWeeks(root)


def write(artifact: LeagueDistributions, out: Path) -> Path:
    """`<out>/distributions/{league}.json`, where the store reads it from."""
    path = out / "distributions" / f"{artifact.league}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(artifact.model_dump_json() + "\n")
    return path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--league", required=True, help="e.g. nfl, ncaafb")
    parser.add_argument(
        "--seasons",
        type=int,
        default=DEFAULT_SEASONS,
        help=f"How many seasons back to read. Default {DEFAULT_SEASONS}.",
    )
    parser.add_argument(
        "--min-samples",
        type=int,
        default=MIN_SAMPLES,
        help=(
            "Fewest observations a metric needs to be published at all. "
            f"Default {MIN_SAMPLES}."
        ),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Where to write. Defaults to the releases root the app reads.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    settings = get_settings()
    source = source_for(settings.endgame_bucket, settings.releases_root)

    try:
        seasons = recent_seasons(source, args.league, args.seasons)
    except Exception:  # noqa: BLE001 - a listing against a bucket or a disk
        log.exception("could not list seasons for %s", args.league)
        return 1
    if not seasons:
        log.error("no processed play-by-play for %s", args.league)
        return 1

    try:
        samples = collect(source, args.league, seasons)
    except LookupError as exc:
        # A league with no win probability fit has none of these metrics, and
        # never will -- it is not a football league. Worth a word rather than
        # a traceback.
        log.error("%s", exc)
        return 1

    artifact = build(args.league, seasons, samples, min_samples=args.min_samples)
    if not artifact.metrics:
        log.error(
            "nothing to publish for %s: no metric reached %d observations",
            args.league,
            args.min_samples,
        )
        return 1

    path = write(artifact, args.out or settings.releases_root)
    log.info("wrote %s (%s)", path, ", ".join(sorted(artifact.metrics)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
