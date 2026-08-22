import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { renderApp } from "../../test/render";
import { server } from "../../test/server";
import { JobsPage } from "./JobsPage";

const rows = async () => {
  const table = (await screen.findAllByRole("table"))[0];
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent ?? "");
};

describe("JobsPage", () => {
  it("puts the broken jobs first", async () => {
    renderApp(<JobsPage />, { route: "/jobs" });

    const order = await rows();
    // Alphabetically odds-* would come last, so this order can only come from
    // severity: failing now, failed earlier, then the healthy ones.
    expect(order[0]).toContain("daily-games-mens");
    expect(order[1]).toContain("daily-games-womens");
    expect(order.slice(2).every((row) => row.includes("odds-"))).toBe(true);
  });

  it("shows why the currently-broken job broke", async () => {
    renderApp(<JobsPage />, { route: "/jobs" });

    expect(await screen.findByText(/ESPN returned 503/)).toBeInTheDocument();
    // The womens job failed earlier in the window and recovered. Its reason is
    // history, and showing it would read as a second alarm.
    expect(screen.queryByText(/Essential container/)).toBeNull();
  });

  it("counts a run in flight as neither success nor failure", async () => {
    renderApp(<JobsPage />, { route: "/jobs" });

    const running = (await rows()).find((text) => text.includes("odds-ncaabb"));
    // Nothing has finished, so there is no rate to show -- and 0% would be
    // the one wrong thing to say (DESIGN.md section 12.3).
    expect(running).toContain("—");
    expect(running).toContain("no runs yet");
  });

  it("summarizes the window above the table", async () => {
    renderApp(<JobsPage />, { route: "/jobs" });

    const meta = await screen.findByTestId("jobs-meta");
    expect(meta).toHaveTextContent("4 jobs");
    expect(meta).toHaveTextContent("last 7 days");
    expect(meta).toHaveTextContent("1 job failing");
  });

  it("asks for a different window when you pick one", async () => {
    const user = userEvent.setup();
    renderApp(<JobsPage />, { route: "/jobs" });
    await screen.findByTestId("jobs-meta");

    await user.selectOptions(screen.getByLabelText("Window"), "1");

    await waitFor(() =>
      expect(screen.getByTestId("jobs-meta")).toHaveTextContent("last 1 day"),
    );
  });

  it("says zero odds rather than nothing at all", async () => {
    renderApp(<JobsPage />, { route: "/jobs" });

    // An odds job in the offseason succeeds every hour and brings back
    // nothing; the exit code alone would call that healthy.
    expect(await screen.findByText("0 odds")).toBeInTheDocument();
    expect(await screen.findByText("61 odds")).toBeInTheDocument();
  });

  it("sizes season files without calling them counts", async () => {
    renderApp(<JobsPage />, { route: "/jobs" });

    expect(await screen.findByText("18.5 MB")).toBeInTheDocument();
    expect(screen.getByText(/Sizes, not game counts/)).toBeInTheDocument();
  });

  it("keeps the volume tables when Batch is unreadable", async () => {
    // The two halves read different upstreams and fail independently
    // (DESIGN.md section 12.1), so half a dashboard beats none.
    server.use(
      http.get("/api/jobs", () =>
        HttpResponse.json({ detail: "could not read batch" }, { status: 502 }),
      ),
    );
    renderApp(<JobsPage />, { route: "/jobs" });

    expect(
      await screen.findByText(/Job history is unavailable/),
    ).toBeInTheDocument();
    expect(await screen.findByText("18.5 MB")).toBeInTheDocument();
  });

  it("keeps the job table when the bucket is unreadable", async () => {
    server.use(
      http.get("/api/jobs/volume", () =>
        HttpResponse.json({ detail: "could not read s3" }, { status: 502 }),
      ),
    );
    renderApp(<JobsPage />, { route: "/jobs" });

    expect(
      await screen.findByText(/Data volume is unavailable/),
    ).toBeInTheDocument();
    expect(await screen.findByText("daily-games-mens")).toBeInTheDocument();
  });
});
