/**
 * Quarantine is a pause, not a terminal skip. A leftover
 * `stopped_reason = 'quarantined'` (old binaries latched this on 403) must
 * still enter the drain; consent_revoked / identity conflicts stay dark.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentscanReportingState } from "@vex-agent/db/repos/agentscan-reporting.js";
import type { AgentscanReporterDeps } from "@vex-agent/sync/agentscan-report.js";

const mockGetReportingState = vi.fn();
const mockDrainIncremental = vi.fn();
const mockComputeWalletsFingerprint = vi.fn();

vi.mock("@vex-agent/db/repos/agentscan-reporting.js", () => ({
  getReportingState: (...args: unknown[]) => mockGetReportingState(...args),
}));

vi.mock("@vex-agent/sync/agentscan-report/drain.js", () => ({
  drainIncremental: (...args: unknown[]) => mockDrainIncremental(...args),
  drainOutbox: vi.fn(),
  AGENTSCAN_BATCH_LIMIT: 500,
  AGENTSCAN_MAX_BATCHES_PER_TICK: 6,
}));

vi.mock("@vex-agent/sync/agentscan-report/handshake-lane.js", () => ({
  handshakeOnce: vi.fn(),
  computeWalletsFingerprint: () => mockComputeWalletsFingerprint(),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { runAgentscanReport, runAgentscanIncremental } = await import(
  "@vex-agent/sync/agentscan-report.js"
);

const FINGERPRINT = "fp";

function registeredState(
  stoppedReason: AgentscanReportingState["stoppedReason"],
): AgentscanReportingState {
  return {
    agentHash: "a".repeat(64),
    ingestToken: "T".repeat(43),
    consentVersion: 1,
    acceptedAt: "2026-08-20T00:00:00.000Z",
    registeredAt: "2026-08-20T00:00:00.000Z",
    registerAttemptCount: 0,
    nextRegisterAttemptAt: "2026-08-20T00:00:00.000Z",
    backfillEnqueuedAt: "2026-08-20T00:00:00.000Z",
    stoppedReason,
    agentName: "agent-default",
    lastHandshakeAt: "2026-08-20T00:00:00.000Z",
    serverCursorRowId: null,
    boundWalletsFingerprint: FINGERPRINT,
  };
}

function deps(): AgentscanReporterDeps {
  return {
    baseUrl: () => "http://localhost",
    buildClient: () => ({ sendEvents: vi.fn() }),
    buildSessionClient: () => ({
      sessionStart: vi.fn(),
      sessionComplete: vi.fn(),
    }),
    signChallenge: vi.fn(),
    appVersion: () => "0.0.0-test",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockComputeWalletsFingerprint.mockReturnValue(FINGERPRINT);
  mockDrainIncremental.mockResolvedValue({ enqueued: 1, sent: 1, rejected: 0, deferred: 0 });
});

describe("quarantine is not a terminal skip", () => {
  it("a leftover quarantined latch still drains the periodic lane", async () => {
    mockGetReportingState.mockResolvedValue(registeredState("quarantined"));
    const result = await runAgentscanReport(deps());
    expect(result.skipped).toBeNull();
    expect(mockDrainIncremental).toHaveBeenCalledOnce();
  });

  it("a leftover quarantined latch still drains the push lane", async () => {
    mockGetReportingState.mockResolvedValue(registeredState("quarantined"));
    const result = await runAgentscanIncremental(deps());
    expect(result.skipped).toBeNull();
    expect(mockDrainIncremental).toHaveBeenCalledOnce();
  });

  it("consent_revoked still skips both lanes without draining", async () => {
    mockGetReportingState.mockResolvedValue(registeredState("consent_revoked"));
    expect((await runAgentscanReport(deps())).skipped).toBe("stopped");
    expect((await runAgentscanIncremental(deps())).skipped).toBe("unregistered");
    expect(mockDrainIncremental).not.toHaveBeenCalled();
  });
});
