"""Rolling runs up into job health, and serving it.

The fixtures are re-based to now by `LocalJobsSource` (DESIGN.md section 12),
so these assert relationships -- which job sorts first, which rate is None --
rather than timestamps, which is also what keeps them from expiring a week
after they were written.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.jobs import (
    JobRun,
    JobsUnavailable,
    LocalJobsSource,
    RunWindow,
    Volume,
    classify,
    get_jobs_source,
    summarize,
)
from app.main import create_app

NOW = datetime(2026, 8, 22, 13, 0, tzinfo=UTC)


def run(
    definition: str,
    status: str,
    *,
    hours_ago: float = 0,
    job_id: str | None = None,
) -> JobRun:
    created = NOW - timedelta(hours=hours_ago)
    return JobRun(
        job_id=job_id or f"{definition}-{hours_ago}",
        name=f"{definition}-scheduled-run",
        definition=definition,
        status=status,
        created_at=created,
        started_at=created + timedelta(seconds=90),
        stopped_at=(
            created + timedelta(minutes=6)
            if status in ("SUCCEEDED", "FAILED")
            else None
        ),
    )


class TestClassify:
    def test_games_jobs_carry_the_ncaabb_gender(self) -> None:
        assert classify("daily-games-mens") == ("games", "mens")
        assert classify("daily-games-nfl") == ("games", "nfl")

    def test_odds_jobs_carry_the_league(self) -> None:
        # The other half of the same league's data is keyed `mens`/`womens`.
        # Nothing here tries to join them.
        assert classify("odds-ncaabb") == ("odds", "ncaabb")

    def test_an_unknown_job_still_appears(self) -> None:
        # A job added to the queue upstream should show up as itself rather
        # than be dropped for not matching a naming convention.
        assert classify("invisible-string-refresh") == ("other", None)


class TestSummarize:
    def test_groups_by_definition_not_by_run_name(self) -> None:
        health = summarize(
            [run("odds-nfl", "SUCCEEDED"), run("odds-nfl", "FAILED", hours_ago=1)]
        )
        assert [h.name for h in health] == ["odds-nfl"]
        assert health[0].runs == 2

    def test_rate_counts_only_terminal_runs(self) -> None:
        health = summarize(
            [
                run("odds-nfl", "RUNNING"),
                run("odds-nfl", "SUCCEEDED", hours_ago=1),
                run("odds-nfl", "FAILED", hours_ago=2),
            ]
        )[0]
        assert (health.succeeded, health.failed, health.running) == (1, 1, 1)
        assert health.success_rate == pytest.approx(0.5)

    def test_rate_is_none_when_nothing_finished(self) -> None:
        # Not 0.0: a job that hasn't finished a run yet and a job that failed
        # every attempt must not render as the same number.
        health = summarize([run("odds-nfl", "RUNNING")])[0]
        assert health.success_rate is None
        assert health.failed == 0

    def test_last_run_is_the_newest_and_last_success_skips_failures(self) -> None:
        health = summarize(
            [
                run("daily-games-mens", "FAILED", hours_ago=0, job_id="new"),
                run("daily-games-mens", "SUCCEEDED", hours_ago=24, job_id="old"),
            ]
        )[0]
        assert health.last_run is not None
        assert health.last_run.job_id == "new"
        assert health.last_success_at == NOW - timedelta(hours=24) + timedelta(
            minutes=6
        )

    def test_broken_now_sorts_above_broken_earlier_sorts_above_healthy(self) -> None:
        health = summarize(
            [
                run("aaa-healthy", "SUCCEEDED"),
                run("bbb-recovered", "SUCCEEDED"),
                run("bbb-recovered", "FAILED", hours_ago=24),
                run("zzz-broken", "FAILED"),
            ]
        )
        # Alphabetically this is the exact reverse, so the order can only come
        # from severity.
        assert [h.name for h in health] == [
            "zzz-broken",
            "bbb-recovered",
            "aaa-healthy",
        ]

    def test_recent_is_capped(self) -> None:
        health = summarize(
            [run("odds-nfl", "SUCCEEDED", hours_ago=i) for i in range(20)], recent=3
        )[0]
        assert health.runs == 20
        assert len(health.recent) == 3
        # Newest first, so the cap keeps the runs worth looking at.
        assert health.recent[0].created_at > health.recent[-1].created_at

    def test_duration_ignores_queue_wait(self) -> None:
        one = run("odds-nfl", "SUCCEEDED")
        assert one.started_at is not None and one.stopped_at is not None
        # 6 minutes from created, minus the 90s it spent RUNNABLE.
        assert one.duration_seconds == pytest.approx(
            (one.stopped_at - one.started_at).total_seconds()
        )
        assert one.duration_seconds == pytest.approx(270.0)


class TestLocalSource:
    def test_rebases_the_fixture_onto_now(self, jobs_source: LocalJobsSource) -> None:
        # The committed file is dated; a seven-day window would otherwise stop
        # containing it a week after anyone touched it.
        window = jobs_source.runs(7)
        newest = max(r.created_at for r in window.runs)
        assert (datetime.now(UTC) - newest) < timedelta(seconds=5)

    def test_keeps_the_spacing_between_runs(self, jobs_source: LocalJobsSource) -> None:
        mens = [
            r for r in jobs_source.runs(7).runs if r.definition == "daily-games-mens"
        ]
        gaps = sorted(
            {
                round((a.created_at - b.created_at).total_seconds() / 3600)
                for a, b in zip(
                    sorted(mens, key=lambda r: r.created_at)[1:],
                    sorted(mens, key=lambda r: r.created_at),
                )
            }
        )
        assert gaps == [24]

    def test_window_excludes_older_runs(self, jobs_source: LocalJobsSource) -> None:
        assert len(jobs_source.runs(1).runs) < len(jobs_source.runs(7).runs)

    def test_missing_files_are_empty_not_an_error(self, tmp_path: Path) -> None:
        source = LocalJobsSource(tmp_path)
        assert source.runs(7).runs == []
        assert source.runs(7).truncated is False
        assert source.volume(7).odds == []
        assert source.volume(7).seasons == []

    def test_unreadable_files_are_an_error(self, tmp_path: Path) -> None:
        (tmp_path / "jobs").mkdir()
        (tmp_path / "jobs" / "runs.json").write_text("{ not json")
        with pytest.raises(JobsUnavailable):
            LocalJobsSource(tmp_path).runs(7)


class TestEndpoints:
    def test_jobs_lists_every_job_worst_first(self, client: TestClient) -> None:
        body = client.get("/api/jobs").json()
        assert body["window_days"] == 7
        assert body["truncated"] is False
        assert body["jobs"][0]["name"] == "daily-games-mens"
        assert body["jobs"][0]["last_run"]["status"] == "FAILED"
        assert body["jobs"][0]["last_run"]["status_reason"]

    def test_a_running_job_is_neither_success_nor_failure(
        self, client: TestClient
    ) -> None:
        jobs = {j["name"]: j for j in client.get("/api/jobs").json()["jobs"]}
        assert jobs["odds-nfl"]["running"] == 1
        assert jobs["odds-nfl"]["success_rate"] == pytest.approx(1.0)

    def test_volume_carries_counts_and_sizes(self, client: TestClient) -> None:
        body = client.get("/api/jobs/volume").json()
        nfl = [o for o in body["odds"] if o["league"] == "nfl"]
        assert nfl and all(o["pulls"] > 0 for o in nfl)
        # A succeeding job that pulls nothing is the case the counts exist for.
        ncaabb = [o for o in body["odds"] if o["league"] == "ncaabb"]
        assert 0 in [
            o["latest_records"] for o in ncaabb if o["latest_records"] is not None
        ]
        assert {s["artifact"] for s in body["seasons"]} == {
            "games",
            "possessions",
            "box_scores",
        }

    def test_window_is_capped_rather_than_clamped(self, client: TestClient) -> None:
        # Answering with a week of runs under a monthly heading would be worse
        # than refusing (DESIGN.md section 12.3).
        assert client.get("/api/jobs", params={"days": 30}).status_code == 422
        assert client.get("/api/jobs", params={"days": 1}).status_code == 200

    def test_an_unreadable_upstream_is_a_502(self, client: TestClient) -> None:
        class Broken:
            def runs(self, days: int) -> RunWindow:
                raise JobsUnavailable("could not read batch: AccessDeniedException")

            def volume(self, days: int) -> Volume:
                raise JobsUnavailable("could not read s3: AccessDenied")

        app = create_app()
        app.dependency_overrides[get_jobs_source] = Broken
        broken = TestClient(app)

        # Not a 500 (this app is fine) and not an empty 200 (which would claim
        # the jobs are healthy).
        assert broken.get("/api/jobs").status_code == 502
        assert broken.get("/api/jobs/volume").status_code == 502

    def test_the_two_halves_fail_independently(self, client: TestClient) -> None:
        class HalfBroken:
            def __init__(self, good: LocalJobsSource) -> None:
                self._good = good

            def runs(self, days: int) -> RunWindow:
                raise JobsUnavailable("could not read batch: ThrottlingException")

            def volume(self, days: int) -> Volume:
                return self._good.volume(days)

        from tests.conftest import FIXTURES

        app = create_app()
        app.dependency_overrides[get_jobs_source] = lambda: HalfBroken(
            LocalJobsSource(FIXTURES)
        )
        half = TestClient(app)

        assert half.get("/api/jobs").status_code == 502
        assert half.get("/api/jobs/volume").status_code == 200
