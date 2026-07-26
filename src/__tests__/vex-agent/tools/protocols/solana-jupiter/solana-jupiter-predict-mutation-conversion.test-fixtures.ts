/**
 * `solana.predict.buy`/`.sell`/`.claim`/`.closeAll` — W5 staged-Solana-seam
 * mutation conversion fixtures. Kept separate so the assertion file stays
 * focused and under the test-file size limit.
 */
import { vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

export const SIGNER = Keypair.generate();
export const WALLET_ADDRESS = SIGNER.publicKey.toBase58();

export const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => ({
  family: "solana" as const, address: WALLET_ADDRESS, secretKey: SIGNER.secretKey,
}));
export const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => WALLET_ADDRESS);

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

export const mockPrepareVersionedTx = vi.fn();
export const mockSubmitOverRpc = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  prepareVersionedTx: (...args: unknown[]) => mockPrepareVersionedTx(...args),
  submitPreparedTxOverRpc: (...args: unknown[]) => mockSubmitOverRpc(...args),
}));

export const mockSubmitPreparedTx = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-prepared-tx.js", () => ({
  submitPreparedTx: (...args: unknown[]) => mockSubmitPreparedTx(...args),
}));

export const mockSubmitPreparedManagedExecute = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/submit-managed-execute.js", () => ({
  submitPreparedManagedExecute: (...args: unknown[]) => mockSubmitPreparedManagedExecute(...args),
}));

vi.mock("@tools/solana-ecosystem/shared/solana-validation.js", () => ({
  solanaExplorerUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}`,
}));

export const mockCreateAgentActivityIntent = vi.fn();
export const mockCreateAgentActivityPreBroadcastFailure = vi.fn();
export const mockMarkActivitySolanaBroadcast = vi.fn();
export const mockFailActivityEvent = vi.fn();
export const mockMarkBroadcastAccepted = vi.fn();
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

export const { PREDICT_HANDLERS } = await import("@vex-agent/tools/protocols/solana-jupiter/handlers/predict.js");

export function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    ...over,
  };
}

export const PREPARED = {
  serialized: new Uint8Array([1, 2, 3]),
  signature: "LocalSig111",
  recentBlockhash: "FreshBlockhash111",
  lastValidBlockHeight: 12345,
};

export const BUY_ORDER = {
  transaction: "unsigned-buy-tx-b64",
  order: {
    orderPubkey: "order-1", positionPubkey: "pos-1", marketId: "mkt-1",
    orderCostUsd: "10000000", newSizeUsd: "10000000", newPayoutUsd: "18000000",
    estimatedTotalFeeUsd: "100000",
  },
};
export const SELL_ORDER = {
  transaction: "unsigned-sell-tx-b64",
  order: { orderPubkey: "order-2", positionPubkey: "pos-1", marketId: "mkt-1", newPayoutUsd: "18000000", estimatedTotalFeeUsd: "100000" },
};
export const CLAIM_POSITION = {
  transaction: "unsigned-claim-tx-b64",
  position: { positionPubkey: "pos-1", payoutAmountUsd: "20000000" },
};

export { mockRequestBuy, mockRequestSell, mockRequestCloseAll, mockRequestClaim };
