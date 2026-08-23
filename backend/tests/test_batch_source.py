"""The AWS source: Batch summaries in, job runs out; S3 listings in, volume out.

Batch is a stub client rather than moto, because moto's Batch wants a compute
environment and a docker daemon to hand back a job -- and what's worth testing
here is the translation, not AWS. The stub also makes the request itself
assertable, which matters for the one call whose shape this design leans on:
a single `AFTER_CREATED_AT`-filtered pass over the queue (DESIGN.md section
12.1). What no test here can check is that AWS agrees that filter exists; the
first real deploy is what confirms that.

S3 is moto, since listing semantics -- delimiters, common prefixes, `Size`,
ETags -- are exactly what the volume code is made of. The season pickles are
real ones, built from endgame's own `Season`/`Week`/`Game`: the counting code
unpickles a foreign object graph, and a stub of it would only prove that the
stub matched itself.
"""

import json
import pickle
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from endgame.ncaabb.ncaabb import Season
from endgame.types import Game, Week
from moto import mock_aws

from app.batch import JOB_TZ, MAX_RUN_PAGES, AwsJobsSource
from app.jobs import JobsUnavailable

BUCKET = "endgame-data"
QUEUE = "endgame-queue"


def summary(
    job_id: str,
    definition: str = "daily-games-nfl",
    status: str = "SUCCEEDED",
    *,
    hours_ago: float = 1,
    revision: int = 3,
    **overrides: Any,
) -> dict[str, Any]:
    created = datetime.now(UTC) - timedelta(hours=hours_ago)
    millis = int(created.timestamp() * 1000)
    return {
        "jobId": job_id,
        "jobName": f"{definition}-scheduled-run",
        "jobDefinition": (
            f"arn:aws:batch:us-east-2:123456789012:job-definition/{definition}:{revision}"
        ),
        "status": status,
        "createdAt": millis,
        "startedAt": millis + 90_000,
        "stoppedAt": millis + 400_000,
        **overrides,
    }


def game(day: datetime, *, completed: bool = True, gid: str = "g") -> Game:
    return Game(
        home="Duke",
        home_score=70 if completed else 0,
        away="UNC",
        away_score=68 if completed else 0,
        neutral_site=False,
        completed=completed,
        date=day,
        game_id=gid,
    )


def season_pickle(games: list[Game], year: int = 2026) -> bytes:
    """What `save_to_s3` writes: a pickled *list* of seasons."""
    return pickle.dumps([Season([Week(games, 1)], year)])


class StubBatch:
    """Hands back canned ListJobs pages and records what it was asked."""

    def __init__(self, *pages: dict[str, Any]) -> None:
        self._pages = list(pages)
        self.calls: list[dict[str, Any]] = []

    def list_jobs(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        # The last page repeats, so a test that wants "Batch never stops
        # paginating" just gives one page with a nextToken on it.
        index = min(len(self.calls) - 1, len(self._pages) - 1)
        return self._pages[index]


class BrokenBatch:
    def __init__(self, code: str = "AccessDeniedException") -> None:
        self._code = code

    def list_jobs(self, **kwargs: Any) -> dict[str, Any]:
        raise ClientError({"Error": {"Code": self._code}}, "ListJobs")


class CountingS3:
    """Passes everything through to moto, counting reads by key prefix.

    An ETag cache that silently isn't caching looks identical from the
    outside, so the calls are what's asserted rather than the values.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.gets: list[str] = []

    def gets_under(self, prefix: str) -> int:
        return sum(1 for key in self.gets if key.startswith(prefix))

    def get_object(self, **kwargs: Any) -> Any:
        self.gets.append(kwargs["Key"])
        return self._inner.get_object(**kwargs)

    def get_paginator(self, name: str) -> Any:
        return self._inner.get_paginator(name)


class DeniesGetsUnder:
    """Reads everything except one prefix, the way a missing grant would."""

    def __init__(self, inner: Any, prefix: str) -> None:
        self._inner = inner
        self._prefix = prefix

    def get_object(self, **kwargs: Any) -> Any:
        if kwargs["Key"].startswith(self._prefix):
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
        return self._inner.get_object(**kwargs)

    def get_paginator(self, name: str) -> Any:
        return self._inner.get_paginator(name)


@pytest.fixture
def s3() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-2")
        client.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-east-2"},
        )
        today = datetime.now(JOB_TZ).date()
        yesterday = today - timedelta(days=1)

        def put(key: str, body: bytes) -> None:
            client.put_object(Bucket=BUCKET, Key=key, Body=body)

        put(f"odds/ncaabb/{yesterday}/10-00.json", json.dumps([]).encode())
        put(
            f"odds/nfl/{yesterday}/13-00.json",
            json.dumps([{"g": 1}, {"g": 2}]).encode(),
        )
        # Last, so its LastModified is the largest in the bucket and "newest
        # pull in the window" can't come down to how moto breaks a tie.
        put(
            f"odds/nfl/{today}/14-00.json",
            json.dumps([{"g": i} for i in range(5)]).encode(),
        )

        # Naive datetimes, which is how endgame's game dates arrive.
        midnight = datetime.combine(today, datetime.min.time())
        put(
            "seasons/2026/mens.pkl",
            season_pickle(
                [
                    game(midnight.replace(hour=19), gid="today-1"),
                    game(midnight.replace(hour=21), gid="today-2"),
                    game(midnight - timedelta(days=3), gid="earlier"),
                    game(midnight - timedelta(days=30), gid="old"),
                    # Tonight's game, not played yet. It is in the file, and
                    # counting it would make an empty scrape look full.
                    game(midnight.replace(hour=23), completed=False, gid="upcoming"),
                ]
            ),
        )
        put("seasons/2026/nfl.pkl", season_pickle([game(midnight, gid="nfl-today")]))
        # Not pickles, and not games: these must not get a count.
        put("seasons/2026/mens.csv", b"x" * 1200)
        put("seasons/2026/mens_box.csv", b"x" * 300)
        put("seasons/2025/nfl.pkl", season_pickle([], year=2025))
        put("seasons/2024/nfl.pkl", season_pickle([], year=2024))
        yield client


def source(s3: Any, batch: Any, **kwargs: Any) -> AwsJobsSource:
    return AwsJobsSource(
        queue=QUEUE, bucket=BUCKET, batch_client=batch, s3_client=s3, **kwargs
    )


class TestRuns:
    def test_one_filtered_pass_covers_every_status(self, s3: Any) -> None:
        batch = StubBatch(
            {"jobSummaryList": [summary("a"), summary("b", status="FAILED")]}
        )
        window = source(s3, batch).runs(7)

        assert len(batch.calls) == 1
        assert batch.calls[0]["jobQueue"] == QUEUE
        # No jobStatus: passing a filter turns it off, which is the whole
        # reason this is one call rather than seven.
        assert "jobStatus" not in batch.calls[0]
        (job_filter,) = batch.calls[0]["filters"]
        assert job_filter["name"] == "AFTER_CREATED_AT"
        assert int(job_filter["values"][0]) == pytest.approx(
            int(window.since.timestamp() * 1000), abs=2000
        )
        assert {r.status for r in window.runs} == {"SUCCEEDED", "FAILED"}

    def test_reads_epoch_millis_and_drops_the_definition_revision(
        self, s3: Any
    ) -> None:
        batch = StubBatch({"jobSummaryList": [summary("a", revision=7)]})
        run = source(s3, batch).runs(7).runs[0]

        # A re-registered definition must not split one job's history in two.
        assert run.definition == "daily-games-nfl"
        assert run.created_at.tzinfo is not None
        assert run.duration_seconds == pytest.approx(310.0)

    def test_prefers_the_container_reason_over_the_schedulers(self, s3: Any) -> None:
        batch = StubBatch(
            {
                "jobSummaryList": [
                    summary(
                        "a",
                        status="FAILED",
                        statusReason="Essential container in task exited",
                        container={"exitCode": 1, "reason": "ESPN returned 503"},
                    )
                ]
            }
        )
        run = source(s3, batch).runs(7).runs[0]
        assert run.status_reason == "ESPN returned 503"
        assert run.exit_code == 1

    def test_falls_back_to_the_run_name_without_a_definition(self, s3: Any) -> None:
        batch = StubBatch({"jobSummaryList": [summary("a", jobDefinition=None)]})
        assert source(s3, batch).runs(7).runs[0].definition == "daily-games-nfl"

    def test_follows_the_next_token(self, s3: Any) -> None:
        batch = StubBatch(
            {"jobSummaryList": [summary("a")], "nextToken": "more"},
            {"jobSummaryList": [summary("b")]},
        )
        window = source(s3, batch).runs(7)

        assert len(window.runs) == 2
        assert batch.calls[1]["nextToken"] == "more"
        assert window.truncated is False

    def test_says_so_when_it_stops_paginating(self, s3: Any) -> None:
        endless = StubBatch({"jobSummaryList": [summary("a")], "nextToken": "more"})
        window = source(s3, endless).runs(7)

        assert len(endless.calls) == MAX_RUN_PAGES
        # The rates above a truncated window are over a sample, and the page
        # says so rather than quietly rounding a week down to a day.
        assert window.truncated is True

    def test_a_denied_call_is_not_an_empty_dashboard(self, s3: Any) -> None:
        with pytest.raises(JobsUnavailable, match="batch"):
            source(s3, BrokenBatch()).runs(7)

    def test_caches_within_the_ttl(self, s3: Any) -> None:
        batch = StubBatch({"jobSummaryList": [summary("a")]})
        jobs = source(s3, batch, ttl_seconds=60.0)

        jobs.runs(7)
        jobs.runs(7)
        assert len(batch.calls) == 1

        # A different window is a different question, so it goes back to Batch.
        jobs.runs(1)
        assert len(batch.calls) == 2

    def test_a_zero_ttl_always_re_reads(self, s3: Any) -> None:
        batch = StubBatch({"jobSummaryList": [summary("a")]})
        jobs = source(s3, batch, ttl_seconds=0.0)
        jobs.runs(7)
        jobs.runs(7)
        assert len(batch.calls) == 2


class TestVolume:
    def test_counts_pulls_and_bytes_per_league_day(self, s3: Any) -> None:
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(7)
        today = datetime.now(JOB_TZ).date()

        nfl_today = next(o for o in volume.odds if o.league == "nfl" and o.day == today)
        assert nfl_today.pulls == 1
        assert nfl_today.bytes > 0
        assert [o.league for o in volume.odds] == sorted(o.league for o in volume.odds)

    def test_opens_only_the_newest_pull_per_league(self, s3: Any) -> None:
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(7)

        counted = [o for o in volume.odds if o.latest_records is not None]
        assert {o.league for o in counted} == {"ncaabb", "nfl"}
        assert next(o for o in counted if o.league == "nfl").latest_records == 5
        # A league whose job succeeds and brings back nothing: zero records is
        # a real answer, not a missing one.
        assert next(o for o in counted if o.league == "ncaabb").latest_records == 0

    def test_days_are_the_ones_the_jobs_write(self, s3: Any) -> None:
        # endgame stamps odds keys with the Chicago date, so a UTC-built prefix
        # would ask for tomorrow's all evening and miss today's last pulls.
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(7)
        assert max(o.day for o in volume.odds) == datetime.now(JOB_TZ).date()

    def test_a_short_window_drops_older_days(self, s3: Any) -> None:
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(1)
        assert {o.day for o in volume.odds} == {datetime.now(JOB_TZ).date()}

    def test_names_season_artifacts_by_suffix(self, s3: Any) -> None:
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(7)
        mens = {s.artifact: s for s in volume.seasons if s.league == "mens"}

        assert set(mens) == {"games", "possessions", "box_scores"}
        assert mens["box_scores"].key == "seasons/2026/mens_box.csv"
        assert mens["games"].bytes > 0
        assert mens["games"].last_modified.tzinfo is not None

    def test_keeps_two_season_years_so_a_rollover_isnt_blank(self, s3: Any) -> None:
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(7)
        assert {s.year for s in volume.seasons} == {2026, 2025}

    def test_counts_games_in_the_season_file(self, s3: Any) -> None:
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(7)
        mens = next(
            s for s in volume.seasons if s.league == "mens" and s.artifact == "games"
        )

        # Everything in the file, tonight's unplayed game included: a season
        # file carries the whole schedule.
        assert mens.games == 5
        # Completed only, which is what "did last night's results land" means.
        assert mens.games_today == 2
        assert mens.games_in_window == 3

    def test_the_window_moves_the_recent_count(self, s3: Any) -> None:
        jobs = source(s3, StubBatch({"jobSummaryList": []}), ttl_seconds=0.0)
        week = next(
            s for s in jobs.volume(7).seasons if s.key == "seasons/2026/mens.pkl"
        )
        day = next(
            s for s in jobs.volume(1).seasons if s.key == "seasons/2026/mens.pkl"
        )

        # The game three days back drops out; the two from today stay.
        assert (week.games_in_window, day.games_in_window) == (3, 2)

    def test_rows_that_arent_games_dont_get_a_count(self, s3: Any) -> None:
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(7)
        csvs = [s for s in volume.seasons if s.artifact != "games"]

        assert csvs
        # Possessions and box-score rows are not games, and a number here
        # would be read as one.
        assert all(s.games is None for s in csvs)
        assert all(s.bytes > 0 for s in csvs)

    def test_reads_a_season_again_only_when_it_changes(self, s3: Any) -> None:
        counting = CountingS3(s3)
        jobs = source(counting, StubBatch({"jobSummaryList": []}), ttl_seconds=0.0)

        jobs.volume(7)
        after_first = counting.gets_under("seasons/")
        assert after_first > 0

        jobs.volume(7)
        # Same ETags, so the pickles aren't re-read -- which is what makes
        # counting affordable on a page someone leaves open.
        assert counting.gets_under("seasons/") == after_first
        # The odds side is unconditional, so it did keep working.
        assert counting.gets_under("odds/") > 0

        today = datetime.now(JOB_TZ).date()
        midnight = datetime.combine(today, datetime.min.time())
        s3.put_object(
            Bucket=BUCKET,
            Key="seasons/2026/mens.pkl",
            Body=season_pickle([game(midnight, gid="only-one")]),
        )

        recounted = next(
            s for s in jobs.volume(7).seasons if s.key == "seasons/2026/mens.pkl"
        )
        assert counting.gets_under("seasons/") > after_first
        assert recounted.games == 1

    def test_an_unreadable_season_keeps_its_row(self, s3: Any) -> None:
        # Written by something other than the games job, or by a version of it
        # whose classes have moved. The row is still worth showing.
        s3.put_object(Bucket=BUCKET, Key="seasons/2026/wnba.pkl", Body=b"not a pickle")
        volume = source(s3, StubBatch({"jobSummaryList": []})).volume(7)

        wnba = next(s for s in volume.seasons if s.league == "wnba")
        assert wnba.games is None
        assert wnba.bytes > 0
        # And the leagues that *could* be read still counted.
        assert next(s for s in volume.seasons if s.league == "nfl").games == 1

    def test_counts_wait_for_the_grant_without_taking_the_page_down(
        self, s3: Any
    ) -> None:
        # The IAM in section 12.2 lands after this ships, so until it does
        # every GetObject on seasons/ is denied. That must degrade to the
        # table this was before it could count, not to a 502.
        denied = DeniesGetsUnder(s3, "seasons/")
        volume = source(denied, StubBatch({"jobSummaryList": []})).volume(7)

        assert all(s.games is None for s in volume.seasons)
        assert all(s.bytes > 0 for s in volume.seasons)
        assert any(o.latest_records is not None for o in volume.odds)

    def test_a_denied_listing_is_not_an_empty_dashboard(self) -> None:
        class BrokenS3:
            def get_paginator(self, name: str) -> Any:
                raise ClientError({"Error": {"Code": "AccessDenied"}}, "ListObjectsV2")

        jobs = AwsJobsSource(
            queue=QUEUE,
            bucket=BUCKET,
            batch_client=StubBatch({"jobSummaryList": []}),
            s3_client=BrokenS3(),
        )
        with pytest.raises(JobsUnavailable, match="s3"):
            jobs.volume(7)
