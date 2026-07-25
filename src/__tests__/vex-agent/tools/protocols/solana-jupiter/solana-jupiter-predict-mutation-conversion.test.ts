/**
 * `solana.predict.buy`/`.sell`/`.claim`/`.closeAll` — W5 staged-Solana-seam
 * mutation conversion (design `w5-design.md` §2/§3/§5, REVISION 1 R1/R2,
 * REVISION 2 R2b, card K5). Mirrors the mocking recipe in
 * `solana-jupiter-lend-mutation-conversion.test.ts` (K6) — every external
 * boundary mocked: the Jupiter Prediction REST client (request-only, no
 * signing), the K2 staged-seam primitives (`prepareVersionedTx`,
 * `submitPreparedTx`), and the `agent_activity` repo façade. Pins the
 * write-protocol ORDER (request -> intent -> sign -> persist -> submit), the
 * truthful-pending contract (never a fabricated confirm), and the R5
 * closeAll contract (validate-all -> create-all-rows -> item-wise, N=0
 * defined, no aggregate success claim).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const SIGNER = Keypair.generate();
const WALLET_ADDRESS = SIGNER.publicKey.toBase58();

const mockResolveSigningWallet = vi.fn(() => ({
  family: "solana" as const, address: WALLET_ADDRESS, secretKey: SIGNER.secretKey,
}));
const mockResolveSelectedAddress = vi.fn(() => WALLET_ADDRESS);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: unknown[]) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

function requireTx(tx: string | null | undefined, feature: string): string {
  if (!tx) throw new Error(`${feature} did not return an executable transaction.`);
  return tx;
}

// NOTE (2026-07-25): this file used to hand-roll a copy of the routing gate
// here — `executionModel !== "atomic_swap" -> null`. That copy encoded the very
// bug that made every prediction mutation unexecutable, so the suite passed
// while the product could not place a single order. The REAL
// `resolveManagedExecution` is wired into the service mock below; the routing
// gate is never re-implemented in a test again.

const mockRequestBuy = vi.fn();
const mockRequestSell = vi.fn();
const mockRequestCloseAll = vi.fn();
const mockRequestClaim = vi.fn();
type ManagedExecutionModule =
  typeof import("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/managed-execution.js");

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", async () => ({
  getJupiterPredictionEvents: vi.fn(),
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionMarket: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
  getJupiterPredictionPosition: vi.fn(),
  getJupiterPredictionPositions: vi.fn(),
  getJupiterPredictionHistory: vi.fn(),
  requestJupiterPredictionCreateOrderTransaction: (...args: unknown[]) => mockRequestBuy(...args),
  requestJupiterPredictionClosePositionTransaction: (...args: unknown[]) => mockRequestSell(...args),
  requestJupiterPredictionCloseAllPositionsTransactions: (...args: unknown[]) => mockRequestCloseAll(...args),
  requestJupiterPredictionClaimPositionTransaction: (...args: unknown[]) => mockRequestClaim(...args),
  requireTransaction: requireTx,
  resolveManagedExecution: (
    await vi.importActual<ManagedExecutionModule>(
      "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/managed-execution.js",
    )
  ).resolveManagedExecution,
}));

const mockPrepareVersionedTx = vi.fn();
const mockSubmitOverRpc = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  prepareVersionedTx: (...args: unknown[]) => mockPrepareVersionedTx(...args),
  submitPreparedTxOverRpc: (...args: unknown[]) => mockSubmitOverRpc(...args),
}));

// Present only so the test can PROVE it is never reached: a keeper-filled
// prediction transaction is provider-built and TIPLESS, so Jupiter's
// tip-gated `/tx/v1/submit` would drop it (2026-07-24 funded-gate defect).
const mockSubmitPreparedTx = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-prepared-tx.js", () => ({
  submitPreparedTx: (...args: unknown[]) => mockSubmitPreparedTx(...args),
}));

const mockSubmitPreparedManagedExecute = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/submit-managed-execute.js", () => ({
  submitPreparedManagedExecute: (...args: unknown[]) => mockSubmitPreparedManagedExecute(...args),
}));

vi.mock("@tools/solana-ecosystem/shared/solana-validation.js", () => ({
  solanaExplorerUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}`,
}));

const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn();
const mockMarkActivitySolanaBroadcast = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockMarkBroadcastAccepted = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  markBroadcastAccepted: (...args: unknown[]) => mockMarkBroadcastAccepted(...args),
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivitySolanaBroadcast: (...args: unknown[]) => mockMarkActivitySolanaBroadcast(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { PREDICT_HANDLERS } = await import("@vex-agent/tools/protocols/solana-jupiter/handlers/predict.js");

function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    ...over,
  };
}

const PREPARED = {
  serialized: new Uint8Array([1, 2, 3]),
  signature: "LocalSig111",
  recentBlockhash: "FreshBlockhash111",
  lastValidBlockHeight: 12345,
};

const BUY_ORDER = {
  transaction: "unsigned-buy-tx-b64",
  order: {
    orderPubkey: "order-1", positionPubkey: "pos-1", marketId: "mkt-1",
    orderCostUsd: "10000000", newSizeUsd: "10000000", newPayoutUsd: "18000000",
    estimatedTotalFeeUsd: "100000",
  },
};
const SELL_ORDER = {
  transaction: "unsigned-sell-tx-b64",
  order: { orderPubkey: "order-2", positionPubkey: "pos-1", marketId: "mkt-1", newPayoutUsd: "18000000", estimatedTotalFeeUsd: "100000" },
};
const CLAIM_POSITION = {
  transaction: "unsigned-claim-tx-b64",
  position: { positionPubkey: "pos-1", payoutAmountUsd: "20000000" },
};

describe("solana.predict.buy/.sell/.claim/.closeAll — staged Solana seam (K5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSigningWallet.mockReturnValue({ family: "solana", address: WALLET_ADDRESS, secretKey: SIGNER.secretKey });
    mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
    mockRequestBuy.mockResolvedValue(structuredClone(BUY_ORDER));
    mockRequestSell.mockResolvedValue(structuredClone(SELL_ORDER));
    mockRequestClaim.mockResolvedValue(structuredClone(CLAIM_POSITION));
    mockRequestCloseAll.mockResolvedValue({ data: [] });
    mockPrepareVersionedTx.mockResolvedValue(PREPARED);
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockSubmitPreparedManagedExecute.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }] });
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 43, event: { id: 8 } });
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
  });

  // ── buy ──────────────────────────────────────────────────────────

  it("buy: records the intent BEFORE signing (kind='prediction', chainFamily='solana', tokenIn=USDC), then signs/persists/submits in order", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockRequestBuy).toHaveBeenCalledWith(expect.objectContaining({
      ownerPubkey: WALLET_ADDRESS, marketId: "mkt-1", isYes: true, isBuy: true, depositAmount: 10_000_000,
    }));
    expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0]).toMatchObject({
      eventIndex: 0, eventRole: "predict_buy", kind: "prediction", protocol: "jupiter",
      chainId: 20_011_000_000, chainFamily: "solana", walletAddress: WALLET_ADDRESS,
      sessionId: "session-1", tokenIn: { tokenAddress: expect.any(String), amountRaw: "10000000" },
      usdInEst: "10.000000",
    });
    expect(intentArg.events[0].tokenOut).toBeUndefined();

    expect(mockPrepareVersionedTx).toHaveBeenCalledWith("unsigned-buy-tx-b64", expect.any(Keypair));
    expect(mockMarkActivitySolanaBroadcast).toHaveBeenCalledWith(7, {
      txHash: PREPARED.signature, fromAddress: WALLET_ADDRESS,
      recentBlockhash: PREPARED.recentBlockhash, lastValidBlockHeight: PREPARED.lastValidBlockHeight,
    });
    // TIPLESS keeper-filled order -> RPC lane, never /tx/v1/submit.
    expect(mockSubmitOverRpc).toHaveBeenCalledWith(PREPARED);
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledTimes(1);

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
    const data = result.data as Record<string, unknown>;
    expect(data._executionId).toBe(42);
    expect(data.status).toBe("pending");
    expect(data.signature).toBe(PREPARED.signature);
  });

  it("buy: rejects an invalid side without ever calling the provider", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "maybe", amountUsdc: 10 }, ctx(),
    );
    expect(result.success).toBe(false);
    expect(mockRequestBuy).not.toHaveBeenCalled();
  });

  it("buy: a provider rejection is a PRE-broadcast failure — no intent row, no signing", async () => {
    mockRequestBuy.mockRejectedValue(new Error("market is closed for trading"));

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    const failArg = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0][0];
    expect(failArg.event).toMatchObject({ failureCode: "route_not_found", kind: "prediction", chainFamily: "solana" });
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toContain("market is closed for trading");
    expect((result.data as Record<string, unknown>)._executionId).toBe(43);
  });

  it("buy: a null transaction in the response is ALSO a PRE-broadcast failure", async () => {
    mockRequestBuy.mockResolvedValue({ transaction: null, order: BUY_ORDER.order });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("buy: a sole-signer refusal (prepareVersionedTx throws) finalizes the EXISTING row via failActivityEvent — never a second intent", async () => {
    mockPrepareVersionedTx.mockRejectedValue(new Error("Refusing to sign: transaction requires 2 signers, expected exactly 1."));

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockFailActivityEvent).toHaveBeenCalledWith(7, expect.objectContaining({ failureCode: "unknown" }));
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockMarkActivitySolanaBroadcast).not.toHaveBeenCalled();
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>)._executionId).toBe(42);
  });

  it("buy: a staging CAS miss refuses to submit untracked — submitPreparedTx is never called, failActivityEvent is NOT called either", async () => {
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: false, row: {} });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("buy: a submit signature mismatch stays truthful-pending — never terminalizes", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "signature_mismatch", localSignature: PREPARED.signature, providerSignature: "OtherSig",
    });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
    expect((result.data as Record<string, unknown>).signature).toBe(PREPARED.signature);
  });

  it("buy: an AMBIGUOUS transport failure is caught, never propagated — row stays pending for the sweep", async () => {
    mockSubmitOverRpc.mockResolvedValue({ kind: "transport_uncertain", cause: new Error("fetch failed") });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
    expect((result.data as Record<string, unknown>).status).toBe("pending");
  });

  it("buy: a DEFINITIVE rejection is reported as rejected, never as a pending broadcast, and never terminalizes", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "rejected_before_broadcast",
      cause: new Error("Simulation failed. Message: market is closed."),
    });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(result.output).toMatch(/rejected before broadcast/i);
    expect(result.output).toMatch(/nothing went on-chain/i);
    expect(result.output).not.toMatch(/confirmation pending/i);
    expect(result.output).toContain("market is closed");
    expect((result.data as Record<string, unknown>).status).toBe("rejected_before_broadcast");
    // Lifecycle unchanged — the sweep stays the sole terminality authority.
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockMarkBroadcastAccepted).not.toHaveBeenCalled();
  });

  it("buy: fails closed without an active session — no provider call, no recording", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx({ sessionId: undefined }),
    );

    expect(result.success).toBe(false);
    expect(mockRequestBuy).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
  });

  // ── sell / claim ─────────────────────────────────────────────────

  it("sell: records tokenOut (payout estimate) with role predict_sell (NOT predict_close — that role is reserved for closeAll's fan-out)", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.sell"]!({ positionPubkey: "pos-1" }, ctx());

    expect(mockRequestSell).toHaveBeenCalledWith("pos-1", { ownerPubkey: WALLET_ADDRESS });
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0]).toMatchObject({ eventRole: "predict_sell", kind: "prediction" });
    expect(intentArg.events[0].tokenIn).toBeUndefined();
    expect(intentArg.events[0].tokenOut).toMatchObject({ amountRaw: "18000000" });
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).status).toBe("pending");
  });

  it("claim: records tokenOut (payout) with role predict_claim", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.claim"]!({ positionPubkey: "pos-1" }, ctx());

    expect(mockRequestClaim).toHaveBeenCalledWith("pos-1", { ownerPubkey: WALLET_ADDRESS });
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0]).toMatchObject({ eventRole: "predict_claim", kind: "prediction" });
    expect(intentArg.events[0].tokenOut).toMatchObject({ amountRaw: "20000000" });
    expect(result.success).toBe(false);
  });

  // ── closeAll ─────────────────────────────────────────────────────

  it("closeAll: N=0 returns an explicit success with zero rows — no intent created", async () => {
    mockRequestCloseAll.mockResolvedValue({ data: [] });

    const result = await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 100 }, ctx());

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).count).toBe(0);
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
  });

  it("closeAll: creates ALL N rows atomically in ONE execution BEFORE the first signature, then signs item-wise", async () => {
    mockRequestCloseAll.mockResolvedValue({
      data: [
        { transaction: "close-tx-1", order: { positionPubkey: "pos-1", newPayoutUsd: "5000000" } },
        { transaction: "close-tx-2", position: { positionPubkey: "pos-2", payoutAmountUsd: "7000000" } },
      ],
    });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 99, events: [{ id: 1 }, { id: 2 }] });
    mockPrepareVersionedTx
      .mockResolvedValueOnce({ ...PREPARED, signature: "Sig1" })
      .mockResolvedValueOnce({ ...PREPARED, signature: "Sig2" });

    const result = await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 100 }, ctx());

    expect(mockRequestCloseAll).toHaveBeenCalledWith({ ownerPubkey: WALLET_ADDRESS, minSellPriceSlippageBps: 100 });
    expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events).toHaveLength(2);
    expect(intentArg.events[0]).toMatchObject({ eventIndex: 0, eventRole: "predict_close" });
    expect(intentArg.events[1]).toMatchObject({ eventIndex: 1, eventRole: "predict_claim" });

    expect(mockPrepareVersionedTx).toHaveBeenNthCalledWith(1, "close-tx-1", expect.any(Keypair));
    expect(mockPrepareVersionedTx).toHaveBeenNthCalledWith(2, "close-tx-2", expect.any(Keypair));

    // Never an aggregate success claim while items are unconfirmed (R5).
    expect(result.success).toBe(false);
    const data = result.data as { count: number; results: Array<{ status: string; positionPubkey: string }> };
    expect(data.count).toBe(2);
    expect(data.results).toHaveLength(2);
    expect(data.results.every(r => r.status === "pending")).toBe(true);
  });

  it("closeAll: a per-item post-intent failure finalizes ONLY that item's row and the loop continues to the next item", async () => {
    mockRequestCloseAll.mockResolvedValue({
      data: [
        { transaction: "close-tx-1", order: { positionPubkey: "pos-1", newPayoutUsd: "5000000" } },
        { transaction: "close-tx-2", order: { positionPubkey: "pos-2", newPayoutUsd: "6000000" } },
      ],
    });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 99, events: [{ id: 1 }, { id: 2 }] });
    mockPrepareVersionedTx
      .mockRejectedValueOnce(new Error("sole-signer violation"))
      .mockResolvedValueOnce({ ...PREPARED, signature: "Sig2" });

    const result = await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 100 }, ctx());

    expect(mockFailActivityEvent).toHaveBeenCalledWith(1, expect.objectContaining({ failureCode: "unknown" }));
    // Item 2 still gets signed/submitted — the loop did not abort.
    expect(mockSubmitOverRpc).toHaveBeenCalledTimes(1);
    const data = result.data as { results: Array<{ status: string; positionPubkey: string }> };
    expect(data.results[0]).toMatchObject({ positionPubkey: "pos-1", status: "failed" });
    expect(data.results[1]).toMatchObject({ positionPubkey: "pos-2", status: "pending" });
    expect(result.success).toBe(false);
  });

  it("closeAll: a request-level rejection is a PRE-broadcast failure — no rows created", async () => {
    mockRequestCloseAll.mockRejectedValue(new Error("upstream unavailable"));

    const result = await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 100 }, ctx());

    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("closeAll: rejects without minSellPriceSlippageBps — no default, no provider call (Batch-4-closure blocker 2)", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.closeAll"]!({}, ctx());

    expect(result.success).toBe(false);
    expect(result.output).toContain("minSellPriceSlippageBps");
    expect(mockRequestCloseAll).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
  });

  // ── Managed-execution routing (corrected 2026-07-25, live-proven) ──
  //
  // Fixtures below use the REAL wire shapes captured from the live API on
  // 2026-07-25 (`agents_dm/verify/probe-predict-execution-lanes.ts`): a
  // keeper-filled Polymarket build carries `execution` with NO
  // `executionModel`, and a Forecast build carries both.

  const TX_META = { blockhash: "FLKPrEqhgW8cNrjdSFuSnKSp4h9ScB6KjYxWPKMPTqCv", lastValidBlockHeight: 413108534 };
  const KEEPER_EXECUTION = { endpoint: "/api/v1/execute", context: { type: "create_order" } };

  it("buy: a KEEPER-FILLED build (execution present, NO executionModel) routes through managed /execute — the exact case that could never execute before", async () => {
    mockRequestBuy.mockResolvedValue({
      ...structuredClone(BUY_ORDER),
      txMeta: TX_META,
      requiredSigners: [WALLET_ADDRESS],
      execution: KEEPER_EXECUTION,
    });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockSubmitPreparedManagedExecute).toHaveBeenCalledWith(PREPARED, { type: "create_order" });
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
  });

  it("buy: a keeper-filled build signs under the coSigned contract with the response's OWN txMeta as VERIFY evidence — never a replaced blockhash", async () => {
    mockRequestBuy.mockResolvedValue({
      ...structuredClone(BUY_ORDER),
      txMeta: TX_META,
      requiredSigners: [WALLET_ADDRESS],
      execution: KEEPER_EXECUTION,
    });

    await PREDICT_HANDLERS["solana.predict.buy"]!({ marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx());

    expect(mockPrepareVersionedTx).toHaveBeenCalledWith(
      "unsigned-buy-tx-b64",
      expect.anything(),
      {
        knownBlockhash: TX_META,
        signerContract: { kind: "coSigned", requiredSigners: [WALLET_ADDRESS] },
      },
    );
  });

  it("buy: a build with NO execution object keeps today's lane exactly — sole-signer contract, REPLACE-mode blockhash, raw RPC", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockPrepareVersionedTx).toHaveBeenCalledWith("unsigned-buy-tx-b64", expect.anything());
    expect(mockSubmitOverRpc).toHaveBeenCalledTimes(1);
    expect(mockSubmitPreparedManagedExecute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("buy: a FORECAST build (executionModel atomic_swap) routes through the same managed /execute path with its context unchanged", async () => {
    const forecastContext = { type: "bisonfi_swap", jupiterSwapRequestId: "req-1", ownerPubkey: WALLET_ADDRESS };
    mockRequestBuy.mockResolvedValue({
      ...structuredClone(BUY_ORDER),
      txMeta: TX_META,
      executionModel: "atomic_swap",
      requiredSigners: [WALLET_ADDRESS],
      execution: { endpoint: "/api/v1/execute", context: forecastContext },
    });

    await PREDICT_HANDLERS["solana.predict.buy"]!({ marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx());

    expect(mockSubmitPreparedManagedExecute).toHaveBeenCalledWith(PREPARED, forecastContext);
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
  });

  it("buy: a managed build that names an UNRECOGNISED execute endpoint is a PRE-broadcast failure — never routed, never signed", async () => {
    mockRequestBuy.mockResolvedValue({
      ...structuredClone(BUY_ORDER),
      txMeta: TX_META,
      requiredSigners: [WALLET_ADDRESS],
      execution: { endpoint: "https://evil.example.com/execute", context: { type: "create_order" } },
    });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
    expect(mockSubmitPreparedManagedExecute).not.toHaveBeenCalled();
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("buy: a managed build with no requiredSigners is a PRE-broadcast failure (fail-closed — Vex never signs a transaction whose signer set it cannot verify)", async () => {
    mockRequestBuy.mockResolvedValue({
      ...structuredClone(BUY_ORDER),
      txMeta: TX_META,
      execution: KEEPER_EXECUTION,
    });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("buy: a managed build with no txMeta is a PRE-broadcast failure — the blockhash cannot be refreshed without voiding the provider's signatures", async () => {
    mockRequestBuy.mockResolvedValue({
      ...structuredClone(BUY_ORDER),
      requiredSigners: [WALLET_ADDRESS],
      execution: KEEPER_EXECUTION,
    });

    const result = await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("sell: a keeper-filled close build routes through managed /execute too", async () => {
    mockRequestSell.mockResolvedValue({
      ...structuredClone(SELL_ORDER),
      txMeta: TX_META,
      requiredSigners: [WALLET_ADDRESS],
      execution: { endpoint: "/api/v1/execute", context: { type: "close_position" } },
    });

    await PREDICT_HANDLERS["solana.predict.sell"]!({ positionPubkey: "pos-1" }, ctx());

    expect(mockSubmitPreparedManagedExecute).toHaveBeenCalledWith(PREPARED, { type: "close_position" });
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
  });

  it("claim: reads the response instead of assuming keeper execution — a claim build carrying execution routes through managed /execute", async () => {
    mockRequestClaim.mockResolvedValue({
      ...structuredClone(CLAIM_POSITION),
      txMeta: TX_META,
      requiredSigners: [WALLET_ADDRESS],
      execution: { endpoint: "/api/v1/execute", context: { type: "claim_position" } },
    });

    await PREDICT_HANDLERS["solana.predict.claim"]!({ positionPubkey: "pos-1" }, ctx());

    expect(mockSubmitPreparedManagedExecute).toHaveBeenCalledWith(PREPARED, { type: "claim_position" });
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
  });

  it("closeAll: routes each item independently by ITS OWN execution object — managed for the one that has it, today's RPC lane for the one that does not", async () => {
    mockRequestCloseAll.mockResolvedValue({
      data: [
        {
          transaction: "close-tx-1",
          order: { positionPubkey: "pos-1", newPayoutUsd: "5000000" },
          txMeta: TX_META,
          requiredSigners: [WALLET_ADDRESS],
          execution: { endpoint: "/api/v1/execute", context: { type: "close_position" } },
        },
        { transaction: "close-tx-2", position: { positionPubkey: "pos-2", payoutAmountUsd: "7000000" } },
      ],
    });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 99, events: [{ id: 1 }, { id: 2 }] });
    mockPrepareVersionedTx
      .mockResolvedValueOnce({ ...PREPARED, signature: "Sig1" })
      .mockResolvedValueOnce({ ...PREPARED, signature: "Sig2" });

    const result = await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 100 }, ctx());

    expect(mockSubmitPreparedManagedExecute).toHaveBeenCalledTimes(1);
    expect(mockSubmitPreparedManagedExecute).toHaveBeenCalledWith(
      { ...PREPARED, signature: "Sig1" }, { type: "close_position" },
    );
    expect(mockSubmitOverRpc).toHaveBeenCalledTimes(1);
    expect(mockSubmitOverRpc).toHaveBeenCalledWith({ ...PREPARED, signature: "Sig2" });
    expect(result.success).toBe(false);
  });

});
