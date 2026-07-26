/**
 * `broadcastStagedSolanaTx` — the shared landing-lane step every Solana/Jupiter
 * mutation handler uses after its `agent_activity` row is staged (landing-lane
 * design `solana-landing-lanes-design.md` D1/D2/D4/D5).
 *
 * Pins the three behaviours the 2026-07-24 funded gate proved were missing:
 *   - the lane a transaction takes is decided by PROVEN tip, not protocol name;
 *   - a definitive rejection is never dressed up as "broadcast, pending";
 *   - a matching acceptance records `markBroadcastAccepted`, exactly once,
 *     best-effort — the convention every EVM path already followed.
 *
 * Nothing here may terminalize a row: the K3 sweep stays the sole settlement
 * authority, so `failActivityEvent`/`confirmActivityEvent` must never be
 * reachable from this module (asserted by omission — the repo mock below
 * exposes only `markBroadcastAccepted`, so any other repo call would throw).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SendTransactionError } from "@solana/web3.js";

const mockSubmitPreparedTx = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-prepared-tx.js", () => ({
  submitPreparedTx: (...args: unknown[]) => mockSubmitPreparedTx(...args),
}));

const mockSubmitManagedExecute = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/submit-managed-execute.js", () => ({
  submitPreparedManagedExecute: (...args: unknown[]) => mockSubmitManagedExecute(...args),
}));

const mockSubmitOverRpc = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  submitPreparedTxOverRpc: (...args: unknown[]) => mockSubmitOverRpc(...args),
}));

const mockMarkBroadcastAccepted = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  markBroadcastAccepted: (...args: unknown[]) => mockMarkBroadcastAccepted(...args),
}));

const mockWarn = vi.fn();
vi.mock("@utils/logger.js", () => {
  const stub = { warn: (...a: unknown[]) => mockWarn(...a), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { broadcastStagedSolanaTx } = await import(
  "@vex-agent/tools/protocols/solana-jupiter/staged-broadcast.js"
);
const { JupiterSubmitTipProof } = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-tip-proof.js"
);
const { JUPITER_SUBMIT_MIN_TIP_LAMPORTS, JUPITER_TIP_RECEIVER_ADDRESSES } = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js"
);
const { VexError, ErrorCodes } = await import("../../../../../errors.js");
const { summarizeProtocolError } = await import(
  "@vex-agent/tools/protocols/runtime/errors.js"
);

const PREPARED = {
  serialized: new Uint8Array([9, 8, 7]),
  signature: "LocalCanonicalSig111",
  recentBlockhash: "FreshBlockhash111",
  lastValidBlockHeight: 4242,
};

function tipProof() {
  const proof = JupiterSubmitTipProof.certify({
    recipient: JUPITER_TIP_RECEIVER_ADDRESSES[0]!,
    lamports: BigInt(JUPITER_SUBMIT_MIN_TIP_LAMPORTS),
  });
  if (!proof) throw new Error("fixture: minimum tip to an allowlisted receiver must certify");
  return proof;
}

function rejectionCause(message: string) {
  const err = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, message);
  err.httpStatus = 400;
  return err;
}

describe("broadcastStagedSolanaTx — lane selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockSubmitPreparedTx.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockSubmitManagedExecute.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
  });

  it("routes a TIPLESS transaction over RPC — never Jupiter's tip-gated /submit", async () => {
    await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(mockSubmitOverRpc).toHaveBeenCalledTimes(1);
    expect(mockSubmitOverRpc).toHaveBeenCalledWith(PREPARED);
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    expect(mockSubmitManagedExecute).not.toHaveBeenCalled();
  });

  it("routes a PROVEN-TIP swap through /tx/v1/submit, passing the proof (regression: the tipped lane is preserved)", async () => {
    const proof = tipProof();

    await broadcastStagedSolanaTx({
      toolId: "solana.swap.execute", rowId: 7, prepared: PREPARED,
      lane: { kind: "jupiter_submit", tipProof: proof },
    });

    expect(mockSubmitPreparedTx).toHaveBeenCalledTimes(1);
    expect(mockSubmitPreparedTx).toHaveBeenCalledWith(PREPARED, proof);
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
  });

  it("routes a Forecast atomic_swap order through the provider-managed /execute (regression)", async () => {
    const context = { orderId: "abc", executionModel: "atomic_swap" };

    await broadcastStagedSolanaTx({
      toolId: "solana.predict.buy", rowId: 7, prepared: PREPARED,
      lane: { kind: "jupiter_managed_execute", context },
    });

    expect(mockSubmitManagedExecute).toHaveBeenCalledTimes(1);
    expect(mockSubmitManagedExecute).toHaveBeenCalledWith(PREPARED, context);
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
  });
});

describe("broadcastStagedSolanaTx — acceptance recording (design D5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
  });

  it("records markBroadcastAccepted EXACTLY once on a matching acceptance", async () => {
    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(mockMarkBroadcastAccepted).toHaveBeenCalledTimes(1);
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledWith(7);
    expect(result).toEqual({ kind: "accepted", signature: PREPARED.signature });
  });

  it("a THROW from markBroadcastAccepted does not roll back or fail the broadcast", async () => {
    mockMarkBroadcastAccepted.mockRejectedValue(new Error("db down"));

    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(result).toEqual({ kind: "accepted", signature: PREPARED.signature });
  });

  it("a CAS miss on markBroadcastAccepted is logged, not fatal", async () => {
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: false, row: {} });

    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(result.kind).toBe("accepted");
    expect(mockWarn).toHaveBeenCalledWith("solana.lend.deposit.broadcast_accept_miss", { rowId: 7 });
  });

  it("does NOT record acceptance for a signature mismatch — the persisted signature is never overwritten", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "signature_mismatch",
      localSignature: PREPARED.signature,
      providerSignature: "SomethingElse",
    });

    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(mockMarkBroadcastAccepted).not.toHaveBeenCalled();
    // The canonical LOCAL signature is what comes back, never the provider's.
    expect(result).toEqual({ kind: "signature_mismatch", signature: PREPARED.signature });
    expect(mockWarn).toHaveBeenCalledWith(
      "solana.lend.deposit.submit_signature_mismatch",
      expect.objectContaining({ rowId: 7, local: PREPARED.signature, provider: "SomethingElse" }),
    );
  });

  it("does NOT record acceptance on a definitive rejection or an ambiguous failure", async () => {
    mockSubmitOverRpc.mockResolvedValue({ kind: "rejected_before_broadcast", cause: rejectionCause("nope") });
    await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    mockSubmitOverRpc.mockResolvedValue({ kind: "transport_uncertain", cause: new Error("ECONNRESET") });
    await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 8, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(mockMarkBroadcastAccepted).not.toHaveBeenCalled();
  });
});

describe("broadcastStagedSolanaTx — definitive rejection vs ambiguous failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  });

  it("surfaces a definitive rejection with a SCRUBBED reason", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "rejected_before_broadcast",
      cause: rejectionCause("missing or insufficient tip at https://api.jup.ag/tx/v1/submit?key=SECRET123"),
    });

    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(result.kind).toBe("rejected_before_broadcast");
    if (result.kind !== "rejected_before_broadcast") throw new Error("unreachable");
    expect(result.reason).toContain("missing or insufficient tip");
    // Provider internals never reach the agent: the URL (and the key in it)
    // is replaced by the scrub boundary.
    expect(result.reason).not.toContain("SECRET123");
    expect(result.reason).not.toContain("https://");
  });

  it("keeps an ambiguous transport failure distinct and does NOT throw out of the module", async () => {
    mockSubmitOverRpc.mockResolvedValue({ kind: "transport_uncertain", cause: new Error("ECONNRESET") });

    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(result).toEqual({ kind: "transport_uncertain", signature: PREPARED.signature });
    expect(mockWarn).toHaveBeenCalledWith(
      "solana.lend.deposit.submit_transport_uncertain",
      expect.objectContaining({ rowId: 7 }),
    );
  });

  // ── Program-authored reason recovery ──────────────────────────────────────
  //
  // A `SendTransactionError` is what the RPC lane classifies as a definitive
  // rejection. web3.js formats it with the program logs embedded as a JSON
  // array, which the scrub boundary (correctly) collapses to `[body]` — so the
  // program's own error NAME was being deleted by our own redaction and the
  // agent was left holding `custom program error: 0x1773`, which nothing in
  // this tree decodes. The reason is recovered from the structured logs BEFORE
  // the scrub, so what survives the cap is the program's sentence.

  it("surfaces the PROGRAM's own Error Message instead of an undecodable hex code", async () => {
    const cause = new SendTransactionError({
      action: "simulate",
      signature: "",
      transactionMessage:
        "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1773",
      logs: [
        "Program jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc invoke [1]",
        "Program log: Instruction: Deposit",
        "Program log: AnchorError occurred. Error Code: FTokenDepositInsignificant. Error Number: 6003. Error Message: Deposit amount is too small.",
        "Program jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc failed: custom program error: 0x1773",
      ],
    });
    mockSubmitOverRpc.mockResolvedValue({ kind: "rejected_before_broadcast", cause });

    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    expect(result.kind).toBe("rejected_before_broadcast");
    if (result.kind !== "rejected_before_broadcast") throw new Error("unreachable");
    expect(result.reason).toBe("Deposit amount is too small.");
    // What the agent used to get, and must no longer get: an error number with
    // no decoder, a scrubbed-away log dump, and advice to call a method it
    // cannot call.
    expect(result.reason).not.toContain("0x1773");
    expect(result.reason).not.toContain("[body]");
    expect(result.reason).not.toContain("getLogs");
  });

  it("degrades EXACTLY as before when the rejection carries no program-authored line", async () => {
    const cause = new SendTransactionError({
      action: "simulate",
      signature: "",
      transactionMessage: "Transaction simulation failed: insufficient funds for rent",
    });
    mockSubmitOverRpc.mockResolvedValue({ kind: "rejected_before_broadcast", cause });

    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    if (result.kind !== "rejected_before_broadcast") throw new Error("unreachable");
    // Byte-for-byte the summary of the RAW throw — no recovery, no invention.
    expect(result.reason).toBe(summarizeProtocolError(cause).message);
    expect(result.reason).toContain("insufficient funds for rent");
  });

  it("still scrubs the recovered text — it is chain-controlled input, not trusted", async () => {
    const cause = new SendTransactionError({
      action: "simulate",
      signature: "",
      transactionMessage: "Transaction simulation failed",
      logs: [
        "Program log: AnchorError occurred. Error Code: X. Error Number: 1. Error Message: refused, see https://evil.example.com/x?key=LEAKED123",
      ],
    });
    mockSubmitOverRpc.mockResolvedValue({ kind: "rejected_before_broadcast", cause });

    const result = await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    if (result.kind !== "rejected_before_broadcast") throw new Error("unreachable");
    expect(result.reason).toContain("refused");
    expect(result.reason).not.toContain("LEAKED123");
    expect(result.reason).not.toContain("evil.example.com");
  });

  it("never logs the signed transaction bytes on any path", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "rejected_before_broadcast",
      cause: rejectionCause("simulation failed"),
    });

    await broadcastStagedSolanaTx({
      toolId: "solana.lend.deposit", rowId: 7, prepared: PREPARED, lane: { kind: "rpc" },
    });

    const logged = JSON.stringify(mockWarn.mock.calls);
    expect(logged).not.toContain(Buffer.from(PREPARED.serialized).toString("base64"));
    expect(logged).not.toContain("serialized");
  });
});
