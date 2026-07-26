/**
 * PER-ROW `prediction_order` provenance on every Jupiter Prediction payout row
 * (P1 fill-settlement lane, provenance half).
 *
 * THE DEFECT THIS CLOSES. `solana.predict.closeAll` fans out into N
 * `agent_activity` rows inside ONE execution, and all N shared the SAME
 * top-level `intentParams` echo — the per-item `positionPubkey` reached only
 * the tool RESULT, never a queryable column. A settlement sweep reading such a
 * row therefore could not tell WHICH position it closed, and with two open
 * positions it could have matched one row against a sibling's money. Each row
 * now persists its own position in `route_provenance.prediction_order` at
 * intent time, before anything is signed.
 *
 * Deliberately uses the REAL `buildPredictionOrderProvenance` (only the DB
 * write itself is mocked), so this test fails if the persisted shape and the
 * sweep-side reader ever drift apart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SIGNER = Keypair.generate();
const WALLET_ADDRESS = SIGNER.publicKey.toBase58();

const POSITION_A = "JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd";
const POSITION_B = "H84ZBkrgt876mStVprz1tmjEbXPL7BS8Dmhd1EKvtR2H";

const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => ({
  family: "solana" as const,
  address: WALLET_ADDRESS,
  secretKey: SIGNER.secretKey,
}));
const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => WALLET_ADDRESS);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: Parameters<WalletResolveModule["resolveSigningWallet"]>) =>
    mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) =>
    mockResolveSelectedAddress(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

const mockRequestSell = vi.fn();
const mockRequestClaim = vi.fn();
const mockRequestCloseAll = vi.fn();

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  getJupiterPredictionEvents: vi.fn(),
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionMarket: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
  getJupiterPredictionPosition: vi.fn(),
  getJupiterPredictionPositions: vi.fn(),
  getJupiterPredictionHistory: vi.fn(),
  requestJupiterPredictionCreateOrderTransaction: vi.fn(),
  requestJupiterPredictionClosePositionTransaction: (...args: unknown[]) => mockRequestSell(...args),
  requestJupiterPredictionCloseAllPositionsTransactions: (...args: unknown[]) => mockRequestCloseAll(...args),
  requestJupiterPredictionClaimPositionTransaction: (...args: unknown[]) => mockRequestClaim(...args),
  requireTransaction: (tx: string | null | undefined, feature: string): string => {
    if (!tx) throw new Error(`${feature} did not return an executable transaction.`);
    return tx;
  },
  resolveManagedExecution: () => null,
}));

const mockPrepareVersionedTx = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  prepareVersionedTx: (...args: unknown[]) => mockPrepareVersionedTx(...args),
  submitPreparedTxOverRpc: vi.fn().mockResolvedValue({ kind: "accepted", signature: "LocalSig111" }),
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

// Only the WRITE is mocked — `buildPredictionOrderProvenance` stays real, so
// the persisted shape is the one the sweep-side reader actually parses.
vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/db/repos/agent-activity.js")>();
  return {
    ...actual,
    createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
    createAgentActivityPreBroadcastFailure: vi.fn().mockResolvedValue({ executionId: 43, event: { id: 8 } }),
    markActivitySolanaBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
    markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
    failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  };
});

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { PREDICT_HANDLERS } = await import("@vex-agent/tools/protocols/solana-jupiter/handlers/predict.js");
const { readPredictionOrderPositionPubkey } = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-order-provenance.js"
);

const PREPARED = {
  serialized: new Uint8Array([1, 2, 3]),
  signature: "LocalSig111",
  recentBlockhash: "FreshBlockhash111",
  lastValidBlockHeight: 12345,
};

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

interface IntentEvent {
  readonly eventRole: string;
  readonly routeProvenance?: Record<string, unknown>;
}

function intentEvents(): readonly IntentEvent[] {
  const call = mockCreateAgentActivityIntent.mock.calls[0];
  if (!call) throw new Error("expected createAgentActivityIntent to have been called");
  return (call[0] as { events: readonly IntentEvent[] }).events;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSigningWallet.mockReturnValue({
    family: "solana",
    address: WALLET_ADDRESS,
    secretKey: SIGNER.secretKey,
  });
  mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
  mockPrepareVersionedTx.mockResolvedValue(PREPARED);
  mockCreateAgentActivityIntent.mockImplementation((input: { events: readonly unknown[] }) =>
    Promise.resolve({
      executionId: 42,
      events: input.events.map((_event, index) => ({ id: 100 + index })),
    }),
  );
  mockRequestSell.mockResolvedValue({
    transaction: "unsigned-sell-tx-b64",
    order: { positionPubkey: POSITION_A, newPayoutUsd: "18000000", estimatedTotalFeeUsd: "100000" },
  });
  mockRequestClaim.mockResolvedValue({
    transaction: "unsigned-claim-tx-b64",
    position: { positionPubkey: POSITION_A, payoutAmountUsd: "20000000" },
  });
});

describe("solana.predict.sell — per-row prediction_order provenance", () => {
  it("persists the position it is closing on the intent row, before anything is signed", async () => {
    await PREDICT_HANDLERS["solana.predict.sell"]!({ positionPubkey: POSITION_A }, ctx());

    const events = intentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventRole).toBe("predict_sell");
    expect(readPredictionOrderPositionPubkey(events[0]!.routeProvenance ?? null)).toBe(POSITION_A);
  });

  it("records the provenance BEFORE the first signature (the row is queryable even if signing fails)", async () => {
    const order: string[] = [];
    mockCreateAgentActivityIntent.mockImplementation((input: { events: readonly unknown[] }) => {
      order.push("intent");
      return Promise.resolve({ executionId: 42, events: input.events.map(() => ({ id: 100 })) });
    });
    mockPrepareVersionedTx.mockImplementation(() => {
      order.push("sign");
      return Promise.resolve(PREPARED);
    });

    await PREDICT_HANDLERS["solana.predict.sell"]!({ positionPubkey: POSITION_A }, ctx());

    expect(order).toEqual(["intent", "sign"]);
  });
});

describe("solana.predict.claim — per-row prediction_order provenance", () => {
  it("persists its own position too (a claim is a payout row like any other)", async () => {
    await PREDICT_HANDLERS["solana.predict.claim"]!({ positionPubkey: POSITION_A }, ctx());

    const events = intentEvents();
    expect(events[0]!.eventRole).toBe("predict_claim");
    expect(readPredictionOrderPositionPubkey(events[0]!.routeProvenance ?? null)).toBe(POSITION_A);
  });
});

describe("solana.predict.closeAll — TWO distinct positions", () => {
  beforeEach(() => {
    mockRequestCloseAll.mockResolvedValue({
      data: [
        {
          transaction: "unsigned-close-a-b64",
          order: { positionPubkey: POSITION_A, newPayoutUsd: "18000000", estimatedTotalFeeUsd: "100000" },
        },
        {
          transaction: "unsigned-claim-b-b64",
          position: { positionPubkey: POSITION_B, payoutAmountUsd: "20000000" },
        },
      ],
    });
  });

  it("gives EACH fan-out row its OWN position — never the sibling's", async () => {
    await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 250 }, ctx());

    const events = intentEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventRole)).toEqual(["predict_close", "predict_claim"]);
    expect(events.map((e) => readPredictionOrderPositionPubkey(e.routeProvenance ?? null))).toEqual([
      POSITION_A,
      POSITION_B,
    ]);
  });

  it("writes a DISTINCT provenance object per row (no shared reference, no shared position)", async () => {
    await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 250 }, ctx());

    const events = intentEvents();
    const [first, second] = events;
    expect(first!.routeProvenance).not.toBe(second!.routeProvenance);
    expect(first!.routeProvenance).not.toEqual(second!.routeProvenance);
  });

  it("still records one row per item inside ONE execution", async () => {
    const result = await PREDICT_HANDLERS["solana.predict.closeAll"]!({ minSellPriceSlippageBps: 250 }, ctx());

    expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
    expect((result.data as { count: number }).count).toBe(2);
  });
});
