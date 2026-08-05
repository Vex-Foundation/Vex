import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  BUY_ORDER, CLAIM_POSITION, ctx, mockCreateAgentActivityIntent, mockCreateAgentActivityPreBroadcastFailure,
  mockFailActivityEvent, mockMarkActivitySolanaBroadcast, mockMarkBroadcastAccepted, mockPrepareVersionedTx,
  mockRequestBuy, mockRequestClaim, mockRequestCloseAll, mockRequestSell, mockResolveSelectedAddress,
  mockResolveSigningWallet, mockSubmitOverRpc, mockSubmitPreparedManagedExecute, mockSubmitPreparedTx,
  PREDICT_HANDLERS, PREPARED, SELL_ORDER, SIGNER, WALLET_ADDRESS,
} from "./solana-jupiter-predict-mutation-conversion.test-fixtures.js";

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
    // W2g: prediction has no quote and no route, so a hardcoded
    // `route_not_found` told the agent to hunt for liquidity that was never
    // the problem. The row now carries what Jupiter actually said, classified
    // by `provider-failure-mapping.ts` — and `market_closed` maps to the
    // enum's honest catch-all rather than to a specific WRONG code.
    expect(failArg.event).toMatchObject({ failureCode: "unknown", kind: "prediction", chainFamily: "solana" });
    expect(failArg.event.failureReason).toMatch(/^market_closed: /);
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

  // CORRECTED 2026-07-25 (phase-3 W2): both used to require `tokenOut.amountRaw`
  // to equal the provider's micro-USD payout ESTIMATE — pinning the defect, a USD
  // figure stored as an atomic token quantity. Payout-leg identity is now owned by
  // `predict-payout-asset-labelling.test.ts`; these two keep their subject, ROLE.
  it("sell: records the payout tokenOut with role predict_sell (NOT predict_close — that role is reserved for closeAll's fan-out)", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.sell"]!({ positionPubkey: "pos-1" }, ctx());

    expect(mockRequestSell).toHaveBeenCalledWith("pos-1", { ownerPubkey: WALLET_ADDRESS });
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0]).toMatchObject({ eventRole: "predict_sell", kind: "prediction" });
    expect(intentArg.events[0].tokenIn).toBeUndefined();
    expect(intentArg.events[0].tokenOut).toMatchObject({ tokenSymbol: "JupUSD" });
    expect(intentArg.events[0].tokenOut.amountRaw).toBeUndefined();
    expect(intentArg.events[0].usdOutEst).toBe("18.000000");
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).status).toBe("pending");
  });

  it("claim: records the payout tokenOut with role predict_claim", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.claim"]!({ positionPubkey: "pos-1" }, ctx());

    expect(mockRequestClaim).toHaveBeenCalledWith("pos-1", { ownerPubkey: WALLET_ADDRESS });
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0]).toMatchObject({ eventRole: "predict_claim", kind: "prediction" });
    expect(intentArg.events[0].tokenOut).toMatchObject({ tokenSymbol: "JupUSD" });
    expect(intentArg.events[0].tokenOut.amountRaw).toBeUndefined();
    expect(intentArg.events[0].usdOutEst).toBe("20.000000");
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
