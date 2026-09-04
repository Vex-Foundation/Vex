/**
 * The drain's consumption of the server's additive `agent` health field
 * (2026-08-12): a positive strike count is surfaced as a structured warn
 * BEFORE quarantine turns into a hard 403; a healthy zero stays silent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ClaimedOutboxEvent } from "@vex-agent/db/repos/agentscan-reporting.js";
import type { AgentscanClient, SendOutcome } from "@vex-agent/agentscan/client.js";

const mockClaimDueOutbox = vi.fn();
const mockMarkOutboxSent = vi.fn();
const mockMarkOutboxRejected = vi.fn();

vi.mock("@vex-agent/db/repos/agentscan-reporting.js", () => ({
  claimDueOutbox: (...args: unknown[]) => mockClaimDueOutbox(...args),
  markOutboxSent: (...args: unknown[]) => mockMarkOutboxSent(...args),
  markOutboxRejected: (...args: unknown[]) => mockMarkOutboxRejected(...args),
  rescheduleOutbox: vi.fn(),
  resetForReRegistration: vi.fn(),
  markStopped: vi.fn(),
}));

const mockWarn = vi.fn();
vi.mock("@utils/logger.js", () => {
  const stub = {
    warn: (...args: unknown[]) => mockWarn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  return { default: stub, logger: stub };
});

const { drainOutbox } = await import("@vex-agent/sync/agentscan-report/drain.js");

function claimedRow(): ClaimedOutboxEvent {
  return {
    outboxId: 1,
    activityId: 10,
    status: "confirmed",
    backfill: false,
    activity: {
      id: 10,
      protocol_execution_id: 5,
      event_index: 0,
      kind: "swap",
      event_role: "swap",
      protocol: "kyberswap",
      chain_family: "eip155",
      chain_id: 8453,
      created_at: new Date("2026-08-12T10:00:00Z"),
    },
  } as unknown as ClaimedOutboxEvent;
}

function clientReturning(outcome: SendOutcome): AgentscanClient {
  return { sendEvents: vi.fn(async () => outcome) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // One claimed batch, then the drain's next claim comes back empty.
  mockClaimDueOutbox
    .mockResolvedValueOnce({ kind: "claimed", events: [claimedRow()] })
    .mockResolvedValue({ kind: "claimed", events: [] });
  mockMarkOutboxSent.mockResolvedValue({ kind: "applied", rows: 1 });
});

describe("drainOutbox - agent health surfacing", () => {
  it("warns agentscan.report.agent_strikes on a positive strike count", async () => {
    const client = clientReturning({
      kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [],
      agentHealth: { strikeCount: 2, status: "active" },
    });
    await drainOutbox(client, "a".repeat(64), "token", 0);
    expect(mockWarn).toHaveBeenCalledWith(
      "agentscan.report.agent_strikes",
      { strikeCount: 2, status: "active" },
    );
  });

  // Absence of the field is covered by the client parser tests (reads as
  // null) and the null guard here is structural; this pins the zero case.
  it("stays silent on zero strikes", async () => {
    const client = clientReturning({
      kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [],
      agentHealth: { strikeCount: 0, status: "active" },
    });
    await drainOutbox(client, "a".repeat(64), "token", 0);
    const strikeWarns = mockWarn.mock.calls.filter(
      (call) => call[0] === "agentscan.report.agent_strikes",
    );
    expect(strikeWarns).toEqual([]);
  });
});
