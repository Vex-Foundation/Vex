/**
 * THE FEE RUNNER'S OUTCOME HONESTY, and its post-stage fence.
 *
 * Two properties, both about money that has already moved:
 *
 *   1. ONCE THE CHAIN HAS SPOKEN, BOOKKEEPING CANNOT RE-DECIDE. A fee transfer
 *      that reverted, reverted; one whose receipt could not be read is
 *      unconfirmed and keeps its hash for the sweep. If the durable write ABOUT
 *      that outcome fails, the report is unchanged. The two red-without-fix
 *      cases below are exactly the shape the old single-`try` runner got wrong:
 *      it reported `not_attempted` with NO hash for a transaction that was
 *      really broadcast, which drops the only handle a sweep has and invites a
 *      second transfer for a fee that may already have been paid.
 *
 *   2. A REFUSAL BETWEEN SIGNING AND SUBMITTING SENDS NOTHING, and says so
 *      durably. The staged row already carries the hash of bytes that exist, so
 *      it is terminalized as signed-but-not-submitted rather than left pending
 *      for a sweep to chase a transaction nobody sent.
 *
 * Nothing here may throw, and no arm may touch the parent action.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { NativeFeeLegPlan } from "@vex-agent/tools/protocols/shared/native-fee-leg/plan.js";

const signStageBroadcast = vi.fn();
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({ signStageBroadcast }));

const markActivityBroadcast = vi.fn();
const markBroadcastAccepted = vi.fn();
const confirmActivityEvent = vi.fn();
const failActivityEvent = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
}));

const noteHandlerPendingReason = vi.fn();
vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason,
}));

const { runNativeFeeLeg } = await import(
  "@vex-agent/tools/protocols/shared/native-fee-leg/run.js"
);

const TREASURY = "0x1111111111111111111111111111111111111111" as const;
const FEE_ROW = 42;
const TX_HASH = "0xfee0000000000000000000000000000000000000000000000000000000000001";

const VENUE = {
  logPrefix: "wallet.transaction.fee",
  displayName: "Vex",
  nativeDecimals: 18,
} as const;

function plan(): NativeFeeLegPlan<string> {
  return {
    feeWei: 2_500_000_000_000_000n,
    netWei: 0n,
    txParams: { to: TREASURY, data: "0x", value: 2_500_000_000_000_000n },
    event: {} as NativeFeeLegPlan<string>["event"],
    disclosure: {} as NativeFeeLegPlan<string>["disclosure"],
  };
}

function input(overrides: Record<string, unknown> = {}): Parameters<typeof runNativeFeeLeg>[1] {
  return {
    plan: plan(),
    feeRowId: FEE_ROW,
    chainId: 8453,
    publicClient: {} as never,
    signer: {} as never,
    ...overrides,
  } as Parameters<typeof runNativeFeeLeg>[1];
}

/** Drive the primitive's staging hook, then answer with `outcome`. */
function broadcasts(outcome: unknown): void {
  signStageBroadcast.mockImplementation(
    async (
      _pub: unknown,
      _signer: unknown,
      _tx: unknown,
      hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
    ) => {
      await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: TREASURY, nonce: 3 });
      await hooks.onAccepted();
      return outcome;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  markActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
  markBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  confirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  failActivityEvent.mockResolvedValue({ applied: true, row: { status: "definitively_failed" } });
  noteHandlerPendingReason.mockResolvedValue(undefined);
});

describe("T-FEE 8: a broadcast outcome survives a failed durable write", () => {
  it("RED WITHOUT THE FIX - a reverted fee stays `reverted` WITH its hash when failActivityEvent throws", async () => {
    broadcasts({ kind: "reverted", txHash: TX_HASH, receipt: { blockNumber: 9n } });
    failActivityEvent.mockRejectedValue(new Error("database unavailable"));

    const report = await runNativeFeeLeg(VENUE, input());

    // The old runner caught this throw in the same `try` as the broadcast and
    // answered `not_attempted` with `txHash: null` - a real on-chain revert
    // reported as a transfer that never happened.
    expect(report.collection).toBe("reverted");
    expect(report.txHash).toBe(TX_HASH);
  });

  it("RED WITHOUT THE FIX - an ambiguous fee stays `unconfirmed` WITH its hash when the pending note throws", async () => {
    broadcasts({ kind: "ambiguous", txHash: TX_HASH, stage: "confirm", reason: "no receipt yet" });
    noteHandlerPendingReason.mockRejectedValue(new Error("database unavailable"));

    const report = await runNativeFeeLeg(VENUE, input());

    // The hash is the ONLY handle the receipt sweep has on bytes that are in
    // flight. Losing it to a bookkeeping failure is how a fee gets paid twice.
    expect(report.collection).toBe("unconfirmed");
    expect(report.txHash).toBe(TX_HASH);
  });

  it("reports a confirmed fee as unrecorded, never as failed, when the confirm write throws", async () => {
    broadcasts({ kind: "confirmed", txHash: TX_HASH, receipt: { blockNumber: 9n } });
    confirmActivityEvent.mockRejectedValue(new Error("database unavailable"));

    const report = await runNativeFeeLeg(VENUE, input());
    expect(report.collection).toBe("confirmed_unrecorded");
    expect(report.txHash).toBe(TX_HASH);
  });

  it("renders the executed human amount with the VENUE's decimals, not an assumed 18", async () => {
    broadcasts({ kind: "confirmed", txHash: TX_HASH, receipt: { blockNumber: 9n } });

    await runNativeFeeLeg({ ...VENUE, nativeDecimals: 6 }, input());

    expect(confirmActivityEvent).toHaveBeenCalledWith(FEE_ROW, {
      executedAmountInRaw: "2500000000000000",
      executedAmountInHuman: "2500000000",
    });
  });
});

describe("T-FEE 7 and 9: a refusal before the network sends nothing", () => {
  it("reports `not_attempted` with no hash when the primitive refuses before signing", async () => {
    signStageBroadcast.mockRejectedValue(new Error("gas estimate failed"));

    const report = await runNativeFeeLeg(VENUE, input());
    expect(report.collection).toBe("not_attempted");
    expect(report.txHash).toBeNull();
    expect(failActivityEvent).not.toHaveBeenCalled();
  });

  it("aborts the submit when the post-stage gate refuses, and terminalizes the STAGED row", async () => {
    let submitted = false;
    signStageBroadcast.mockImplementation(
      async (
        _pub: unknown,
        _signer: unknown,
        _tx: unknown,
        hooks: { onHashStaged: (h: unknown) => Promise<void> },
      ) => {
        await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: TREASURY, nonce: 3 });
        // Only reached if the gate allowed it. The real primitive calls
        // `sendRawTransaction` at exactly this point.
        submitted = true;
        return { kind: "confirmed", txHash: TX_HASH, receipt: { blockNumber: 9n } };
      },
    );

    const report = await runNativeFeeLeg(
      VENUE,
      input({ afterStageBeforeSubmit: async () => "refuse" }),
    );

    expect(submitted).toBe(false);
    expect(report.collection).toBe("not_attempted");
    expect(report.txHash).toBeNull();
    // THE EXACT DURABLE WRITE: the existing closed vocabulary, and a sentence
    // that says bytes were signed and nothing was sent.
    expect(failActivityEvent).toHaveBeenCalledWith(FEE_ROW, {
      failureCode: "unknown",
      failureReason:
        "not submitted: authority could not be proven current after signing and staging; sendRawTransaction was never invoked",
    });
  });

  it("stages FIRST and gates SECOND - the row carries the hash before anything decides", async () => {
    const order: string[] = [];
    markActivityBroadcast.mockImplementation(async () => {
      order.push("stage");
      return { applied: true, row: {} };
    });
    signStageBroadcast.mockImplementation(
      async (
        _pub: unknown,
        _signer: unknown,
        _tx: unknown,
        hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
      ) => {
        await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: TREASURY, nonce: 3 });
        await hooks.onAccepted();
        return { kind: "confirmed", txHash: TX_HASH, receipt: { blockNumber: 9n } };
      },
    );

    await runNativeFeeLeg(
      VENUE,
      input({
        afterStageBeforeSubmit: async () => {
          order.push("gate");
          return "proceed";
        },
      }),
    );

    expect(order).toEqual(["stage", "gate"]);
  });

  it("retries the not-submitted write, bounded, and never throws when every attempt fails", async () => {
    signStageBroadcast.mockImplementation(
      async (
        _pub: unknown,
        _signer: unknown,
        _tx: unknown,
        hooks: { onHashStaged: (h: unknown) => Promise<void> },
      ) => {
        await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: TREASURY, nonce: 3 });
        return { kind: "confirmed", txHash: TX_HASH, receipt: { blockNumber: 9n } };
      },
    );
    failActivityEvent.mockRejectedValue(new Error("database unavailable"));

    const report = await runNativeFeeLeg(
      VENUE,
      input({ afterStageBeforeSubmit: async () => "refuse" }),
    );

    expect(failActivityEvent).toHaveBeenCalledTimes(3);
    expect(report.collection).toBe("not_attempted");
  });

  it("does not retry a CAS MISS - somebody else already terminalized the row", async () => {
    signStageBroadcast.mockImplementation(
      async (
        _pub: unknown,
        _signer: unknown,
        _tx: unknown,
        hooks: { onHashStaged: (h: unknown) => Promise<void> },
      ) => {
        await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: TREASURY, nonce: 3 });
        return { kind: "confirmed", txHash: TX_HASH, receipt: { blockNumber: 9n } };
      },
    );
    failActivityEvent.mockResolvedValue({ applied: false, row: { status: "confirmed" } });

    await runNativeFeeLeg(VENUE, input({ afterStageBeforeSubmit: async () => "refuse" }));
    expect(failActivityEvent).toHaveBeenCalledTimes(1);
  });
});

describe("the approved fee-leg ceiling reaches the signing primitive", () => {
  it("forwards `bounds` to signStageBroadcast as its seventh argument", async () => {
    broadcasts({ kind: "confirmed", txHash: TX_HASH, receipt: { blockNumber: 9n } });
    const bounds = { mode: "eip1559", gasLimit: 42_000n, maxFeePerGasWei: 5n, maxPriorityFeePerGasWei: 1n };

    await runNativeFeeLeg(VENUE, input({ bounds }));

    expect(signStageBroadcast.mock.calls[0]?.[6]).toEqual(bounds);
  });

  it("passes NO bounds when a venue supplies none, so every existing caller is unchanged", async () => {
    broadcasts({ kind: "confirmed", txHash: TX_HASH, receipt: { blockNumber: 9n } });
    await runNativeFeeLeg(VENUE, input());
    expect(signStageBroadcast.mock.calls[0]?.[6]).toBeUndefined();
  });
});
