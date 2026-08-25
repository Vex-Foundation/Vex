/**
 * THE ORDERING GUARANTEE, at the handler.
 *
 * The whole reason the fee is a separate later leg is that a transaction that
 * did not happen must never be charged, and a fee that fails must never change
 * what happened to the transaction. Both are properties of WHEN the fee leg runs
 * and of what the handler does with its answer, so they are tested at the
 * handler:
 *
 *   the fee row is created inside the T2 CLAIM, before anything is signed;
 *   the fee leg is signed ONLY on the confirmed arm;
 *   on every other arm the pre-created row is finalized never-attempted, AFTER
 *     the transaction's own settlement;
 *   a refused, reverted or unconfirmed fee leaves the confirmed result intact.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

const getById = vi.fn();
vi.mock("@vex-agent/db/repos/wallet-transaction-intents.js", () => ({ getById }));

const claimTransactionIntent = vi.fn();
vi.mock("@vex-agent/tools/internal/wallet/transaction/activity-writer.js", () => ({
  claimTransactionIntent,
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: `0x${"11".repeat(32)}` }),
  walletScopeErrorToResult: () => ({ success: false, output: "wallet scope error" }),
}));

const captureAuthorityAnchor = vi.fn();
const recheckAuthority = vi.fn();
const recheckAuthorityWith = vi.fn();
vi.mock("@vex-agent/tools/internal/wallet/transaction/authority-fence.js", () => ({
  captureAuthorityAnchor,
  recheckAuthority,
  recheckAuthorityWith,
}));

const settleTerminalRows = vi.fn();
vi.mock("@vex-agent/tools/internal/wallet/transaction/terminal-settlement.js", () => ({
  settleTerminalRows,
  TerminalSettlementConflictError: class extends Error {},
}));

const abortPlannedEvents = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({ abortPlannedEvents }));

const runNativeFeeLeg = vi.fn();
vi.mock("@vex-agent/tools/protocols/shared/native-fee-leg/run.js", () => ({
  runNativeFeeLeg,
  nativeFeeNotAttempted: (reason: string) => ({
    collection: "not_attempted",
    collectionNote: reason,
    txHash: null,
  }),
  nativeFeeNotCharged: () => ({ collection: "not_charged", collectionNote: "", txHash: null }),
}));

const signStageBroadcast = vi.fn();
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast,
  StagedFeeBoundsExceededError: class extends Error {},
}));

const { handleWalletEvmTransactionConfirm } = await import(
  "@vex-agent/tools/internal/wallet/transaction/confirm-evm.js"
);
const { digestOfIntent } = await import(
  "@vex-agent/tools/internal/wallet/transaction/revalidate.js"
);
const { canonicalTransactionPreview } = await import(
  "@vex-agent/tools/internal/wallet/transaction/preview.js"
);

const WALLET = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const ONE_GWEI = 1_000_000_000n;
const ACTION_HASH = "0xac00000000000000000000000000000000000000000000000000000000000001";

/** One ETH: 25 bps is 0.0025 ETH, far above the 42000-gas collection cost. */
const CHARGED_VALUE = "1000000000000000000";
/** Dust: 25 bps of it does not clear its own collection cost. */
const UNCHARGED_VALUE = "1000000000000";

function intent(valueWei: string): WalletTransactionIntent {
  const base: WalletTransactionIntent = {
    intentId: "wtx-1",
    sessionId: "session-1",
    walletAddress: WALLET,
    family: "eip155",
    chainAlias: "base",
    chainId: 8453,
    payload: { family: "eip155", evm: { to: TO, data: "0x", valueWei } },
    decoded: {
      family: "eip155",
      role: "native_transfer",
      standard: "native",
      functionName: "nativeTransfer",
      contract: null,
      criticalArgs: { recipient: TO, valueWei },
      unlimitedApproval: false,
      warnings: [],
    },
    preview: { label: "", criticalArgs: {} },
    feeBounds: {
      mode: "eip1559",
      gasLimit: "21000",
      maxFeePerGasWei: ONE_GWEI.toString(),
      maxPriorityFeePerGasWei: "1000000",
      maxTotalFeeWei: (21_000n * ONE_GWEI).toString(),
    },
    proposalDigest: "",
    proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
    recentBlockhash: null,
    lastValidBlockHeight: null,
    status: "pending",
    failureStage: null,
    activityId: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
  };
  // The SAME renderer the digest preimage uses, and the narrow durable type:
  // `canonicalPreviewOfIntent` returns the wider approval-card shape.
  const carded: WalletTransactionIntent = {
    ...base,
    preview: canonicalTransactionPreview({
      family: base.family,
      chainAlias: base.chainAlias,
      decoded: base.decoded,
      feeBounds: base.feeBounds,
      evmValueWei: valueWei,
    }),
  };
  return { ...carded, proposalDigest: digestOfIntent(carded) };
}

const EXECUTION_ID = 7;
const FEE_ROW_ID = 99;

function context(): InternalToolContext {
  return {
    sessionId: "session-1",
    approved: false,
    sessionPermission: "full",
    walletResolution: {},
    walletPolicy: {},
  } as unknown as InternalToolContext;
}

const deps = {
  chainFactory: async () => ({
    chainId: 8453,
    chainAlias: "base",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    getCode: async () => "0x",
    simulate: async () => ({ ok: true as const, value: undefined }),
    estimateFees: async () => ({
      suggestedGasLimit: "21000",
      suggestedMaxFeePerGasWei: "1",
      suggestedMaxPriorityFeePerGasWei: "1",
      suggestedGasPriceWei: "1",
      supportsEip1559: true,
    }),
  }),
  signerClientsFactory: async () => ({
    publicClient: {} as never,
    chain: { id: 8453 } as never,
    createWalletClient: () => ({}) as never,
    chainName: "Base",
  }),
} as unknown as Parameters<typeof handleWalletEvmTransactionConfirm>[2];

/** The action's own staged broadcast answers `outcome`. */
function actionOutcome(outcome: unknown): void {
  signStageBroadcast.mockImplementation(
    async (
      _pub: unknown,
      _signer: unknown,
      _tx: unknown,
      hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
    ) => {
      await hooks.onHashStaged({ txHash: ACTION_HASH, fromAddress: WALLET, nonce: 1 });
      await hooks.onAccepted();
      return outcome;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  captureAuthorityAnchor.mockResolvedValue({ ok: true, value: { anchor: true } });
  recheckAuthority.mockResolvedValue({ ok: true, value: undefined });
  recheckAuthorityWith.mockResolvedValue({ ok: true, value: undefined });
  settleTerminalRows.mockResolvedValue(undefined);
  abortPlannedEvents.mockResolvedValue([]);
  runNativeFeeLeg.mockResolvedValue({
    collection: "confirmed",
    collectionNote: "The Vex fee was transferred to the treasury.",
    txHash: "0xfee1",
  });
  claimTransactionIntent.mockImplementation(async (row: WalletTransactionIntent) => ({
    ok: true,
    intent: row,
    activity: {
      executionId: EXECUTION_ID,
      activityId: 1,
      feeRowId: FEE_ROW_ID,
      startedAtMs: Date.now(),
      stageEvm: async () => undefined,
      stageSolana: async () => undefined,
      noteAccepted: async () => undefined,
    },
  }));
  actionOutcome({ kind: "confirmed", txHash: ACTION_HASH, receipt: { blockNumber: 11n } });
});

async function confirm(valueWei = CHARGED_VALUE): Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  output?: string;
}> {
  getById.mockResolvedValue(intent(valueWei));
  return (await handleWalletEvmTransactionConfirm(
    { intentId: "wtx-1" },
    context(),
    deps,
  )) as { success: boolean; data?: Record<string, unknown>; output?: string };
}

describe("T-FEE 3 and 6: the fee row is created in the claim, and signed only after confirmation", () => {
  it("passes the planned fee event into the claim transaction, with the exact fee amount", async () => {
    await confirm();
    const plannedEvent = claimTransactionIntent.mock.calls[0]?.[3] as
      | { eventRole?: string; kind?: string; tokenIn?: { amountRaw?: string } }
      | null;
    expect(plannedEvent).not.toBeNull();
    expect(plannedEvent?.eventRole).toBe("tx_vex_fee");
    expect(plannedEvent?.kind).toBe("transaction");
    expect(plannedEvent?.tokenIn?.amountRaw).toBe("2500000000000000");
  });

  it("passes NO fee event when nothing is charged, so no row exists to finalize", async () => {
    await confirm(UNCHARGED_VALUE);
    expect(claimTransactionIntent.mock.calls[0]?.[3]).toBeNull();
    expect(runNativeFeeLeg).not.toHaveBeenCalled();
  });

  it("signs the fee leg only AFTER the action confirmed, anchored on its block", async () => {
    await confirm();
    expect(runNativeFeeLeg).toHaveBeenCalledTimes(1);
    const legInput = runNativeFeeLeg.mock.calls[0]?.[1] as {
      feeRowId: number;
      priorLeg: { blockNumber: bigint };
      bounds: { gasLimit: bigint };
    };
    expect(legInput.feeRowId).toBe(FEE_ROW_ID);
    // The block the action confirmed in: the fee's own gas estimate must not run
    // against a node that has not yet applied it.
    expect(legInput.priorLeg).toEqual({ blockNumber: 11n });
    // Its OWN ceiling, not the action's 21000.
    expect(legInput.bounds.gasLimit).toBe(42_000n);
  });

  it("reports the collected fee on the confirmed result", async () => {
    const result = await confirm();
    expect(result.success).toBe(true);
    expect(result.data?.vexFee).toMatchObject({
      collection: "confirmed",
      txHash: "0xfee1",
      plannedFeeWei: "2500000000000000",
      collectedFeeWei: "2500000000000000",
    });
  });

  it("states the reason on the confirmed result when no fee applies", async () => {
    const result = await confirm(UNCHARGED_VALUE);
    expect(result.data?.vexFee).toMatchObject({
      collection: "not_charged",
      reason: "at_or_below_collection_cost",
    });
  });
});

describe("T-FEE 6: a transaction that did not confirm is never charged", () => {
  it("never signs a fee for a REVERTED transaction, and finalizes the row never-attempted", async () => {
    actionOutcome({ kind: "reverted", txHash: ACTION_HASH, receipt: { blockNumber: 11n } });
    const result = await confirm();

    expect(runNativeFeeLeg).not.toHaveBeenCalled();
    expect(result.data?.outcome).toBe("chain_failed");
    // AFTER the settlement: the transaction's own three rows reach their
    // terminal state first, and this write cannot delay or alter them.
    expect(settleTerminalRows).toHaveBeenCalled();
    expect(abortPlannedEvents).toHaveBeenCalledWith(EXECUTION_ID, 1, expect.stringContaining("chain_failed"));
    expect(settleTerminalRows.mock.invocationCallOrder[0]).toBeLessThan(
      abortPlannedEvents.mock.invocationCallOrder[0]!,
    );
  });

  it("never signs a fee for an AMBIGUOUS transaction", async () => {
    actionOutcome({ kind: "ambiguous", txHash: ACTION_HASH, stage: "confirm", reason: "no receipt" });
    const result = await confirm();
    expect(runNativeFeeLeg).not.toHaveBeenCalled();
    expect(result.data?.outcome).toBe("confirmation_unknown");
    expect(abortPlannedEvents).toHaveBeenCalledWith(EXECUTION_ID, 1, expect.any(String));
  });

  it("never signs a fee when the action refused before broadcast", async () => {
    signStageBroadcast.mockRejectedValue(new Error("estimate failed"));
    const result = await confirm();
    expect(runNativeFeeLeg).not.toHaveBeenCalled();
    expect(result.data?.outcome).toBe("pre_broadcast_failed");
    expect(abortPlannedEvents).toHaveBeenCalledWith(EXECUTION_ID, 1, expect.any(String));
  });
});

describe("T-FEE 7 and 9: a failed fee never fails the transaction", () => {
  it("keeps the confirmed result when the fee is refused at a fence", async () => {
    runNativeFeeLeg.mockResolvedValue({
      collection: "not_attempted",
      collectionNote: "refused before signing",
      txHash: null,
    });
    const result = await confirm();

    expect(result.success).toBe(true);
    expect(result.data?.outcome).toBe("confirmed");
    expect(result.data?.txHash).toBe(ACTION_HASH);
    expect(result.data?.vexFee).toMatchObject({ collection: "not_attempted" });
    // A refused leg's hashless row is finalized so it does not sit pending.
    expect(abortPlannedEvents).toHaveBeenCalledWith(EXECUTION_ID, 1, expect.any(String));
  });

  it("keeps the confirmed result when the fee REVERTS, and never exposes a collected amount", async () => {
    runNativeFeeLeg.mockResolvedValue({
      collection: "reverted",
      collectionNote: "the fee transfer reverted",
      txHash: "0xfee2",
    });
    const result = await confirm();

    expect(result.data?.outcome).toBe("confirmed");
    const fee = result.data?.vexFee as Record<string, unknown>;
    expect(fee.collection).toBe("reverted");
    expect(fee.plannedFeeWei).toBe("2500000000000000");
    // A reverted fee moved nothing. There must be no field a reader could take
    // for money that changed hands.
    expect(fee.collectedFeeWei).toBeUndefined();
  });

  it("keeps the confirmed result when the fee is UNCONFIRMED, and keeps its hash", async () => {
    runNativeFeeLeg.mockResolvedValue({
      collection: "unconfirmed",
      collectionNote: "broadcast, not confirmed this turn",
      txHash: "0xfee3",
    });
    const result = await confirm();

    expect(result.data?.outcome).toBe("confirmed");
    const fee = result.data?.vexFee as Record<string, unknown>;
    expect(fee.collection).toBe("unconfirmed");
    expect(fee.txHash).toBe("0xfee3");
    expect(fee.collectedFeeWei).toBeUndefined();
    // NEVER finalized: the row keeps its staged hash for the receipt sweep.
    expect(abortPlannedEvents).not.toHaveBeenCalled();
  });
});

describe("T-FEE 9: the fee leg carries its OWN authority fences", () => {
  it("re-asks the authority before signing the fee, not only before the action", async () => {
    await confirm();
    const signer = (runNativeFeeLeg.mock.calls[0]?.[1] as { signer: { onBeforeSign: () => Promise<void> } }).signer;
    recheckAuthority.mockClear();
    await signer.onBeforeSign();
    expect(recheckAuthority).toHaveBeenCalledWith({ anchor: true }, "pre_sign");
  });

  it("refuses to sign the fee when the authority has been replaced", async () => {
    await confirm();
    const signer = (runNativeFeeLeg.mock.calls[0]?.[1] as { signer: { onBeforeSign: () => Promise<void> } }).signer;
    recheckAuthority.mockResolvedValue({ ok: false, refusal: { code: "forbidden_field", message: "revoked" } });
    await expect(signer.onBeforeSign()).rejects.toThrow();
  });

  it("gates the fee submit on a fresh pre-submit recheck", async () => {
    await confirm();
    const gate = (runNativeFeeLeg.mock.calls[0]?.[1] as {
      afterStageBeforeSubmit: () => Promise<string>;
    }).afterStageBeforeSubmit;

    recheckAuthority.mockResolvedValue({ ok: true, value: undefined });
    expect(await gate()).toBe("proceed");
    recheckAuthority.mockResolvedValue({ ok: false, refusal: { code: "forbidden_field", message: "revoked" } });
    expect(await gate()).toBe("refuse");
    expect(recheckAuthority).toHaveBeenLastCalledWith({ anchor: true }, "pre_submit");
  });
});
