/**
 * The snapshot age the POSITION card prints - a pure function of the
 * snapshot timestamp and the clock, so both the fresh and the stale case are
 * a table.
 */

import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_STALE_AFTER_MS,
  snapshotAge,
} from "../portfolio/snapshot-age.js";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function before(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("snapshotAge", () => {
  it.each([
    [0, "just now", false],
    [59_000, "just now", false],
    [5 * 60_000, "5 min ago", false],
    [59 * 60_000, "59 min ago", false],
    [60 * 60_000, "1 hour ago", false],
    [3 * 3_600_000, "3 hours ago", false],
    [SNAPSHOT_STALE_AFTER_MS - 1, "23 hours ago", false],
    // Exactly the threshold is still fresh; one ms past it is stale.
    [SNAPSHOT_STALE_AFTER_MS, "1 day ago", false],
    [SNAPSHOT_STALE_AFTER_MS + 1, "1 day ago", true],
    [47 * 3_600_000, "1 day ago", true],
    [31 * 86_400_000, "31 days ago", true],
  ])("%d ms old reads %s (stale: %s)", (ms, label, stale) => {
    expect(snapshotAge(before(ms), NOW)).toEqual({ label, stale });
  });

  it("refuses a future timestamp - clock skew is not an age", () => {
    expect(snapshotAge(before(-60_000), NOW)).toBeNull();
  });

  it("refuses an unparseable timestamp", () => {
    expect(snapshotAge("not a date", NOW)).toBeNull();
  });
});
