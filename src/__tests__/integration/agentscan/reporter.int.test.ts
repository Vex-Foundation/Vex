/**
 * AgentScan reporter lane — end-to-end against real Postgres with a scripted
 * in-memory client (the HTTP layer has its own unit suite; what this suite
 * proves is the LANE's state machine over real SQL).
 *
 * Acceptance criteria pinned here:
 *
 *   AC1 — the lane registers once with a well-formed identity and sends event
 *         batches with the stored hash/token;
 *   AC2 — the one-time BACKFILL: the first drain after a successful
 *         registration carries the full eligible history with backfill:true,
 *         and only that once;
 *   AC3 — privacy: the serialized batches never contain the seeded wallet /
 *         session / from-address values (the mapper's allowlist, proven at
 *         the lane boundary).
 *
 * Plus the server-answer table: 409 register → permanent stop; 410 →
 * permanent stop; 401 on send → re-register the SAME identity next run;
 * per-item rejection → terminal rejected row that is never retried;
 * retryable register failure → backoff without touching the outbox.
 */
import { afterEach, describe, it, expect } from "vitest";
import { seedIntent, cleanupSeeded } from "../agent-scan/_fixtures.js";

import type {
  AgentscanClient,
  RegisterInput,
  RegisterOutcome,
  SendEventsInput,
  SendOutcome,
} from "../../../vex-agent/agentscan/client.js";
import type { AgentscanReporterDeps } from "../../../vex-agent/sync/agentscan-report.js";

async function resetAgentscanTables(): Promise<void> {
  const { execute } = await import("@vex-agent/db/client.js");
  await execute(`DELETE FROM agentscan_outbox`, []);
  await execute(`DELETE FROM agentscan_reporting_state`, []);
}

/** Index into an array without a non-null assertion: a miss throws, honestly. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}, got ${items.length} item(s)`);
  return item;
}

afterEach(async () => {
  await resetAgentscanTables();
  await cleanupSeeded();
});

/** Scripted client: records every call, answers from programmable queues. */
class FakeClient implements AgentscanClient {
  readonly registerCalls: RegisterInput[] = [];
  readonly sendCalls: SendEventsInput[] = [];
  registerOutcomes: RegisterOutcome[] = [];
  sendOutcomes: SendOutcome[] = [];

  async register(input: RegisterInput): Promise<RegisterOutcome> {
    this.registerCalls.push(input);
    return this.registerOutcomes.shift() ?? { kind: "registered" };
  }

  async sendEvents(input: SendEventsInput): Promise<SendOutcome> {
    this.sendCalls.push(input);
    return (
      this.sendOutcomes.shift() ?? {
        kind: "ok",
        accepted: input.events.length,
        duplicates: 0,
        rejectedIndexes: [],
      }
    );
  }
}

function depsWith(client: FakeClient, baseUrl: string | null = "http://localhost"): AgentscanReporterDeps {
  return {
    baseUrl: () => baseUrl,
    buildClient: () => client,
    appVersion: () => "0.0.0-test",
  };
}

interface SeededRow {
  readonly activityId: number;
  readonly walletAddress: string;
  readonly sessionId: string;
}

async function seedEligibleSwap(): Promise<SeededRow> {
  const repo = await import("@vex-agent/db/repos/agent-activity.js");
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
  const event = await repo.createPendingActivityEvent({
    protocolExecutionId,
    eventIndex: 0,
    eventRole: "swap",
    kind: "swap",
    protocol: "kyberswap",
    chainId: 8453,
    walletAddress,
    sessionId,
    tokenIn: { tokenAddress: "0x" + "1".repeat(40), tokenSymbol: "ETH", tokenDecimals: 18, amountRaw: "1000000000000000000" },
    tokenOut: { tokenAddress: "0x" + "2".repeat(40), tokenSymbol: "VEX", tokenDecimals: 18, amountRaw: "5" },
  });
  return { activityId: event.id, walletAddress, sessionId };
}

async function seedIneligibleAllowance(): Promise<void> {
  const repo = await import("@vex-agent/db/repos/agent-activity.js");
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
  await repo.createPendingActivityEvent({
    protocolExecutionId, eventIndex: 0, eventRole: "allowance", kind: "swap",
    protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
  });
}

async function confirmRow(activityId: number): Promise<void> {
  const repo = await import("@vex-agent/db/repos/agent-activity.js");
  await repo.markActivityBroadcast(activityId, {
    txHash: `0x${activityId.toString(16).padStart(64, "0")}`,
    fromAddress: "0x" + "3".repeat(40),
    nonce: 1,
  });
  const confirmed = await repo.confirmActivityEvent(activityId, {
    executedAmountInRaw: "1000000000000000000",
    executedAmountOutRaw: "5",
  });
  expect(confirmed.applied).toBe(true);
}

describe("reporter lane — gating", () => {
  it("disabled base URL: a full no-op, no identity is ever generated", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const client = new FakeClient();

    const result = await lane.runAgentscanReport(depsWith(client, null));

    expect(result.skipped).toBe("disabled");
    expect(client.registerCalls).toHaveLength(0);
    expect(client.sendCalls).toHaveLength(0);
    expect((await stateRepo.getReportingState()).agentHash).toBeNull();
  });

  it("a stopped lane stays stopped and never calls the network", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await stateRepo.markStopped("consent_revoked");
    const client = new FakeClient();

    const result = await lane.runAgentscanReport(depsWith(client));

    expect(result.skipped).toBe("stopped");
    expect(client.registerCalls).toHaveLength(0);
    expect(client.sendCalls).toHaveLength(0);
  });
});

describe("reporter lane — register + one-time backfill (AC1/AC2)", () => {
  it("first run: registers a well-formed identity, then backfills the full eligible history", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const seededA = await seedEligibleSwap();
    const seededB = await seedEligibleSwap();
    await seedIneligibleAllowance();
    const client = new FakeClient();

    const result = await lane.runAgentscanReport(depsWith(client));

    // register: once, valid shapes, consent v1
    expect(client.registerCalls).toHaveLength(1);
    const register = at(client.registerCalls, 0);
    expect(register.agentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(register.ingestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(register.consentVersion).toBe(1);
    expect(register.appVersion).toBe("0.0.0-test");

    // backfill batch: flag true, exactly the two eligible rows, correct envelope identity
    expect(client.sendCalls).toHaveLength(1);
    const batch = at(client.sendCalls, 0);
    expect(batch.backfill).toBe(true);
    expect(batch.agentHash).toBe(register.agentHash);
    expect(batch.ingestToken).toBe(register.ingestToken);
    expect(batch.events.map((e) => e.sourceRowId).sort()).toEqual(
      [String(seededA.activityId), String(seededB.activityId)].sort(),
    );

    expect(result.backfillEnqueued).toBe(true);
    expect(result.enqueued).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.skipped).toBeNull();
  });

  it("privacy at the lane boundary: serialized batches never carry wallet/session/from values (AC3)", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const seeded = await seedEligibleSwap();
    await confirmRow(seeded.activityId);
    const client = new FakeClient();

    await lane.runAgentscanReport(depsWith(client));

    expect(client.sendCalls.length).toBeGreaterThan(0);
    const wire = JSON.stringify(client.sendCalls);
    expect(wire).not.toContain(seeded.walletAddress);
    expect(wire).not.toContain(seeded.sessionId);
    expect(wire).not.toContain("0x" + "3".repeat(40)); // from_address
  });

  it("second run sends nothing new; a status flip then goes out incrementally with backfill:false", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const seeded = await seedEligibleSwap();
    const client = new FakeClient();

    await lane.runAgentscanReport(depsWith(client));       // run 1: backfill(pending)
    const second = await lane.runAgentscanReport(depsWith(client)); // run 2: quiet
    expect(second.sent).toBe(0);
    expect(second.enqueued).toBe(0);
    expect(client.sendCalls).toHaveLength(1);
    expect(client.registerCalls).toHaveLength(1); // no re-register

    await confirmRow(seeded.activityId);
    const third = await lane.runAgentscanReport(depsWith(client));  // run 3: the confirmed pair
    expect(third.sent).toBe(1);
    expect(client.sendCalls).toHaveLength(2);
    const incremental = at(client.sendCalls, 1);
    expect(incremental.backfill).toBe(false);
    expect(incremental.events).toHaveLength(1);
    expect(at(incremental.events, 0).status).toBe("confirmed");
    expect(at(incremental.events, 0).executedInRaw).not.toBeNull();
  });
});

describe("reporter lane — server-answer table", () => {
  it("register 409 → permanent stop agent_conflict", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const client = new FakeClient();
    client.registerOutcomes = [{ kind: "conflict" }];

    const result = await lane.runAgentscanReport(depsWith(client));

    expect(result.skipped).toBe("stopped");
    expect((await stateRepo.getReportingState()).stoppedReason).toBe("agent_conflict");
    expect(client.sendCalls).toHaveLength(0);
  });

  it("register retryable → backoff stamped, outbox untouched, next-run-too-early skips", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    const client = new FakeClient();
    client.registerOutcomes = [
      { kind: "retryable", status: 500, retryAfterSeconds: null, detail: "HTTP 500 internal" },
    ];

    const first = await lane.runAgentscanReport(depsWith(client));
    expect(first.skipped).toBe("unregistered");
    expect((await stateRepo.getReportingState()).registerAttemptCount).toBe(1);
    expect(client.sendCalls).toHaveLength(0);

    // Backoff holds: the immediate next run does not even attempt to register.
    const second = await lane.runAgentscanReport(depsWith(client));
    expect(second.skipped).toBe("unregistered");
    expect(client.registerCalls).toHaveLength(1);
  });

  it("send 410 → permanent stop; the following run is a stopped no-op", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    const client = new FakeClient();
    client.sendOutcomes = [{ kind: "stopped", reason: "consent_revoked" }];

    await lane.runAgentscanReport(depsWith(client));
    expect((await stateRepo.getReportingState()).stoppedReason).toBe("consent_revoked");

    const next = await lane.runAgentscanReport(depsWith(client));
    expect(next.skipped).toBe("stopped");
    expect(client.sendCalls).toHaveLength(1);
  });

  it("send 401 → registration cleared, SAME identity re-registered next run, rows resent", async () => {
    const { execute } = await import("@vex-agent/db/client.js");
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedEligibleSwap();
    const client = new FakeClient();
    client.sendOutcomes = [{ kind: "auth_lost" }];

    const first = await lane.runAgentscanReport(depsWith(client));
    expect(first.deferred).toBe(1);
    expect((await stateRepo.getReportingState()).registeredAt).toBeNull();

    // Clear the claim-stamped backoff so the retry is due NOW (test shortcut).
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);

    const second = await lane.runAgentscanReport(depsWith(client));
    expect(client.registerCalls).toHaveLength(2);
    expect(at(client.registerCalls, 1).agentHash).toBe(at(client.registerCalls, 0).agentHash);
    expect(second.sent).toBe(1);
  });

  it("auth_lost triggers a FULL idempotent resend: previously-sent rows come back backfill:true; a previously-rejected row is never resent (AC1)", async () => {
    const { execute, queryOne } = await import("@vex-agent/db/client.js");
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const seededA = await seedEligibleSwap();
    const seededB = await seedEligibleSwap();
    const client = new FakeClient();

    // Run 1: register + backfill both rows; one accepted, one rejected.
    client.sendOutcomes = [{ kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [1] }];
    const first = await lane.runAgentscanReport(depsWith(client));
    expect(first.sent).toBe(1);
    expect(first.rejected).toBe(1);
    const registeredHash = at(client.registerCalls, 0).agentHash;

    // Ordering of the backfill batch is not guaranteed, so read the DB to
    // find out which seeded activity landed sent vs. rejected.
    async function pendingRow(activityId: number) {
      return queryOne<{ sent_at: Date | null; rejected_at: Date | null }>(
        `SELECT sent_at, rejected_at FROM agentscan_outbox WHERE activity_id = $1 AND status = 'pending'`,
        [activityId],
      );
    }
    const aRow = await pendingRow(seededA.activityId);
    const sentActivityId = aRow?.sent_at != null ? seededA.activityId : seededB.activityId;
    const rejectedActivityId = aRow?.sent_at != null ? seededB.activityId : seededA.activityId;

    // Run 2: a fresh incremental row (the confirm transition) arrives, but
    // the server has forgotten the token (simulated server-side DB reset).
    await confirmRow(sentActivityId);
    client.sendOutcomes = [{ kind: "auth_lost" }];
    const second = await lane.runAgentscanReport(depsWith(client));
    expect(second.deferred).toBe(1);
    expect((await stateRepo.getReportingState()).registeredAt).toBeNull();

    // Force everything due (test shortcut) and let run 3 re-register + resend.
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    client.sendOutcomes = [];

    const third = await lane.runAgentscanReport(depsWith(client));

    expect(client.registerCalls).toHaveLength(2);
    expect(at(client.registerCalls, 1).agentHash).toBe(registeredHash);
    expect(third.sent).toBe(2);

    const resentRow = await pendingRow(sentActivityId);
    expect(resentRow?.sent_at).not.toBeNull();
    const resentBackfillRow = await queryOne<{ backfill: boolean }>(
      `SELECT backfill FROM agentscan_outbox WHERE activity_id = $1 AND status = 'pending'`,
      [sentActivityId],
    );
    expect(resentBackfillRow?.backfill).toBe(true);

    const stillRejected = await pendingRow(rejectedActivityId);
    expect(stillRejected?.rejected_at).not.toBeNull();
    expect(stillRejected?.sent_at).toBeNull();
  });

  it("per-item rejection → that row is terminal-rejected and never resent", async () => {
    const { execute } = await import("@vex-agent/db/client.js");
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    await seedEligibleSwap();
    await seedEligibleSwap();
    const client = new FakeClient();
    client.sendOutcomes = [{ kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [1] }];

    const first = await lane.runAgentscanReport(depsWith(client));
    expect(first.sent).toBe(1);
    expect(first.rejected).toBe(1);

    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW() WHERE sent_at IS NULL AND rejected_at IS NULL`, []);
    const second = await lane.runAgentscanReport(depsWith(client));
    expect(second.sent).toBe(0);
    expect(client.sendCalls).toHaveLength(1);
  });
});
