/**
 * CANCELLING A LAUNCH RETIRES ITS ONLY REMAINING RETRY PATH, so it may not
 * retire it before the thing that path exists to finish has been written.
 *
 * `recordLaunchCancelled` writes two rows: the intent moves
 * `awaiting_keeper -> cancelled`, and the launch's `agent_activity` row has its
 * keeper hold concluded (nothing was ever delivered, so the payout the AgentScan
 * terminal report is waiting for is a proven zero). Those used to be two
 * commits, on the reasoning that a row left holding "stays claimable by the
 * sweep".
 *
 * THE REASONING WAS WRONG, and this file is the reproducer for it. The keeper
 * sweep claims `awaiting_keeper` and nothing else
 * (`db/repos/token-launch-intents/sweep-claim.ts`), so an intent that has
 * already committed as `cancelled` is a row no sweep will ever look at again. A
 * crash or a database failure between the two commits therefore left
 * `intent = cancelled` with `activity = keeper_purchase_pending` - a reporting
 * hold that ends only on an event, whose only remaining event had just been
 * retired - and the function still returned `true`.
 *
 * The repository and the lock are mocked at the module boundary: what is under
 * test is the ORDER and the ATOMICITY of these two writes, and a real Postgres
 * would only add a schema this file makes no claim about. The transaction double
 * below is the whole point - it commits when the body returns and rolls back
 * when it throws, exactly as `withTransaction` does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The durable state the two writers move, and what the transaction did with it.
 * `hoisted` because the module mocks below are lifted above the imports.
 */
const world = vi.hoisted(() => ({
  intentStatus: "awaiting_keeper" as "awaiting_keeper" | "cancelled",
  activitySettlement: "keeper_purchase_pending" as string,
  commits: 0,
  rollbacks: 0,
  /** Client identities the two writes were handed, so a second connection is visible. */
  writeClients: [] as unknown[],
  /** Sessions the control lock was taken for, in order. */
  lockedSessions: [] as string[],
  concludeCalls: [] as { txHash: string; conclusion: string }[],
  /** Set to make the activity conclusion fail the way a database outage would. */
  concludeThrows: false,
  /** The hash the cancelled intent carries, `null` for a launch that never staged one. */
  stagedTxHash: null as string | null,
}));

const PRE_LAUNCH_TX = `0x${"ab".repeat(32)}`;

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => {
    const client = { connection: world.commits + world.rollbacks };
    // A snapshot of the rows this transaction may touch: a rollback restores it,
    // which is the property the two-commit version could not have.
    const before = { intent: world.intentStatus, activity: world.activitySettlement };
    try {
      const result = await fn(client);
      world.commits += 1;
      return result;
    } catch (err) {
      world.intentStatus = before.intent;
      world.activitySettlement = before.activity;
      world.rollbacks += 1;
      throw err;
    }
  },
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: async (_client: unknown, sessionId: string) => {
    world.lockedSessions.push(sessionId);
  },
}));

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  cancelAfterPreLaunchWith: async (client: unknown) => {
    world.writeClients.push(client);
    if (world.intentStatus !== "awaiting_keeper") return null;
    world.intentStatus = "cancelled";
    return { txHash: world.stagedTxHash };
  },
  claimPreviewWith: vi.fn(),
  confirmAfterKeeperWith: vi.fn(),
  consumeIfAuthorizedWith: vi.fn(),
  createWith: vi.fn(),
  failWith: vi.fn(),
  getById: vi.fn(),
  markAwaitingKeeperWith: vi.fn(),
  markBroadcastPendingWith: vi.fn(),
  confirmWith: vi.fn(),
  stampVirtualsBlockWith: vi.fn(),
}));

/**
 * BOTH conclusion writers are doubled, and that is the point of this file rather
 * than an accident: the pool-level one is what the two-commit version called on
 * its own connection AFTER the transaction had committed. Keeping it here means
 * the assertions below fail on the OLD ordering by describing its behaviour -
 * a second write client, a committed cancellation, and a swallowed error - and
 * not merely by failing to resolve an export.
 */
async function concludeOn(
  client: unknown,
  txHash: string,
  conclusion: string,
): Promise<boolean> {
  world.writeClients.push(client);
  world.concludeCalls.push({ txHash, conclusion });
  if (world.concludeThrows) throw new Error("controlled database outage after the intent write");
  if (world.activitySettlement !== "keeper_purchase_pending") return false;
  world.activitySettlement = "keeper_settlement_observed";
  return true;
}

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  concludeLaunchKeeperSettlementByTxHashWith: (client: unknown, txHash: string, conclusion: string) =>
    concludeOn(client, txHash, conclusion),
  // The lane's OWN pool connection - a separate commit boundary by construction.
  concludeLaunchKeeperSettlementByTxHash: (txHash: string, conclusion: string) =>
    concludeOn("the repository pool, outside any caller transaction", txHash, conclusion),
}));

vi.mock("@vex-agent/db/repos/launch-image-lock.js", () => ({
  LaunchImageMissingError: class extends Error {},
}));

const { recordLaunchCancelled } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/launch/intent.js"
);

const CANCEL = {
  intentId: "intent-under-test",
  sessionId: "session-under-test",
  tokenAddress: `0x${"11".repeat(20)}`,
};

/** The keeper sweep's ONLY claim ticket (`sweep-claim.ts` claims this status). */
function stillClaimableByKeeperSweep(): boolean {
  return world.intentStatus === "awaiting_keeper";
}

beforeEach(() => {
  world.intentStatus = "awaiting_keeper";
  world.activitySettlement = "keeper_purchase_pending";
  world.commits = 0;
  world.rollbacks = 0;
  world.writeClients = [];
  world.lockedSessions = [];
  world.concludeCalls = [];
  world.concludeThrows = false;
  world.stagedTxHash = PRE_LAUNCH_TX;
});

describe("recordLaunchCancelled", () => {
  it("writes the cancellation and the end of the keeper hold in ONE transaction under ONE lock", async () => {
    const recorded = await recordLaunchCancelled(CANCEL);

    expect(recorded).toBe(true);
    expect(world.intentStatus).toBe("cancelled");
    expect(world.activitySettlement).toBe("keeper_settlement_observed");
    expect(world.concludeCalls).toEqual([{ txHash: PRE_LAUNCH_TX, conclusion: "cancelled" }]);
    // ONE commit, ONE lock, and both writes on the SAME client: a second
    // connection here would be a second commit boundary and the whole gap.
    expect(world.commits).toBe(1);
    expect(world.rollbacks).toBe(0);
    expect(world.lockedSessions).toEqual([CANCEL.sessionId]);
    expect(new Set(world.writeClients).size).toBe(1);
  });

  it("does NOT retire the retry path when the activity write fails", async () => {
    world.concludeThrows = true;

    await expect(recordLaunchCancelled(CANCEL)).rejects.toThrow(/controlled database outage/);

    // THE INVARIANT. The failure rolled the cancellation back, so the intent is
    // still the sweep's to finish - the state the old comment claimed and the
    // old ordering could not produce.
    expect(world.intentStatus).toBe("awaiting_keeper");
    expect(stillClaimableByKeeperSweep()).toBe(true);
    expect(world.activitySettlement).toBe("keeper_purchase_pending");
    expect(world.rollbacks).toBe(1);
    expect(world.commits).toBe(0);
    // And the caller is told the truth: a cancellation this function did not
    // record must never be reported as recorded.
    expect(world.concludeCalls).toHaveLength(1);
  });

  it("recovers on the next attempt after that failure, with both writes landing together", async () => {
    world.concludeThrows = true;
    await expect(recordLaunchCancelled(CANCEL)).rejects.toThrow(/controlled database outage/);

    world.concludeThrows = false;
    expect(await recordLaunchCancelled(CANCEL)).toBe(true);
    expect(world.intentStatus).toBe("cancelled");
    expect(world.activitySettlement).toBe("keeper_settlement_observed");
    expect(world.commits).toBe(1);
  });

  it("is idempotent: a repeat finds the intent already cancelled and concludes nothing twice", async () => {
    expect(await recordLaunchCancelled(CANCEL)).toBe(true);
    expect(world.concludeCalls).toHaveLength(1);

    // The intent CAS misses, so this call owns no cancellation and must not
    // touch the activity row a previous conclusion already settled.
    expect(await recordLaunchCancelled(CANCEL)).toBe(false);
    expect(world.concludeCalls).toHaveLength(1);
    expect(world.activitySettlement).toBe("keeper_settlement_observed");
  });

  it("has nothing to conclude when the cancelled launch never staged a hash", async () => {
    world.stagedTxHash = null;

    expect(await recordLaunchCancelled(CANCEL)).toBe(true);
    // No hash means no activity row to find - not a skipped write - so the
    // cancellation still commits.
    expect(world.concludeCalls).toHaveLength(0);
    expect(world.commits).toBe(1);
  });
});
