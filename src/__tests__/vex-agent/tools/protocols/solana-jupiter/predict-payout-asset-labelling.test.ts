/**
 * Prediction payout leg — asset LABELLING and the absence of a fabricated
 * amount (phase-3 W2, live-gate DEFECT 7).
 *
 * Two properties, and they must hold together or the row lies:
 *
 *  1. The out leg is JupUSD (`JUPITER_PREDICTION_PAYOUT_MINT`, 6 decimals),
 *     never the USDC the position was bought with. Chain-proven on the sell
 *     `5AChd2vmZt…`, whose only mint is JupUSD.
 *  2. NO raw/human token amount is written. `newPayoutUsd` / `payoutAmountUsd`
 *     are USD-denominated ESTIMATES; they were previously copied verbatim into
 *     `amountRaw` and only looked right because JupUSD is 6-decimal and
 *     dollar-pegged. That is a coincidence, not a proof. The estimate stays in
 *     `usdOutEst`, which is honestly named; the token amount stays absent until
 *     the phase-4 keeper/order-status lane can read the settled quantity.
 *
 * Covers all FOUR payout call sites: `.sell`, `.claim`, and BOTH roles
 * `.closeAll` fans out (`predict_close` for a close item, `predict_claim` for
 * a claim item).
 *
 * Mocking recipe mirrors `solana-jupiter-predict-mutation-conversion.test.ts`
 * — the REAL `resolveManagedExecution` is wired in rather than re-implemented,
 * for the reason recorded in that file: a hand-rolled copy of a routing gate
 * once kept the suite green while the product could not execute at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import {
  JUPITER_PREDICTION_PAYOUT_DECIMALS,
  JUPITER_PREDICTION_PAYOUT_MINT,
  JUPITER_PREDICTION_PAYOUT_SYMBOL,
  JUPITER_PREDICTION_USDC_MINT,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SIGNER = Keypair.generate();
const WALLET_ADDRESS = SIGNER.publicKey.toBase58();

const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => ({
  family: "solana" as const, address: WALLET_ADDRESS, secretKey: SIGNER.secretKey,
}));
const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => WALLET_ADDRESS);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: Parameters<WalletResolveModule["resolveSigningWallet"]>) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) => mockResolveSelectedAddress(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

function requireTx(tx: string | null | undefined, feature: string): string {
  if (!tx) throw new Error(`${feature} did not return an executable transaction.`);
  return tx;
}

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

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-prepared-tx.js", () => ({
  submitPreparedTx: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/submit-managed-execute.js", () => ({
  submitPreparedManagedExecute: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/shared/solana-validation.js", () => ({
  solanaExplorerUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}`,
}));

const mockCreateAgentActivityIntent = vi.fn();
const mockMarkActivitySolanaBroadcast = vi.fn();
const mockMarkBroadcastAccepted = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  markBroadcastAccepted: (...args: unknown[]) => mockMarkBroadcastAccepted(...args),
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: vi.fn(),
  markActivitySolanaBroadcast: (...args: unknown[]) => mockMarkActivitySolanaBroadcast(...args),
  failActivityEvent: vi.fn(),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { PREDICT_HANDLERS } = await import("@vex-agent/tools/protocols/solana-jupiter/handlers/predict.js");

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

const PREPARED = {
  serialized: new Uint8Array([1, 2, 3]),
  signature: "LocalSig111",
  recentBlockhash: "FreshBlockhash111",
  lastValidBlockHeight: 12345,
};

/** The provider's payout figures are micro-USD estimates; 18000000 = $18.000000. */
const SELL_ORDER = {
  transaction: "unsigned-sell-tx-b64",
  order: { orderPubkey: "order-2", positionPubkey: "pos-1", marketId: "mkt-1", newPayoutUsd: "18000000", estimatedTotalFeeUsd: "100000" },
};
const CLAIM_POSITION = {
  transaction: "unsigned-claim-tx-b64",
  position: { positionPubkey: "pos-1", payoutAmountUsd: "20000000" },
};

/** Every micro-USD payout figure the fixtures use, as the digit strings a defective writer would leak into `amountRaw`. */
const USD_ESTIMATE_MAGNITUDES = ["18000000", "20000000", "5000000", "7000000"];

interface EventLeg {
  readonly tokenAddress?: string;
  readonly tokenSymbol?: string;
  readonly tokenDecimals?: number;
  readonly amountRaw?: string;
  readonly amountHuman?: string;
}
interface IntentEvent {
  readonly eventRole: string;
  readonly tokenIn?: EventLeg;
  readonly tokenOut?: EventLeg;
  readonly usdOutEst?: string;
}

function intentEvents(): IntentEvent[] {
  return mockCreateAgentActivityIntent.mock.calls[0]![0].events as IntentEvent[];
}

/** The two properties every payout leg must satisfy, asserted identically for all four call sites. */
function expectJupUsdPayoutLeg(event: IntentEvent): void {
  expect(event.tokenOut).toEqual({
    tokenAddress: JUPITER_PREDICTION_PAYOUT_MINT,
    tokenSymbol: JUPITER_PREDICTION_PAYOUT_SYMBOL,
    tokenDecimals: JUPITER_PREDICTION_PAYOUT_DECIMALS,
  });
  expect(event.tokenOut?.tokenAddress).not.toBe(JUPITER_PREDICTION_USDC_MINT);
  expect(event.tokenOut?.amountRaw).toBeUndefined();
  expect(event.tokenOut?.amountHuman).toBeUndefined();
}

describe("prediction payout leg — JupUSD identity, never a USD estimate as a token amount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSigningWallet.mockReturnValue({ family: "solana", address: WALLET_ADDRESS, secretKey: SIGNER.secretKey });
    mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
    mockRequestSell.mockResolvedValue(structuredClone(SELL_ORDER));
    mockRequestClaim.mockResolvedValue(structuredClone(CLAIM_POSITION));
    mockPrepareVersionedTx.mockResolvedValue(PREPARED);
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }, { id: 8 }] });
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
  });

  it("sell: records the JupUSD payout identity with no token amount, keeping the USD figure in usdOutEst", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.sell"]!({ positionPubkey: "pos-1" }, ctx());

    const event = intentEvents()[0]!;
    expect(event.eventRole).toBe("predict_sell");
    expectJupUsdPayoutLeg(event);
    // The estimate is preserved where its name says it is an estimate.
    expect(event.usdOutEst).toBe("18.000000");
    expect(result.success).toBe(false);
  });

  it("claim: records the JupUSD payout identity with no token amount", async () => {
    await PREDICT_HANDLERS["solana.predict.claim"]!({ positionPubkey: "pos-1" }, ctx());

    const event = intentEvents()[0]!;
    expect(event.eventRole).toBe("predict_claim");
    expectJupUsdPayoutLeg(event);
    expect(event.usdOutEst).toBe("20.000000");
  });

  it("closeAll: BOTH fan-out roles (predict_close and predict_claim) record the JupUSD identity with no token amount", async () => {
    mockRequestCloseAll.mockResolvedValue({
      data: [
        { transaction: "close-tx-1", order: { positionPubkey: "pos-1", newPayoutUsd: "5000000", estimatedTotalFeeUsd: "50000" } },
        { transaction: "close-tx-2", position: { positionPubkey: "pos-2", payoutAmountUsd: "7000000" } },
      ],
    });

    await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 100 }, ctx());

    const events = intentEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.eventRole).toBe("predict_close");
    expect(events[1]!.eventRole).toBe("predict_claim");
    for (const event of events) expectJupUsdPayoutLeg(event);
    expect(events[0]!.usdOutEst).toBe("5.000000");
    expect(events[1]!.usdOutEst).toBe("7.000000");
  });

  it("no USD estimate magnitude ever reaches a raw/human token-amount field on ANY payout call site", async () => {
    mockRequestCloseAll.mockResolvedValue({
      data: [
        { transaction: "close-tx-1", order: { positionPubkey: "pos-1", newPayoutUsd: "5000000", estimatedTotalFeeUsd: "50000" } },
        { transaction: "close-tx-2", position: { positionPubkey: "pos-2", payoutAmountUsd: "7000000" } },
      ],
    });

    for (const call of [
      () => PREDICT_HANDLERS["solana.predict.sell"]!({ positionPubkey: "pos-1" }, ctx()),
      () => PREDICT_HANDLERS["solana.predict.claim"]!({ positionPubkey: "pos-1" }, ctx()),
      () => PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 100 }, ctx()),
    ]) {
      vi.clearAllMocks();
      mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }, { id: 8 }] });
      mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
      mockPrepareVersionedTx.mockResolvedValue(PREPARED);
      mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
      mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });

      await call();

      for (const event of intentEvents()) {
        for (const leg of [event.tokenIn, event.tokenOut]) {
          if (!leg) continue;
          expect(USD_ESTIMATE_MAGNITUDES).not.toContain(leg.amountRaw);
          expect(USD_ESTIMATE_MAGNITUDES).not.toContain(leg.amountHuman);
        }
      }
    }
  });

  it("sell: the agent is told the payout asset, that no amount is knowable yet, and how to convert it", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.sell"]!({ positionPubkey: "pos-1" }, ctx());

    expect(result.output).toContain(JUPITER_PREDICTION_PAYOUT_SYMBOL);
    expect(result.output).toContain(JUPITER_PREDICTION_PAYOUT_MINT);
    expect(result.output).toMatch(/later keeper transaction/i);
    expect(result.output).toContain("solana__swap_execute");
    expect((result.data as Record<string, unknown>).settlementAsset).toEqual({
      mint: JUPITER_PREDICTION_PAYOUT_MINT,
      symbol: JUPITER_PREDICTION_PAYOUT_SYMBOL,
      decimals: JUPITER_PREDICTION_PAYOUT_DECIMALS,
    });
  });

  it("claim: carries the same settlement disclosure", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.claim"]!({ positionPubkey: "pos-1" }, ctx());

    expect(result.output).toContain(JUPITER_PREDICTION_PAYOUT_SYMBOL);
    expect((result.data as Record<string, unknown>).settlementAsset).toMatchObject({
      symbol: JUPITER_PREDICTION_PAYOUT_SYMBOL,
    });
  });

  it("closeAll: the aggregate result carries the settlement disclosure too", async () => {
    mockRequestCloseAll.mockResolvedValue({
      data: [{ transaction: "close-tx-1", order: { positionPubkey: "pos-1", newPayoutUsd: "5000000" } }],
    });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 99, events: [{ id: 1 }] });

    const result = await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 100 }, ctx());

    expect(result.output).toContain(JUPITER_PREDICTION_PAYOUT_SYMBOL);
    expect((result.data as Record<string, unknown>).settlementAsset).toMatchObject({
      mint: JUPITER_PREDICTION_PAYOUT_MINT,
    });
  });

  it("buy: the DEPOSIT leg stays USDC — the asymmetry is real, not a copy of the payout fix", async () => {
    mockRequestBuy.mockResolvedValue({
      transaction: "unsigned-buy-tx-b64",
      order: {
        orderPubkey: "order-1", positionPubkey: "pos-1", marketId: "mkt-1",
        orderCostUsd: "10000000", newSizeUsd: "10000000", newPayoutUsd: "18000000",
        estimatedTotalFeeUsd: "100000",
      },
    });

    await PREDICT_HANDLERS["solana.predict.buy"]!(
      { marketId: "mkt-1", side: "yes", amountUsdc: 10 }, ctx(),
    );

    const event = intentEvents()[0]!;
    expect(event.eventRole).toBe("predict_buy");
    expect(event.tokenIn).toMatchObject({
      tokenAddress: JUPITER_PREDICTION_USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6, amountRaw: "10000000",
    });
    expect(event.tokenOut).toBeUndefined();
  });
});
