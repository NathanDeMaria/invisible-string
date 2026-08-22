import { describe, expect, it } from "vitest";

import { ago, count, percent, size } from "./format";

describe("ago", () => {
  const now = new Date("2026-08-22T12:00:00Z").getTime();
  const at = (iso: string) => ago(iso, now);

  it("changes unit rather than growing the number", () => {
    expect(at("2026-08-22T11:56:00Z")).toBe("4m ago");
    expect(at("2026-08-22T09:00:00Z")).toBe("3h ago");
    expect(at("2026-08-20T12:00:00Z")).toBe("2d ago");
  });

  it("says never rather than inventing a time", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago(undefined, now)).toBe("never");
    expect(ago("not a date", now)).toBe("never");
  });

  it("reads a clock skew as just now, not as negative time", () => {
    // The container and the browser disagreeing by a few seconds is normal;
    // "-2m ago" looks like a bug in the data instead.
    expect(at("2026-08-22T12:00:30Z")).toBe("just now");
  });
});

describe("size", () => {
  it("keeps three significant figures or so", () => {
    expect(size(0)).toBe("0 B");
    expect(size(900)).toBe("900 B");
    expect(size(2412)).toBe("2.4 KB");
    expect(size(19402118)).toBe("18.5 MB");
  });

  it("drops the decimal once it stops meaning anything", () => {
    expect(size(150 * 1024)).toBe("150 KB");
  });
});

describe("percent", () => {
  it("is a dash when nothing finished, not a zero", () => {
    // A job that hasn't finished a run and a job that failed every attempt
    // must not read the same (DESIGN.md section 12.3).
    expect(percent(null)).toBe("—");
    expect(percent(0)).toBe("0%");
    expect(percent(1)).toBe("100%");
    expect(percent(6 / 7)).toBe("86%");
  });
});

describe("count", () => {
  it("pluralizes without the parenthetical", () => {
    expect(count(1, "day")).toBe("1 day");
    expect(count(3, "job")).toBe("3 jobs");
  });
});
