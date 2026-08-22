import { useState } from "react";

import { useGetJobVolumeQuery, useGetJobsQuery } from "../../services/api";
import { DataVolume } from "./DataVolume";
import { JobHealthTable } from "./JobHealthTable";
import { count } from "./format";

/**
 * Batch keeps completed job records for about a week (DESIGN.md §12.3), so
 * these are the windows there's data for. A day is "did last night work",
 * a week is "is this job flaky".
 */
const WINDOWS = [1, 3, 7];
const DEFAULT_WINDOW = 7;

/**
 * How the jobs upstream of every release are doing.
 *
 * Local state rather than a slice: nothing outside this page reads the window,
 * and a window that outlived the page would mean coming back to a dashboard
 * showing yesterday's question.
 */
export function JobsPage() {
  const [days, setDays] = useState(DEFAULT_WINDOW);
  const jobs = useGetJobsQuery({ days });
  const volume = useGetJobVolumeQuery({ days });

  const failing = (jobs.data?.jobs ?? []).filter(
    (job) => job.last_run?.status === "FAILED",
  );

  return (
    <section className="jobs-page">
      <h2>Job health</h2>

      <div className="controls">
        <label>
          Window
          <select
            aria-label="Window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {WINDOWS.map((option) => (
              <option key={option} value={option}>
                {count(option, "day")}
              </option>
            ))}
          </select>
        </label>
      </div>

      {jobs.data && (
        <p className="meta" data-testid="jobs-meta">
          {count(jobs.data.jobs.length, "job")} &middot; last{" "}
          {count(jobs.data.window_days, "day")} &middot;{" "}
          {failing.length === 0
            ? "all green"
            : `${count(failing.length, "job")} failing`}
          {/* A truncated window makes every rate below it a sample rather
              than a total, which is worth saying where the rates are. */}
          {jobs.data.truncated && " · partial window"}
        </p>
      )}

      {jobs.isError ? (
        <p className="error">
          Job history is unavailable &mdash; the API couldn&rsquo;t read the
          Batch queue.
        </p>
      ) : jobs.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : (
        <JobHealthTable jobs={jobs.data?.jobs ?? []} />
      )}

      {/* Rendered even when the jobs half failed: the two read different
          upstreams and fail independently (DESIGN.md §12.1), and half a
          dashboard beats none. */}
      {volume.isError ? (
        <p className="error">
          Data volume is unavailable &mdash; the API couldn&rsquo;t list the
          bucket.
        </p>
      ) : volume.isLoading ? (
        <p className="loading">Loading&hellip;</p>
      ) : (
        <DataVolume
          odds={volume.data?.odds ?? []}
          seasons={volume.data?.seasons ?? []}
          days={days}
        />
      )}
    </section>
  );
}
