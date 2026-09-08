/**
 * The launch identity sweep: its OUTCOMES, and the fact that something
 * actually runs it.
 *
 * Two defects pinned here:
 *
 *   1. The module existed, was correct, and was wired into NO dispatch path —
 *      `sync/worker.ts` knew four repair sync types and not this one, so a
 *      launch whose handler crashed between the mined create and the identity
 *      write stayed `broadcast_pending` forever. A recovery sweep nobody calls
 *      is not recovery.
 *   2. It could only represent SUCCESS. A create that is later proven to have
 *      REVERTED has no `TokenCreated` to decode, so the sweep left it pending
 *      forever too — indistinguishable from "not mined yet". A proven revert is
 *      terminal; ambiguity still never is.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import logger from "@utils/logger.js";

let pending: unknown[];
let mockConfirm: Mock;
let mockFail: Mock;
let mockRecord: Mock;
let mockStampIdentity: Mock;
let claimedWith: number[];

function reset(): void {
  pending = [];
  mockConfirm = vi.fn(async () => ({ intentId: "i1" }));
  mockFail = vi.fn(async () => ({ intentId: "i1" }));
  mockRecord = vi.fn(async () => ({ inserted: true }));
  mockStampIdentity = vi.fn(async () => true);
  claimedWith = [];
}
reset();

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  claimBroadcastPendingForSweep: async (limit: number) => { claimedWith.push(limit); return pending; },
  confirmWith: (...a: unknown[]) => mockConfirm(...a),
  failWith: (...a: unknown[]) => mockFail(...a),
}));
vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  record: (...a: unknown[]) => mockRecord(...a),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  stampLaunchOutputIdentityByTxHash: (...a: unknown[]) => mockStampIdentity(...a),
  // No sibling verdict: every row here falls through to the RPC classification
  // this file is about. The durable-sibling mirror is pinned separately, in
  // `launch-identity-repair-superseded.test.ts`.
  findLaunchActivityTerminalByTxHash: async () => null,
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_s: string, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));

const { repairLaunchIdentities } = await import("@vex-agent/sync/launch-identity-repair.js");

const INTENT = {
  intentId: "i1",
  sessionId: "sess-1",
  chainId: 4663,
  walletAddress: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
  name: "Vex",
  symbol: "VEX",
  imageId: "img_01",
  txHash: "0xhash",
  prebuyRaw: "300000000000000",
  prebuyDecimals: 18,
};

beforeEach(() => { reset(); });

describe("repairLaunchIdentities", () => {
  it("writes the index, then confirms, when the create is proven", async () => {
    pending = [INTENT];
    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "created", identity: { tokenAddress: "0xTOKEN" } }),
    });
    expect(result).toMatchObject({ checked: 1, repaired: 1, indexed: 1, failed: 0, stillPending: 0 });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("terminalizes a LATER-PROVEN REVERT instead of leaving it pending forever", async () => {
    pending = [INTENT];
    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "reverted" }),
    });
    expect(result).toMatchObject({ checked: 1, repaired: 0, indexed: 0, failed: 1, stillPending: 0 });
    // A launch that did not happen gets NO identity row and NO confirm.
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledTimes(1);
    expect(mockFail.mock.calls[0]![3]).toContain("MinedRevert");
  });

  it("leaves AMBIGUITY pending — null is never terminal", async () => {
    pending = [INTENT];
    const result = await repairLaunchIdentities({ resolveLaunchOutcome: async () => null });
    expect(result).toMatchObject({ checked: 1, repaired: 0, failed: 0, stillPending: 1 });
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("treats a THROWING lookup as ambiguity, never as a revert", async () => {
    pending = [INTENT];
    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => { throw new Error("rpc down"); },
    });
    expect(result).toMatchObject({ stillPending: 1, failed: 0 });
    expect(mockFail).not.toHaveBeenCalled();
  });

  /**
   * F1: a launch that is simply not mined yet is the sweep's most ORDINARY
   * answer, and viem delivers it as a THROW. It used to be logged as a failure
   * every 30 s for as long as the row existed.
   *
   * The classification is asserted through an INJECTED dep, which is the point:
   * putting it only in the production wiring would leave every other caller —
   * and this suite — disagreeing with production about the noisiest path.
   */
  it("a not-yet-mined receipt is a SILENT pending, not a warn every 30 s", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    pending = [INTENT];
    const notFound = new Error("Transaction receipt with hash 0xhash could not be found. URL: https://rpc.example/KEY");
    notFound.name = "TransactionReceiptNotFoundError";

    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => { throw notFound; },
    });

    expect(result).toMatchObject({ stillPending: 1, failed: 0, repaired: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("a GENERIC transport failure still warns exactly once, with a scrubbed message", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    pending = [INTENT];

    await repairLaunchIdentities({
      resolveLaunchOutcome: async () => { throw new Error("connect ECONNREFUSED"); },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.at(0)?.at(0)).toBe("launch_identity_repair.lookup_failed");
    warnSpy.mockRestore();
  });

  it("CLAIMS its candidates — the rotation that stops 25 ambiguous rows starving row 26", async () => {
    pending = [INTENT];
    await repairLaunchIdentities({ resolveLaunchOutcome: async () => null });
    // The candidate query stamps `last_checked_at` on every row it hands out,
    // so an ambiguous row goes to the BACK of the queue instead of being
    // re-served forever by an unchanging `ORDER BY created_at`.
    expect(claimedWith).toEqual([25]);
  });

  it("stamps the created token onto the launch activity row so token history can find it", async () => {
    pending = [INTENT];
    await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "created", identity: { tokenAddress: "0xTOKEN" } }),
    });
    expect(mockStampIdentity).toHaveBeenCalledWith("0xhash", "0xTOKEN");
  });

  it("normalizes a ZERO prebuy to all-NULL initial_buy_*, exactly like the handler", async () => {
    pending = [{ ...INTENT, prebuyRaw: "0", prebuyDecimals: 18 }];
    await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "created", identity: { tokenAddress: "0xTOKEN" } }),
    });
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({
      initialBuyRaw: null,
      initialBuyDecimals: null,
      initialBuyTokenAddress: null,
    });
  });

  it("stores the intent's AUTHORIZED NATIVE prebuy in initial_buy_*", async () => {
    pending = [INTENT];
    await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "created", identity: { tokenAddress: "0xTOKEN" } }),
    });
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({
      initialBuyRaw: "300000000000000",
      initialBuyDecimals: 18,
      initialBuyTokenAddress: "0x0000000000000000000000000000000000000000",
    });
  });
});

/**
 * FAIRNESS, end to end: 25 permanently-ambiguous launches must not starve the
 * 26th forever.
 *
 * The table is simulated in memory with the claim's real semantics — order by
 * `COALESCE(last_checked_at, created_at)`, then STAMP every row served — because
 * this suite has no Postgres. The SQL that implements those semantics is pinned
 * separately in `db/repos/launch-sweep-claim.test.ts`; together they cover the
 * statement and the behavior it produces.
 */
describe("no permanently-ambiguous backlog can starve a resolvable launch", () => {
  it("reaches row 26 on the next tick instead of re-serving the same 25", async () => {
    const table = Array.from({ length: 26 }, (_, i) => ({
      ...INTENT,
      intentId: `i${i}`,
      txHash: `0xhash${i}`,
      createdAtMs: i,
      lastCheckedMs: null as number | null,
    }));
    // `i25` is the only one the chain can answer for.
    const resolvable = "i25";
    let clock = 1000;

    pending = [];
    // The claim, as SQL implements it: least-recently-checked first, stamped on
    // service.
    const claim = (limit: number) => {
      const batch = [...table]
        .sort((a, b) => (a.lastCheckedMs ?? a.createdAtMs) - (b.lastCheckedMs ?? b.createdAtMs)
          || a.intentId.localeCompare(b.intentId))
        .slice(0, limit);
      for (const row of batch) row.lastCheckedMs = clock++;
      return batch;
    };

    const deps = {
      resolveLaunchOutcome: async ({ txHash }: { txHash: string }) =>
        txHash === `0xhash25` ? { kind: "created" as const, identity: { tokenAddress: "0xTOKEN" } } : null,
    };

    const served: string[][] = [];
    for (let tick = 0; tick < 2; tick++) {
      pending = claim(25);
      served.push(pending.map((r) => (r as { intentId: string }).intentId));
      await repairLaunchIdentities(deps);
    }

    // Tick 1 sees the 25 oldest and resolves none of them.
    expect(served[0]).not.toContain(resolvable);
    // Tick 2 MUST reach the starved row — under the old `created_at ASC`
    // ordering it would have served the identical 25 forever.
    expect(served[1]).toContain(resolvable);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });
});
