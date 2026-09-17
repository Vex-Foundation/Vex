import { describe, expect, it } from "vitest";
import { superboardAttemptTime } from "../superboard-attempt-time.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

describe("superboardAttemptTime", () => {
  it("reads under a minute as just now", () => {
    expect(superboardAttemptTime(iso(NOW), NOW)).toBe("just now");
    expect(superboardAttemptTime(iso(NOW - 59_999), NOW)).toBe("just now");
  });

  it("reads minutes up to the hour", () => {
    expect(superboardAttemptTime(iso(NOW - 60_000), NOW)).toBe("1 min ago");
    expect(superboardAttemptTime(iso(NOW - 2 * 60_000), NOW)).toBe("2 min ago");
    expect(superboardAttemptTime(iso(NOW - 59 * 60_000 + 1), NOW)).toBe("58 min ago");
    expect(superboardAttemptTime(iso(NOW - 59 * 60_000), NOW)).toBe("59 min ago");
    expect(superboardAttemptTime(iso(NOW - 60 * 60_000 + 1), NOW)).toBe("59 min ago");
  });

  it("reads hours up to the day", () => {
    expect(superboardAttemptTime(iso(NOW - 60 * 60_000), NOW)).toBe("1 h ago");
    expect(superboardAttemptTime(iso(NOW - 90 * 60_000), NOW)).toBe("1 h ago");
    expect(superboardAttemptTime(iso(NOW - 2 * 3_600_000), NOW)).toBe("2 h ago");
    expect(superboardAttemptTime(iso(NOW - 23 * 3_600_000), NOW)).toBe("23 h ago");
    expect(superboardAttemptTime(iso(NOW - 24 * 3_600_000 + 1), NOW)).toBe("23 h ago");
  });

  it("reads a day or older as the local zero-padded 24-hour clock time", () => {
    expect(superboardAttemptTime(iso(NOW - 24 * 3_600_000), NOW)).toMatch(/^[0-2][0-9]:[0-5][0-9]$/);
    // Local-time components rather than a UTC literal: the runner's zone is
    // whatever the machine has, and the contract is the LOCAL wall clock. Three
    // days back keeps the instant past the 24 h edge in every zone.
    const morning = new Date(NOW - 3 * 24 * 3_600_000);
    morning.setHours(7, 5, 0, 0);
    expect(superboardAttemptTime(morning.toISOString(), NOW)).toBe("07:05");
    const night = new Date(NOW - 3 * 24 * 3_600_000);
    night.setHours(23, 59, 0, 0);
    expect(superboardAttemptTime(night.toISOString(), NOW)).toBe("23:59");
  });

  it("reads a future timestamp as just now and garbage honestly", () => {
    expect(superboardAttemptTime(iso(NOW + 60_000), NOW)).toBe("just now");
    expect(superboardAttemptTime(iso(NOW + 48 * 3_600_000), NOW)).toBe("just now");
    expect(superboardAttemptTime("not-a-date", NOW)).toBe("unknown time");
    expect(superboardAttemptTime("", NOW)).toBe("unknown time");
  });
});
