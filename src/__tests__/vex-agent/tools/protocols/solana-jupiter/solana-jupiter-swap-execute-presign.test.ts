/**
 * `solana.swap.execute` re-reads the wallet against the EXACT transaction, in
 * the window between the last check and the signature.
 *
 * THE DEFECT THIS PINS. Contract C2.6: the quote-time observation is
 * disclosure and the pre-sign read is the check. Before this, Jupiter's
 * execute went from a fresh `/build` straight into `prepareVersionedTx` with
 * no balance read anywhere on the path, so a wallet drained, frozen, or
 * committed elsewhere between quote and execute signed and broadcast a
 * transaction that could only fail on-chain, at the wallet's expense.
 *
 * `prepareVersionedTx` runs FOR REAL here: the refusal has to happen inside
 * the real signing seam, and the assertions prove no signature and no
 * broadcast came out of it. Only the DB, the provider build and the landing
 * lane are faked.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedMessage,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const SIGNER = Keypair.generate();
const WALLET = SIGNER.publicKey.toBase58();
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OUT_MINT = new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
const FEE_ACCOUNT = "FzYtQeGoT2ZkPmMxN1Gi4uJKLKKrDEugKtcxvbwvNQnV";
const BLOCKHASH = "11111111111111111111111111111111";

const PRINCIPAL = 10_000_000;
const TIP = 1_000_000;
const MESSAGE_FEE = 7_321;
const RESERVE_FEE = 5_000;
const RENT = 2_039_280;
/** Tip plus one account rent plus both fees: the whole native cost of the scripted message. */
const NATIVE_DEBIT = TIP + RENT + MESSAGE_FEE + RESERVE_FEE;

interface ChainScript {
  lamports: number;
  splAccounts: Array<{ amount: string; state: string }>;
  undecodableInstruction: boolean;
}
let chain: ChainScript;

const connection = {
  getBalance: async () => chain.lamports,
  getParsedTokenAccountsByOwner: async () => ({
    value: chain.splAccounts.map((account) => ({
      pubkey: Keypair.generate().publicKey,
      account: {
        data: {
          parsed: {
            type: "account",
            info: {
              mint: USDC.toBase58(),
              owner: WALLET,
              state: account.state,
              tokenAmount: { amount: account.amount, decimals: 6 },
            },
          },
        },
      },
    })),
  }),
  getFeeForMessage: async (message: VersionedMessage) => ({
    context: { slot: 1 },
    value: message.compiledInstructions.length === 1 ? RESERVE_FEE : MESSAGE_FEE,
  }),
  getAccountInfo: async () => null,
  getMinimumBalanceForRentExemption: async () => RENT,
};

vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/solana-ecosystem/shared/solana-transaction.js")>();
  // `prepareVersionedTx` stays REAL - it owns the pre-sign window under test.
  return { ...original, getSolanaConnection: () => connection };
});

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "solana", secretKey: SIGNER.secretKey }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: String(err) }),
}));

vi.mock("@tools/wallet/inventory.js", () => ({
  walletAddressesEqual: (_f: string, a: string, b: string) => a === b,
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  requireJupiterResolvedTokenWithSafety: async (query: string) => ({
    token: query === "tokenOut"
      ? { address: OUT_MINT.toBase58(), symbol: "JUP", decimals: 6, chain: "solana", name: "Jupiter" }
      : { address: USDC.toBase58(), symbol: "USDC", decimals: 6, chain: "solana", name: "USD Coin" },
  }),
}));

const feePreview = {
  inAmountRaw: String(PRINCIPAL),
  outAmountRaw: "1026642",
  otherAmountThresholdRaw: "1021508",
  feeBps: 25,
  feeAmountRaw: "25000",
  feeAmountDecimal: "0.025",
  feeMint: USDC.toBase58(),
  feeAccount: FEE_ACCOUNT,
  feeAccountExists: true,
  ataRentLamports: null,
  tipLamports: TIP,
  priorityFeeStrategy: "high",
  priorityFeeLamportsEstimate: 2_321,
  priorityFeeIsUpperBound: true,
  landingMode: "self_managed_submit",
};

const mockFindMatched = vi.fn(async () => ({
  prequoteId: "prequote-1",
  safetyDetail: { feePreview },
}));
vi.mock("@vex-agent/tools/protocols/swap-prequote.js", () => ({
  findFreshMatchedSwapPrequote: () => mockFindMatched(),
}));

const mockCreateIntent = vi.fn(async () => ({ executionId: "exec-1", events: [{ id: "event-1" }] }));
const mockFailEvent = vi.fn(async (_id: string, _input: unknown) => undefined);
const mockMarkBroadcast = vi.fn(async () => ({ applied: true }));
const mockPreBroadcastFailure = vi.fn(async () => ({ executionId: "exec-pre" }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: () => mockCreateIntent(),
  createAgentActivityPreBroadcastFailure: () => mockPreBroadcastFailure(),
  markActivitySolanaBroadcast: () => mockMarkBroadcast(),
  failActivityEvent: (id: string, input: unknown) => mockFailEvent(id, input),
}));

const mockBroadcast = vi.fn(async () => ({ kind: "accepted" as const }));
vi.mock("@vex-agent/tools/protocols/solana-jupiter/staged-broadcast.js", () => ({
  broadcastStagedSolanaTx: () => mockBroadcast(),
}));

function unsignedTx(): VersionedTransaction {
  const outAta = getAssociatedTokenAddressSync(OUT_MINT, SIGNER.publicKey);
  const message = new TransactionMessage({
    payerKey: SIGNER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      createAssociatedTokenAccountIdempotentInstruction(SIGNER.publicKey, outAta, SIGNER.publicKey, OUT_MINT),
      SystemProgram.transfer({ fromPubkey: SIGNER.publicKey, toPubkey: Keypair.generate().publicKey, lamports: TIP }),
      ...(chain.undecodableInstruction
        ? [new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: [{ pubkey: SIGNER.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.from([99, 0, 0, 0]),
        })]
        : []),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

const mockPrepare = vi.fn(async () => ({
  raw: {
    inAmount: String(PRINCIPAL),
    outAmount: "1026642",
    otherAmountThreshold: "1021508",
    priceImpactPct: "0.0012",
    slippageBps: 50,
    swapMode: "ExactIn",
    routePlan: [],
    swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
  },
  unsignedTx: unsignedTx(),
  feeMint: USDC.toBase58(),
  feeAccount: FEE_ACCOUNT,
  feeAccountExists: true,
  ataRentLamports: null,
  knobs: { tipLamports: TIP, computeUnitPricePercentile: "high", wrapAndUnwrapSol: true },
  recentBlockhash: BLOCKHASH,
  lastValidBlockHeight: 100,
  feeAmountRaw: "25000",
  feeAmountDecimal: "0.025",
  priorityFeeLamportsEstimate: 2_321,
  priorityFeeIsUpperBound: true,
  submitTipProof: null,
}));
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js")>();
  return { ...original, prepareFeeBearingJupiterSwap: () => mockPrepare() };
});

const { swapExecuteHandler } = await import(
  "@vex-agent/tools/protocols/solana-jupiter/handlers/core/swap-execute-handler.js"
);

const CTX: ProtocolExecutionContext = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  sessionPermission: "restricted",
  approved: true,
  walletResolution: { source: "session" },
  walletPolicy: { kind: "none" },
};

function execute() {
  return swapExecuteHandler({ tokenIn: "tokenIn", tokenOut: "tokenOut", amountIn: "10" }, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMatched.mockResolvedValue({ prequoteId: "prequote-1", safetyDetail: { feePreview } });
  mockCreateIntent.mockResolvedValue({ executionId: "exec-1", events: [{ id: "event-1" }] });
  mockMarkBroadcast.mockResolvedValue({ applied: true });
  mockBroadcast.mockResolvedValue({ kind: "accepted" as const });
  chain = {
    lamports: NATIVE_DEBIT,
    splAccounts: [{ amount: String(PRINCIPAL), state: "initialized" }],
    undecodableInstruction: false,
  };
});

describe("solana.swap.execute pre-sign authority", () => {
  it("broadcasts when the wallet still covers the exact transaction", async () => {
    const result = await execute();

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(String(result.output)).toContain("broadcast");
    expect(mockFailEvent).not.toHaveBeenCalled();
  });

  it("refuses before signing when the lamports no longer cover the full native cost", async () => {
    // Enough for the tip and the rent, one lamport short of the fees and the
    // measured follow-up reserve.
    chain.lamports = NATIVE_DEBIT - 1;

    const result = await execute();

    expect(result.success).toBe(false);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockMarkBroadcast).not.toHaveBeenCalled();
    expect(String(result.output)).toContain("Refusing to sign");
    expect(String(result.output)).toContain("nothing was broadcast");
    expect(mockFailEvent).toHaveBeenCalledWith(
      "event-1",
      expect.objectContaining({ failureCode: "allowance_or_balance" }),
    );
  });

  it("refuses before signing when the source holding was frozen after the quote", async () => {
    chain.splAccounts = [{ amount: String(PRINCIPAL), state: "frozen" }];

    const result = await execute();

    expect(result.success).toBe(false);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(String(result.output)).toContain("Refusing to sign");
    expect(mockFailEvent).toHaveBeenCalledWith(
      "event-1",
      expect.objectContaining({ failureCode: "allowance_or_balance" }),
    );
  });

  it("fails closed when a lamport the transaction takes cannot be accounted for", async () => {
    chain.undecodableInstruction = true;
    chain.lamports = 10_000_000_000;

    const result = await execute();

    expect(result.success).toBe(false);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(String(result.output)).toContain("could not be verified before signing");
  });

  it("refuses when the balance itself could not be read, never on a zero", async () => {
    chain.splAccounts = [{ amount: String(PRINCIPAL), state: "aStateThisBuildDoesNotKnow" }];

    const result = await execute();

    expect(result.success).toBe(false);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(String(result.output)).toContain("spl_account_state_unreadable");
  });
});
