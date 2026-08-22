import type { JobHealth } from "../../services/api";
import { ago, percent } from "./format";

interface Props {
  jobs: JobHealth[];
}

/**
 * One row per job definition, worst first.
 *
 * The order comes from the API (DESIGN.md §12.5) rather than from a sort here:
 * the page's whole job is to put the broken ones in front of you, and a table
 * that re-sorted on click would let you lose them.
 */
export function JobHealthTable({ jobs }: Props) {
  if (jobs.length === 0) {
    return <p className="empty">No runs in this window.</p>;
  }

  return (
    <table className="ratings jobs">
      <thead>
        <tr>
          <th scope="col">Job</th>
          <th scope="col" className="num">
            Last run
          </th>
          <th scope="col" className="num">
            Success
          </th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => {
          const last = job.last_run;
          const failing = last?.status === "FAILED";
          const terminal = job.succeeded + job.failed;

          return (
            <tr key={job.name} className={failing ? "failing" : undefined}>
              <td>
                <span className="job-name">{job.name}</span>
                {/* The reason only earns its line when the job is currently
                    broken. On a job that failed on Tuesday and has been fine
                    since, it's history, and it reads as an alarm. */}
                {failing && last?.status_reason && (
                  <span className="reason">{last.status_reason}</span>
                )}
              </td>
              <td className="num">
                <Status status={last?.status} />
                <span className="when">
                  {ago(last?.stopped_at ?? last?.created_at)}
                </span>
              </td>
              <td className="num">
                <span className="rate">{percent(job.success_rate)}</span>
                {/* The denominator is the point when it's small: "100%" off a
                    single run is not the same claim as "100%" off thirteen. */}
                <span className="of">
                  {terminal > 0
                    ? `${job.succeeded}/${terminal}`
                    : "no runs yet"}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Status as a word, not only a colour -- the failing row is the one thing on
 * this page that has to survive being read in greyscale.
 */
function Status({ status }: { status?: string }) {
  if (!status) return <span className="pill unknown">unknown</span>;
  if (status === "SUCCEEDED") return <span className="pill ok">ok</span>;
  if (status === "FAILED") return <span className="pill failed">failed</span>;
  return <span className="pill running">{status.toLowerCase()}</span>;
}
