/**
 * `executeSolanaTransfer` - the staged write path and the exact-decimal amount
 * (migration 084).
 *
 * WHAT THESE PIN, and why each one is worth a test:
 *
 *  - THE FLOAT FIX. The lamport amount used to be
 *    `BigInt(Math.round(Number(amount) * 1e9))`, which routes real money through
 *    a float. The regression case below (`0.000000000123456789` scale and a
 *    9-decimal amount past 2^53) returns a DIFFERENT number of lamports under
 *    that expression than under exact arithmetic, so this test goes red the
 *    moment the float is reintroduced.
 *  - THE SAME BIGINT ON BOTH SIDES. The amount signed into the instruction and
 *    the amount written to the durable row are asserted to be the same value.
 *  - THE ORDERING. Sign, stage the signature plus blockhash evidence, THEN
 *    submit. A staging failure must abort before submission.
 *  - AMBIGUITY. A confirmation-unknown outcome writes nothing terminal and
 *    completes no execution: the money is genuinely unresolved.
 *
 * The Solana RPC and the durable writer are faked at their module boundaries;
 * the transfer's own assembly, amount arithmetic and ordering stay real, because
 * those are the subject.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey, SystemInstruction, SystemProgram } from "@solana/web3.js";
import { parseUnits } from "viem";

import type { SolanaWallet } from "@tools/wallet/multi-auth.js";
import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";

type SolanaTxModule = typeof import("@tools/solana-ecosystem/shared/solana-transaction.js");
type ActivityWriterModule = typeof import("@vex-agent/tools/internal/wallet/send/activity-writer.js");

const SIGNATURE = "5".repeat(88);
const BLOCKHASH = "H".repeat(43);

const mockGetBalance = vi.fn<() => Promise<number>>();
const mockConnection = { getBalance: (...a: unknown[]) => mockGetBalance(...(a as [])) };

const mockPrepareLegacyTx = vi.fn<SolanaTxModule["prepareLegacyTx"]>();
/**
 * The CLASSIFYING submit lane. The executor no
 * longer calls `submitPreparedLegacyTxStaged`, whose throw-on-send contract
 * cannot distinguish a node refusing the bytes from a response lost after the
 * node took them.
 */
const mockSubmitOverRpc = vi.fn<SolanaTxModule["submitPreparedTxOverRpc"]>();
const mockConfirmStaged = vi.fn<SolanaTxModule["confirmStagedSignature"]>();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  getSolanaConnection: () => mockConnection,
  prepareLegacyTx: (...args: Parameters<SolanaTxModule["prepareLegacyTx"]>) => mockPrepareLegacyTx(...args),
  submitPreparedTxOverRpc: (...args: Parameters<SolanaTxModule["submitPreparedTxOverRpc"]>) =>
    mockSubmitOverRpc(...args),
  confirmStagedSignature: (...args: Parameters<SolanaTxModule["confirmStagedSignature"]>) =>
    mockConfirmStaged(...args),
}));

vi.mock("@tools/solana-ecosystem/shared/solana-validation.js", () => ({
  solanaExplorerUrl: (sig: string) => `https://explorer.example/${sig}`,
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  resolveJupiterToken: async () => {
    throw new Error("no jupiter key in tests");
  },
}));

const activityHandle = {
  executionId: 91,
  rowId: 13,
  stageEvm: vi.fn(async () => {}),
  stageSolana: vi.fn(async () => {}),
  noteAccepted: vi.fn(async () => {}),
  confirm: vi.fn(async () => {}),
  fail: vi.fn(async () => {}),
  completeExecution: vi.fn(async () => {}),
};
const mockOpenActivity = vi.fn<ActivityWriterModule["openWalletTransferActivity"]>(
  async () => activityHandle,
);
const mockRecordPlanFailure = vi.fn<ActivityWriterModule["recordWalletTransferPlanFailure"]>(
  async () => {},
);
vi.mock("@vex-agent/tools/internal/wallet/send/activity-writer.js", () => ({
  openWalletTransferActivity: (...args: Parameters<ActivityWriterModule["openWalletTransferActivity"]>) =>
    mockOpenActivity(...args),
  recordWalletTransferPlanFailure: (...args: Parameters<ActivityWriterModule["recordWalletTransferPlanFailure"]>) =>
    mockRecordPlanFailure(...args),
}));

const { executeSolanaTransfer } = await import(
  "../../../../../vex-agent/tools/internal/wallet/send-execute-solana.js"
);

const KEYPAIR = Keypair.generate();
const WALLET: SolanaWallet = {
  family: "solana",
  address: KEYPAIR.publicKey.toBase58(),
  secretKey: KEYPAIR.secretKey,
} as SolanaWallet;
const TO = Keypair.generate().publicKey.toBase58();

function makeIntent(overrides: Partial<WalletIntent> = {}): WalletIntent {
  return {
    intentId: "intent-sol-1",
    sessionId: "session-1",
    walletAddress: WALLET.address,
    network: "solana" as WalletIntent["network"],
    chainAlias: null,
    toAddress: TO,
    amount: "0.5",
    token: null,
    previewJson: {},
    status: "pending" as WalletIntent["status"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    idempotencyKey: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenActivity.mockResolvedValue(activityHandle);
  mockGetBalance.mockResolvedValue(Number.MAX_SAFE_INTEGER);
  mockPrepareLegacyTx.mockResolvedValue({
    serialized: new Uint8Array([1, 2, 3]),
    signature: SIGNATURE,
    recentBlockhash: BLOCKHASH,
    lastValidBlockHeight: 4242,
  });
  mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: SIGNATURE });
  mockConfirmStaged.mockResolvedValue({ signature: SIGNATURE, phase: "confirmed" });
});

/** The lamports the assembled SystemProgram.transfer instruction actually carries. */
function signedLamports(): bigint {
  const transaction = mockPrepareLegacyTx.mock.calls[0]![0];
  const decoded = SystemInstruction.decodeTransfer(transaction.instructions[0]!);
  return BigInt(decoded.lamports.toString());
}

describe("executeSolanaTransfer - exact decimal amounts", () => {
  it("derives lamports by exact arithmetic, not through a float", async () => {
    // 9-decimal SOL past 2^53 atomic units. `Number("9007199.254740993") * 1e9`
    // cannot represent this value, so the old `Math.round(Number(...))` returns
    // a DIFFERENT lamport count than the operator authorized.
    const amount = "9007199.254740993";
    // Enough lamports on hand that the balance gate is not what this measures.
    mockGetBalance.mockResolvedValue(1e18);
    const exact = parseUnits(amount, 9);
    const viaFloat = BigInt(Math.round(Number(amount) * 1e9));
    expect(viaFloat).not.toBe(exact); // the defect is real, not hypothetical

    await executeSolanaTransfer(makeIntent({ amount }), WALLET);

    expect(signedLamports()).toBe(exact);
  });

  it("writes the SAME bigint to the durable row that it signs into the instruction", async () => {
    await executeSolanaTransfer(makeIntent({ amount: "0.123456789" }), WALLET);

    const plan = mockOpenActivity.mock.calls[0]![1];
    expect(plan.amountRaw).toBe(signedLamports());
    expect(plan.amountRaw).toBe(parseUnits("0.123456789", 9));
    expect(plan.amountHuman).toBe("0.123456789");
    expect(plan.tokenDecimals).toBe(9);
    expect(plan.chainFamily).toBe("solana");
  });
});

describe("executeSolanaTransfer - staged write path", () => {
  it("opens the row, signs, stages signature + blockhash evidence, THEN submits", async () => {
    const order: string[] = [];
    mockOpenActivity.mockImplementation(async () => {
      order.push("intent");
      return activityHandle;
    });
    mockPrepareLegacyTx.mockImplementation(async () => {
      order.push("sign");
      return {
        serialized: new Uint8Array([1]),
        signature: SIGNATURE,
        recentBlockhash: BLOCKHASH,
        lastValidBlockHeight: 4242,
      };
    });
    activityHandle.stageSolana.mockImplementation(async () => {
      order.push("stage");
    });
    mockSubmitOverRpc.mockImplementation(async () => {
      order.push("submit");
      return { kind: "accepted", signature: SIGNATURE };
    });

    const outcome = await executeSolanaTransfer(makeIntent(), WALLET);

    expect(order).toEqual(["intent", "sign", "stage", "submit"]);
    // The 049 CHECK needs both evidence fields the moment a Solana row stages.
    expect(activityHandle.stageSolana).toHaveBeenCalledWith({
      signature: SIGNATURE,
      fromAddress: KEYPAIR.publicKey.toBase58(),
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: 4242,
    });
    expect(outcome.kind).toBe("confirmed");
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "confirmed", txHash: SIGNATURE,
    });
  });

  it("aborts before submission when the stage CAS misses", async () => {
    activityHandle.stageSolana.mockRejectedValueOnce(new Error("CAS miss"));

    const outcome = await executeSolanaTransfer(makeIntent(), WALLET);

    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("pre_broadcast_failed");
    // The EXISTING event is finalized - never a second execution row.
    expect(activityHandle.fail).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "broadcast_error" }),
    );
    expect(mockRecordPlanFailure).not.toHaveBeenCalled();
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "failed_before_broadcast",
    });
  });

  it("refuses to sign when the durable row cannot be written", async () => {
    mockOpenActivity.mockRejectedValueOnce(new Error("db down"));

    const outcome = await executeSolanaTransfer(makeIntent(), WALLET);

    expect(outcome.kind).toBe("pre_broadcast_failed");
    expect(mockPrepareLegacyTx).not.toHaveBeenCalled();
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
  });

  it("leaves an unknown confirmation PENDING on the activity row, but still closes the tool attempt", async () => {
    mockConfirmStaged.mockResolvedValue({
      signature: SIGNATURE, phase: "confirmation_unknown", errorKind: "VexError", errorHash: "abcd",
    });

    const outcome = await executeSolanaTransfer(makeIntent(), WALLET);

    expect(outcome.kind).toBe("confirmation_unknown");
    // The CHAIN state is unresolved: nothing terminal, and never a resend.
    expect(activityHandle.fail).not.toHaveBeenCalled();
    expect(activityHandle.confirm).not.toHaveBeenCalled();
    expect(mockSubmitOverRpc).toHaveBeenCalledTimes(1);
    // The wallet lane PRESERVES its pre-existing submit bound: adopting the
    // shared classifier must not expand retry semantics on this money path.
    expect(mockSubmitOverRpc.mock.calls[0]![1]).toMatchObject({ maxRetries: 2 });
    // The TOOL ATTEMPT is over, so its execution row is closed - otherwise the
    // compaction safe-moment gate, which selects `execution_status = 'intent'`
    // independently of `agent_activity`, would block forever.
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "confirmation_unknown", txHash: SIGNATURE,
    });
  });

  it("does NOT terminalize a transport-uncertain submit: the bytes may already be on the network", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "transport_uncertain", cause: new Error("socket hang up"),
    });

    const outcome = await executeSolanaTransfer(makeIntent(), WALLET);

    // THE DEFECT THIS PINS: reporting a lost response as `pre_broadcast_failed`
    // failed the activity row and returned no hash, while the staged signature
    // could still land - a money gate clearing on a transfer that went through.
    expect(outcome.kind).toBe("confirmation_unknown");
    if (outcome.kind === "confirmation_unknown") expect(outcome.txHash).toBe(SIGNATURE);
    expect(activityHandle.fail).not.toHaveBeenCalled();
    expect(activityHandle.confirm).not.toHaveBeenCalled();
    // Not confirmed either: the node never told us it took the bytes.
    expect(mockConfirmStaged).not.toHaveBeenCalled();
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "confirmation_unknown", txHash: SIGNATURE,
    });
  });

  it("does NOT terminalize a signature mismatch, and keeps the STAGED signature as the identity", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "signature_mismatch",
      localSignature: SIGNATURE,
      providerSignature: "some-other-signature",
    });

    const outcome = await executeSolanaTransfer(makeIntent(), WALLET);

    expect(outcome.kind).toBe("confirmation_unknown");
    // Never the provider's divergent echo: the staged value is what the durable
    // row holds and what the sweep will resolve.
    if (outcome.kind === "confirmation_unknown") expect(outcome.txHash).toBe(SIGNATURE);
    expect(activityHandle.fail).not.toHaveBeenCalled();
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "confirmation_unknown", txHash: SIGNATURE,
    });
  });

  it("terminalizes ONLY a definitive node refusal", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "rejected_before_broadcast", cause: new Error("preflight failed"),
    });

    const outcome = await executeSolanaTransfer(makeIntent(), WALLET);

    // The node ANSWERED and refused, so nothing reached the network.
    expect(outcome.kind).toBe("pre_broadcast_failed");
    expect(activityHandle.fail).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "broadcast_error" }),
    );
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "failed_before_broadcast",
    });
  });

  it("finalizes a definitive chain failure and completes the execution", async () => {
    mockConfirmStaged.mockResolvedValue({
      signature: SIGNATURE, phase: "chain_failed", errorKind: "VexError", errorHash: "beef",
    });

    const outcome = await executeSolanaTransfer(makeIntent(), WALLET);

    expect(outcome.kind).toBe("chain_failed");
    expect(activityHandle.fail).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "mined_revert" }),
    );
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "reverted", txHash: SIGNATURE,
    });
  });

  it("writes ONE hashless terminal row when the plan cannot be resolved, and signs nothing", async () => {
    // Insufficient balance is decided before any intent row exists.
    mockGetBalance.mockResolvedValue(1);

    const outcome = await executeSolanaTransfer(makeIntent({ amount: "5" }), WALLET);

    expect(outcome.kind).toBe("pre_broadcast_failed");
    expect(mockOpenActivity).not.toHaveBeenCalled();
    expect(mockPrepareLegacyTx).not.toHaveBeenCalled();
    expect(mockRecordPlanFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordPlanFailure.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ failureCode: "allowance_or_balance", chainFamily: "solana" }),
    );
  });
});

/** Guards the fixture itself: a wrong recipient would make every assertion above vacuous. */
describe("executeSolanaTransfer - instruction shape", () => {
  it("sends to the intent's recipient from the session wallet", async () => {
    await executeSolanaTransfer(makeIntent(), WALLET);

    const transaction = mockPrepareLegacyTx.mock.calls[0]![0];
    const decoded = SystemInstruction.decodeTransfer(transaction.instructions[0]!);
    expect(decoded.toPubkey.equals(new PublicKey(TO))).toBe(true);
    expect(decoded.fromPubkey.equals(KEYPAIR.publicKey)).toBe(true);
  });
});
