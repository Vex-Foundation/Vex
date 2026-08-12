/**
 * The AgentScan ingest lane's request budget.
 *
 * The drain can issue up to `AGENTSCAN_MAX_BATCHES_PER_TICK` batches per tick,
 * and a tick can also send two envelopes when a claim mixes backfill and
 * incremental rows, while the push lane ticks on a two-second debounce. Left
 * unpaced that exceeds the server's 60 requests per minute per token, and the
 * excess comes back as 429s that throttle the lane harder than pacing would
 * have. What is pinned here: the budget stays strictly under the ceiling with
 * headroom for the handshake and retries, it refuses rather than sleeps, and it
 * frees up again as the trailing window rolls forward.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  AGENTSCAN_MAX_SENDS_PER_MINUTE,
  tryConsumeAgentscanSendSlot,
  resetAgentscanSendRateWindow,
} from "../../../vex-agent/sync/agentscan-report/rate-limit.js";
import { AGENTSCAN_MAX_BATCHES_PER_TICK } from "../../../vex-agent/sync/agentscan-report/drain.js";

const SERVER_CEILING_PER_MINUTE = 60;

beforeEach(() => {
  resetAgentscanSendRateWindow();
});

describe("agentscan send-rate budget", () => {
  it("stays under the server ceiling with headroom for the handshake and retries", () => {
    expect(AGENTSCAN_MAX_SENDS_PER_MINUTE).toBeLessThan(SERVER_CEILING_PER_MINUTE);
    // Enough headroom that a re-handshake is never the request that gets refused.
    expect(SERVER_CEILING_PER_MINUTE - AGENTSCAN_MAX_SENDS_PER_MINUTE).toBeGreaterThanOrEqual(10);
    // And enough budget that an ordinary tick is never throttled mid-drain.
    expect(AGENTSCAN_MAX_SENDS_PER_MINUTE).toBeGreaterThan(AGENTSCAN_MAX_BATCHES_PER_TICK);
  });

  it("grants exactly the budget inside one window, then refuses", () => {
    const start = Date.parse("2026-08-12T10:00:00.000Z");
    for (let i = 0; i < AGENTSCAN_MAX_SENDS_PER_MINUTE; i++) {
      expect(tryConsumeAgentscanSendSlot(start + i)).toBe(true);
    }
    expect(tryConsumeAgentscanSendSlot(start + AGENTSCAN_MAX_SENDS_PER_MINUTE)).toBe(false);
  });

  it("bounds a burst of full ticks to the budget, not to the batches it wanted to send", () => {
    const start = Date.parse("2026-08-12T10:00:00.000Z");
    let granted = 0;
    // Eight ticks two seconds apart, each wanting a full drain: 48 sends asked
    // for inside 16 seconds, which without the budget would blow the ceiling.
    for (let tick = 0; tick < 8; tick++) {
      for (let batch = 0; batch < AGENTSCAN_MAX_BATCHES_PER_TICK; batch++) {
        if (tryConsumeAgentscanSendSlot(start + tick * 2_000)) granted++;
      }
    }
    expect(granted).toBe(AGENTSCAN_MAX_SENDS_PER_MINUTE);
    expect(granted).toBeLessThan(SERVER_CEILING_PER_MINUTE);
  });

  it("frees the budget again as the trailing window rolls forward", () => {
    const start = Date.parse("2026-08-12T10:00:00.000Z");
    for (let i = 0; i < AGENTSCAN_MAX_SENDS_PER_MINUTE; i++) {
      expect(tryConsumeAgentscanSendSlot(start)).toBe(true);
    }
    expect(tryConsumeAgentscanSendSlot(start + 59_999)).toBe(false);
    expect(tryConsumeAgentscanSendSlot(start + 60_001)).toBe(true);
  });
});
