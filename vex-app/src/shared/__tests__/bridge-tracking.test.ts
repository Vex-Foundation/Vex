/**
 * bridge-tracking — the R12 tracking-delay policy shared by both bridge
 * renderers (MOVES ledger + token-history). Pins:
 *   - the staleness reference is lastCheckedAt, or createdAt before the first
 *     successful check;
 *   - the 10-minute threshold is strict (equal → not yet delayed);
 *   - an unparseable timestamp never reports "delayed".
 */

import { describe, it, expect } from "vitest";
import {
  BRIDGE_TRACKING_STALE_MS,
  isBridgeTrackingStale,
} from "../bridge-tracking.js";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

describe("isBridgeTrackingStale", () => {
  it("uses lastCheckedAt as the reference when present", () => {
    // Checked 11 min ago → stale, regardless of a fresh createdAt.
    expect(isBridgeTrackingStale(iso(11 * 60_000), iso(0), NOW)).toBe(true);
    // Checked 2 min ago → fresh, even if the bridge was created long ago.
    expect(isBridgeTrackingStale(iso(2 * 60_000), iso(60 * 60_000), NOW)).toBe(false);
  });

  it("falls back to createdAt when never checked (lastCheckedAt null)", () => {
    expect(isBridgeTrackingStale(null, iso(11 * 60_000), NOW)).toBe(true);
    expect(isBridgeTrackingStale(null, iso(2 * 60_000), NOW)).toBe(false);
  });

  it("the threshold is strict — exactly at the boundary is NOT yet delayed", () => {
    expect(isBridgeTrackingStale(iso(BRIDGE_TRACKING_STALE_MS), iso(0), NOW)).toBe(false);
    expect(isBridgeTrackingStale(iso(BRIDGE_TRACKING_STALE_MS + 1), iso(0), NOW)).toBe(true);
  });

  it("never reports delayed on an unparseable timestamp", () => {
    expect(isBridgeTrackingStale("not-a-date", "also-not-a-date", NOW)).toBe(false);
  });

  it("defaults nowMs to Date.now() — a clearly-old check is delayed, a just-now check is not", () => {
    expect(isBridgeTrackingStale("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z")).toBe(true);
    expect(isBridgeTrackingStale(new Date().toISOString(), new Date().toISOString())).toBe(false);
  });
});
