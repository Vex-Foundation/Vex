/**
 * THE SERVER CAPABILITY GATE: what happens when this build's vocabulary has
 * outrun the AgentScan deployment it reports to.
 *
 * ## The defect
 *
 * `db/repos/agentscan-reporting.ts` carries a gate that reads like a statement
 * about the SERVER and is entirely a statement about this database: it compares
 * `vocabulary_version` and `backfill_vocabulary_version`, both local. Nothing in
 * the lane had ever asked the deployed server what it accepts. So a row carrying
 * a role the deployed contract does not have (`vex_fee` and the four launchpad
 * family roles arrive with vex-agentscan #78, undeployed as of 2026-09-06) is
 * sent, comes back in `rejectedIndexes` as `validation_failed`, and
 * `markOutboxRejected` makes that PERMANENT. The activity is then never reported
 * at all, not even after the server deploys, because a rejected outbox row is
 * terminal and is never retried. (Codex final review 2026-09-06, lane 7.)
 *
 * ## The posture, and where it comes from
 *
 * `agents-colab/metamask-core/packages/transaction-controller/src/helpers/PendingTransactionTracker.ts`:
 * a LOOKUP FAILURE IS NEVER A VERDICT. A receipt the tracker could not read
 * produces `#warnTransaction` - a visible reason attached to the record - and
 * the transaction stays pending; only a definitive on-chain signal
 * (`#failTransaction`, `#dropTransaction`) is terminal. Its tests assert exactly
 * that shape: `expect(listener).toHaveBeenCalledTimes(0)` for every terminal
 * event, plus the warning that carries the reason
 * (`PendingTransactionTracker.test.ts`, "if getTransactionReceipt fails").
 *
 * Adopted here: a refusal of a role the server has not deployed yet is not a
 * verdict about the row. The row stays OWED with the reason visible, the role is
 * recorded as unsupported so the lane stops spending sends on it, and when the
 * deployment advances the row goes out once.
 *
 * ## Why the ingest response IS the probe
 *
 * Measured against the live deployment at `agentscan.projectvex.ai` on
 * 2026-09-06, read-only: `/healthz` carries no version, and the route set is
 * byte-identical between the deployed contract and the new one, so there is no
 * version or capability endpoint to ask. The one public read that reflects the
 * server's vocabulary is the activity feed's kind filter, and it tracks
 * EVENT_KINDS, not EVENT_ROLES: it would answer for vex-agentscan #77 while
 * saying nothing about the roles #78 adds. The only authority on "does this
 * server accept this role" is therefore the ingest response itself, which is why
 * the probe is one send and its result is cached with an expiry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ClaimedOutboxEvent } from "@vex-agent/db/repos/agentscan-reporting.js";
import type { AgentscanClient, SendEventsInput, SendOutcome } from "@vex-agent/agentscan/client.js";

const mockClaimDueOutbox = vi.fn();
const mockMarkOutboxSent = vi.fn();
const mockMarkOutboxRejected = vi.fn();
const mockRescheduleOutbox = vi.fn();

vi.mock("@vex-agent/db/repos/agentscan-reporting.js", () => ({
  claimDueOutbox: (...args: unknown[]) => mockClaimDueOutbox(...args),
  markOutboxSent: (...args: unknown[]) => mockMarkOutboxSent(...args),
  markOutboxRejected: (...args: unknown[]) => mockMarkOutboxRejected(...args),
  rescheduleOutbox: (...args: unknown[]) => mockRescheduleOutbox(...args),
  resetForReRegistration: vi.fn(),
  markStopped: vi.fn(),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { drainOutbox } = await import("@vex-agent/sync/agentscan-report/drain.js");
const capability = await import("@vex-agent/agentscan/server-capability.js");

const AGENT_HASH = "a".repeat(64);

function claimedRow(input: {
  outboxId: number;
  eventRole: string;
  kind: string;
}): ClaimedOutboxEvent {
  return {
    outboxId: input.outboxId,
    sourceKind: "agent_activity",
    enrichmentRevision: null,
    activityId: input.outboxId * 10,
    status: "confirmed",
    backfill: false,
    fillId: null,
    fill: null,
    activity: {
      id: input.outboxId * 10,
      protocol_execution_id: 5,
      event_index: 0,
      kind: input.kind,
      event_role: input.eventRole,
      protocol: "pools_fun",
      chain_family: "eip155",
      chain_id: 8453,
      created_at: new Date("2026-09-06T10:00:00Z"),
    },
  };
}

/** One claimed batch, then an empty claim so the drain's loop terminates. */
function claimOnce(events: ClaimedOutboxEvent[]): void {
  mockClaimDueOutbox
    .mockResolvedValueOnce({ kind: "claimed", events })
    .mockResolvedValue({ kind: "claimed", events: [] });
}

const OK_ALL_REJECTED: SendOutcome = {
  kind: "ok",
  accepted: 0,
  duplicates: 0,
  rejectedIndexes: [0],
  agentHealth: null,
};

/** A server on the deployed contract: it refuses every role it does not carry. */
function serverWithoutRoles(unknownRoles: readonly string[]): AgentscanClient {
  return {
    sendEvents: vi.fn(async (input: SendEventsInput): Promise<SendOutcome> => {
      const rejectedIndexes = input.events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => unknownRoles.includes(event.eventRole ?? ""))
        .map(({ index }) => index);
      return {
        kind: "ok",
        accepted: input.events.length - rejectedIndexes.length,
        duplicates: 0,
        rejectedIndexes,
        agentHealth: null,
      } satisfies SendOutcome;
    }),
  };
}

/**
 * A server that refuses every row it is handed, whatever the role. Used where
 * the refusal itself is the subject and the server's vocabulary is not.
 */
function serverRefusingEverything(): AgentscanClient {
  return { sendEvents: vi.fn(async (): Promise<SendOutcome> => OK_ALL_REJECTED) };
}

beforeEach(() => {
  vi.clearAllMocks();
  capability.resetAgentscanServerCapability();
  mockMarkOutboxSent.mockResolvedValue({ kind: "applied", rows: 1 });
  mockMarkOutboxRejected.mockResolvedValue({ kind: "applied", rows: 1 });
  mockRescheduleOutbox.mockResolvedValue({ kind: "applied", rows: 1 });
});

describe("a role the deployed server does not carry yet", () => {
  it("is NOT rejected terminally: the row stays owed", async () => {
    claimOnce([claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" })]);
    const client = serverRefusingEverything();

    const result = await drainOutbox(client, AGENT_HASH, "token", 0);

    // The terminal write the defect performed. Absence is the assertion.
    expect(mockMarkOutboxRejected).not.toHaveBeenCalled();
    expect(result.rejected).toBe(0);
    expect(result.owed).toBe(1);
  });

  it("records the reason where the read model can see it, and holds the row", async () => {
    claimOnce([claimedRow({ outboxId: 7, eventRole: "creator_fee_claim", kind: "claim" })]);
    const client = serverRefusingEverything();

    await drainOutbox(client, AGENT_HASH, "token", 0);

    expect(mockRescheduleOutbox).toHaveBeenCalledTimes(1);
    const [ids, delaySeconds, generation, reason] = mockRescheduleOutbox.mock.calls[0] ?? [];
    expect(ids).toEqual([7]);
    expect(delaySeconds).toBe(capability.AGENTSCAN_ROLE_RECHECK_MS / 1000);
    expect(generation).toBe(0);
    expect(String(reason)).toContain("creator_fee_claim");
  });

  it("stops spending sends on that role: the next tick does not call the server at all", async () => {
    const client = serverWithoutRoles(["vex_fee"]);
    claimOnce([claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" })]);
    await drainOutbox(client, AGENT_HASH, "token", 0);
    expect(client.sendEvents).toHaveBeenCalledTimes(1);

    // A later tick claims the same row again. The probe already answered.
    mockClaimDueOutbox.mockReset();
    claimOnce([claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" })]);
    const second = await drainOutbox(client, AGENT_HASH, "token", 0);

    expect(client.sendEvents).toHaveBeenCalledTimes(1);
    expect(second.owed).toBe(1);
    expect(mockMarkOutboxRejected).not.toHaveBeenCalled();
  });

  it("never withholds a row whose role the deployed contract already carries", async () => {
    const client = serverWithoutRoles(["vex_fee"]);
    claimOnce([
      claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" }),
      claimedRow({ outboxId: 2, eventRole: "pools_fee", kind: "launch" }),
    ]);

    const result = await drainOutbox(client, AGENT_HASH, "token", 0);

    // The launch fee under its venue-named spelling has been in the server's
    // vocabulary since its migration 0015; only the new role is withheld.
    expect(mockMarkOutboxSent).toHaveBeenCalledWith([2], 0);
    expect(result.sent).toBe(1);
    expect(result.owed).toBe(1);
  });

  it("still rejects terminally when an ESTABLISHED role fails validation", async () => {
    // A `swap` the server refuses is our bug, not its deployment: retrying an
    // identical payload can only refail, and the row must not hold forever.
    claimOnce([claimedRow({ outboxId: 3, eventRole: "swap", kind: "swap" })]);
    const client = serverRefusingEverything();

    const result = await drainOutbox(client, AGENT_HASH, "token", 0);

    expect(mockMarkOutboxRejected).toHaveBeenCalledWith(3, "validation_failed", 0);
    expect(result.rejected).toBe(1);
    expect(result.owed).toBe(0);
  });
});

describe("when the server advances", () => {
  it("submits the owed row exactly once", async () => {
    const oldServer = serverWithoutRoles(["vex_fee"]);
    claimOnce([claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" })]);
    await drainOutbox(oldServer, AGENT_HASH, "token", 0);
    expect(mockMarkOutboxSent).not.toHaveBeenCalledWith([1], 0);

    // The deployment lands; the withheld window lapses and the row is retried.
    capability.resetAgentscanServerCapability();
    const newServer = serverWithoutRoles([]);
    mockClaimDueOutbox.mockReset();
    claimOnce([claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" })]);
    const result = await drainOutbox(newServer, AGENT_HASH, "token", 0);

    expect(newServer.sendEvents).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxSent).toHaveBeenCalledWith([1], 0);
    expect(result.sent).toBe(1);
    expect(result.owed).toBe(0);
  });

  it("clears a previously withheld role as soon as one row of it is accepted", async () => {
    const server = serverWithoutRoles(["vex_fee"]);
    claimOnce([claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" })]);
    await drainOutbox(server, AGENT_HASH, "token", 0);
    expect(capability.isRoleWithheld("vex_fee", Date.now())).toBe(true);

    capability.noteRoleAcceptedByServer("vex_fee");

    expect(capability.isRoleWithheld("vex_fee", Date.now())).toBe(false);
  });
});

describe("the capability record itself", () => {
  it("withholds a provisional role only until the recheck window lapses", () => {
    const now = 1_000_000;
    expect(capability.noteRoleRefusedByServer("launch_cancel", now)).toBe(true);

    expect(capability.isRoleWithheld("launch_cancel", now)).toBe(true);
    expect(
      capability.isRoleWithheld("launch_cancel", now + capability.AGENTSCAN_ROLE_RECHECK_MS - 1),
    ).toBe(true);
    expect(
      capability.isRoleWithheld("launch_cancel", now + capability.AGENTSCAN_ROLE_RECHECK_MS),
    ).toBe(false);
  });

  it("refuses to read a rejection of an ESTABLISHED role as a missing capability", () => {
    expect(capability.noteRoleRefusedByServer("swap", 1_000_000)).toBe(false);
    expect(capability.isRoleWithheld("swap", 1_000_000)).toBe(false);
  });

  it("never withholds a role it was never told about", () => {
    expect(capability.isRoleWithheld("vex_fee", Date.now())).toBe(false);
  });
});

/**
 * The two ways a provisional role can be refused are indistinguishable in the
 * response, so the record resolves the ambiguity with evidence: once the
 * deployment has taken a row of that role, "not deployed" is no longer an
 * available reading of a later refusal.
 */
describe("a role the deployment has demonstrably accepted", () => {
  it("goes back to being terminally rejected when it later fails validation", async () => {
    const server = serverWithoutRoles([]);
    claimOnce([claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" })]);
    await drainOutbox(server, AGENT_HASH, "token", 0);
    expect(mockMarkOutboxSent).toHaveBeenCalledWith([1], 0);

    // A malformed row of the SAME role, on the SAME deployment.
    mockClaimDueOutbox.mockReset();
    claimOnce([claimedRow({ outboxId: 2, eventRole: "vex_fee", kind: "launch" })]);
    const refusing = serverRefusingEverything();
    const result = await drainOutbox(refusing, AGENT_HASH, "token", 0);

    // Held forever it would never be reported and never be diagnosed.
    expect(mockMarkOutboxRejected).toHaveBeenCalledWith(2, "validation_failed", 0);
    expect(result.rejected).toBe(1);
    expect(result.owed).toBe(0);
  });

  it("still withholds a DIFFERENT provisional role the deployment has not taken", async () => {
    const server = serverWithoutRoles(["launch_cancel"]);
    claimOnce([
      claimedRow({ outboxId: 1, eventRole: "vex_fee", kind: "launch" }),
      claimedRow({ outboxId: 2, eventRole: "launch_cancel", kind: "launch" }),
    ]);

    const result = await drainOutbox(server, AGENT_HASH, "token", 0);

    expect(result.sent).toBe(1);
    expect(result.owed).toBe(1);
    expect(mockMarkOutboxRejected).not.toHaveBeenCalled();
  });
});
