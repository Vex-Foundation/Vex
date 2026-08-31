/**
 * `solana.swap.quote` joins the quote-authority channel.
 *
 * THE DEFECT THIS PINS. Jupiter had no balance guard of any kind, and the
 * prequote recorder wrote every Jupiter row as unconditionally `executable`
 * (`prequote/record/swap.ts`), so a successful quote read as a confirmation
 * that the wallet could pay. It could not: SPL atoms can be present and
 * FROZEN (contract C2.7), and a Solana swap's native cost is not its principal
 * but the principal plus the message fee, the tip, every account rent the
 * wallet funds and a measured follow-up reserve.
 *
 * The handler runs FOR REAL here, over a scripted RPC and a scripted `/build`
 * result. Only the two external boundaries are faked; the verdict, the
 * attribution, the shared evaluator and the recorder handoff are the code
 * under test.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type VersionedMessage,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { SOLANA_NATIVE_PERSISTED_ADDRESS } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const WALLET = Keypair.generate().publicKey;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OUT_MINT = new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
const BLOCKHASH = "11111111111111111111111111111111";

const PRINCIPAL = 10_000_000;
const TIP = 1_000_000;
const MESSAGE_FEE = 7_321;
const RESERVE_FEE = 5_000;
const RENT = 2_039_280;

// ── Scripted boundaries ───────────────────────────────────────────────────

interface ChainScript {
  lamports: number;
  splAccounts: Array<{ amount: string; state: string; mint?: string; decimals?: number }>;
  existingAccounts: string[];
}
let chain: ChainScript;

function parsedAccounts() {
  return chain.splAccounts.map((account) => ({
    pubkey: Keypair.generate().publicKey,
    account: {
      data: {
        parsed: {
          type: "account",
          info: {
            mint: account.mint ?? USDC.toBase58(),
            owner: WALLET.toBase58(),
            state: account.state,
            tokenAmount: { amount: account.amount, decimals: account.decimals ?? 6 },
          },
        },
      },
    },
  }));
}

/** Scripted RPC: a real `Connection` satisfies the same structural seam. */
const connection = {
  getBalance: async () => chain.lamports,
  getParsedTokenAccountsByOwner: async () => ({ value: parsedAccounts() }),
  getFeeForMessage: async (message: VersionedMessage) => ({
    context: { slot: 1 },
    // The reserve message is the one-instruction, one-signature self transfer.
    value: isReserveMessage(message) ? RESERVE_FEE : MESSAGE_FEE,
  }),
  getAccountInfo: async (key: PublicKey) =>
    chain.existingAccounts.includes(key.toBase58())
      ? { data: new Uint8Array(), owner: SystemProgram.programId }
      : null,
  getMinimumBalanceForRentExemption: async () => RENT,
};

function isReserveMessage(message: VersionedMessage): boolean {
  return message.compiledInstructions.length === 1;
}

vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  getSolanaConnection: () => connection,
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET.toBase58(),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: String(err) }),
}));

vi.mock("@tools/wallet/inventory.js", () => ({
  walletAddressesEqual: (_f: string, a: string, b: string) => a === b,
}));

let inputTokenMint = USDC.toBase58();
let inputDecimals = 6;
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  requireJupiterResolvedTokenWithSafety: async (query: string) => ({
    token:
      query === "tokenOut"
        ? { address: OUT_MINT.toBase58(), symbol: "JUP", decimals: 6, chain: "solana", name: "Jupiter" }
        : { address: inputTokenMint, symbol: inputTokenMint === SOL_MINT ? "SOL" : "USDC", decimals: inputDecimals, chain: "solana", name: "in" },
  }),
}));

/** The assembled message, shaped like the live `/build` response of 2026-08-31. */
function unsignedTx(nativeInput: boolean): VersionedTransaction {
  const wsolAta = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), WALLET);
  const outAta = getAssociatedTokenAddressSync(OUT_MINT, WALLET);
  const message = new TransactionMessage({
    payerKey: WALLET,
    recentBlockhash: BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...(nativeInput
        ? [
          createAssociatedTokenAccountIdempotentInstruction(WALLET, wsolAta, WALLET, new PublicKey(SOL_MINT)),
          SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: wsolAta, lamports: PRINCIPAL }),
        ]
        : []),
      createAssociatedTokenAccountIdempotentInstruction(WALLET, outAta, WALLET, OUT_MINT),
      SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: Keypair.generate().publicKey, lamports: TIP }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

let nativeInput = false;
const mockPrepare = vi.fn(async () => ({
  raw: {
    inAmount: String(PRINCIPAL),
    outAmount: "1026642",
    otherAmountThreshold: "1021508",
    priceImpactPct: "0.0012",
    slippageBps: 50,
    routePlan: [],
  },
  unsignedTx: unsignedTx(nativeInput),
  feeMint: inputTokenMint,
  feeAccount: "FzYtQeGoT2ZkPmMxN1Gi4uJKLKKrDEugKtcxvbwvNQnV",
  feeAccountExists: true,
  ataRentLamports: null,
  knobs: { tipLamports: TIP, computeUnitPricePercentile: "high", wrapAndUnwrapSol: true },
  recentBlockhash: BLOCKHASH,
  lastValidBlockHeight: 100,
  // 25 bps of the principal, taken OUT of it by the swap.
  feeAmountRaw: String((PRINCIPAL * 25) / 10_000),
  feeAmountDecimal: "0.000025",
  priorityFeeLamportsEstimate: 2_321,
  priorityFeeIsUpperBound: true,
  submitTipProof: null,
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js")>();
  return { ...original, prepareFeeBearingJupiterSwap: (...args: unknown[]) => mockPrepare(...(args as [])) };
});

const { swapQuoteHandler } = await import(
  "@vex-agent/tools/protocols/solana-jupiter/handlers/core/swap-quote-handler.js"
);

const CTX: ProtocolExecutionContext = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  sessionPermission: "restricted",
  approved: true,
  walletResolution: { source: "session" },
  walletPolicy: { kind: "none" },
};

async function quote(params: Record<string, unknown> = {}) {
  const result = await swapQuoteHandler(
    { tokenIn: "tokenIn", tokenOut: "tokenOut", amountIn: "10", ...params },
    CTX,
  );
  return { result, data: result.data as Record<string, unknown> | undefined };
}

/** Everything the wallet must hold in lamports for the scripted message. */
function fullNativeDebit(nativeSide: boolean): number {
  const rents = (nativeSide ? 2 : 1) * RENT;
  return (nativeSide ? PRINCIPAL : 0) + TIP + rents + MESSAGE_FEE + RESERVE_FEE;
}

beforeEach(() => {
  mockPrepare.mockClear();
  inputTokenMint = USDC.toBase58();
  inputDecimals = 6;
  nativeInput = false;
  chain = {
    lamports: 500_000_000,
    splAccounts: [{ amount: String(PRINCIPAL), state: "initialized" }],
    existingAccounts: [],
  };
});

describe("solana.swap.quote eligibility", () => {
  it("returns an executable verdict and hands the recorder the spendability facts", async () => {
    const { result, data } = await quote();

    expect(result.success).toBe(true);
    expect(data?.eligibility).toEqual({ kind: "executable", executable: true });
    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    // Jupiter records no claimable route snapshot; the common gate is what
    // gives its rows teeth.
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();

    const preview = result.quoteAuthority?.spendability;
    expect(preview?.source.asset.address).toBe(USDC.toBase58());
    expect(preview?.source.required.raw).toBe(String(PRINCIPAL));
    expect(preview?.native.asset.address).toBe(SOLANA_NATIVE_PERSISTED_ADDRESS);
    expect(preview?.native.required.raw).toBe(String(fullNativeDebit(false)));
    expect(preview?.native.blockTag).toBe("pending");
  });

  it("counts the principal once and never adds the 25 bps fee on top of it", async () => {
    const { result } = await quote();
    // `inAmount` already contains Vex's fee - the swap takes it out of the
    // input side, so the source leg needs exactly `inAmount` and no more.
    expect(result.quoteAuthority?.spendability?.source.required.raw).toBe(String(PRINCIPAL));
  });

  it("does not add the decoded priority-fee estimate to the node's own message fee", async () => {
    const { data } = await quote();
    const debit = data?.nativeDebit as Record<string, string>;

    expect(debit.messageFeeLamports).toBe(String(MESSAGE_FEE));
    expect(BigInt(debit.totalLamports)).toBe(
      BigInt(debit.walletPaidLamports) + BigInt(MESSAGE_FEE) + BigInt(RESERVE_FEE),
    );
    // The disclosure figure is beside it, never inside it.
    const feePreview = data?.feePreview as Record<string, number>;
    expect(feePreview.priorityFeeLamportsEstimate).toBe(2_321);
    expect(BigInt(debit.totalLamports)).not.toBe(
      BigInt(debit.walletPaidLamports) + BigInt(MESSAGE_FEE) + BigInt(RESERVE_FEE) + 2_321n,
    );
  });

  it("refuses to call a frozen holding spendable, and still returns the route", async () => {
    chain.splAccounts = [
      { amount: "1", state: "initialized" },
      { amount: String(PRINCIPAL), state: "frozen" },
    ];

    const { result, data } = await quote();

    expect(result.quoteAuthority?.eligibilityKind).toBe("insufficient_balance");
    expect(result.quoteAuthority?.spendability).toBeUndefined();
    expect(data?.eligibility).toEqual({ kind: "insufficient_balance", executable: false });
    // Contract C2.1: the route survives the refusal, and so do the fee facts.
    expect(data?.routePlan).toEqual([]);
    expect(data?.feePreview).toBeDefined();
    expect(data?.sourceSpendability).toEqual({
      spendableAmountRaw: "1",
      frozenAmountRaw: String(PRINCIPAL),
      tokenAccounts: 2,
    });
    expect(String(data?.summary)).toContain("NOT EXECUTABLE");
    expect(String(data?.summary)).toContain("Frozen token accounts are not spendable");
  });

  it("fails closed on an account state it cannot read, never as a zero balance", async () => {
    chain.splAccounts = [{ amount: String(PRINCIPAL), state: "someFutureState" }];

    const { result, data } = await quote();

    expect(result.quoteAuthority?.eligibilityKind).toBe("balance_unavailable");
    expect(data?.eligibility).toEqual({ kind: "balance_unavailable", executable: false });
    expect(String(data?.summary)).toContain("spl_account_state_unreadable");
  });

  it("separates a gas shortfall from an input shortfall", async () => {
    chain.lamports = TIP + RENT + MESSAGE_FEE; // covers some of the debit, not the reserve

    const { result } = await quote();

    expect(result.quoteAuthority?.eligibilityKind).toBe("gas_reserve_insufficient");
  });

  it("charges the wallet for every account IT funds, not only the treasury fee account", async () => {
    // With the output account already on-chain the debit drops by exactly one
    // rent: the guard is reading the message, not the quote's own single
    // `ataRentLamports` field.
    const outAta = getAssociatedTokenAddressSync(OUT_MINT, WALLET).toBase58();
    const before = (await quote()).data?.nativeDebit as Record<string, string>;
    chain.existingAccounts = [outAta];
    const after = (await quote()).data?.nativeDebit as Record<string, string>;

    expect(BigInt(before.totalLamports) - BigInt(after.totalLamports)).toBe(BigInt(RENT));
  });
});

describe("SOL versus wrapped SOL input syntax", () => {
  it("reads the wallet's own lamports for the SOL symbol", async () => {
    inputTokenMint = SOL_MINT;
    inputDecimals = 9;
    nativeInput = true;
    chain.splAccounts = [];
    chain.lamports = fullNativeDebit(true);

    const { result } = await quote({ tokenIn: "SOL" });

    const preview = result.quoteAuthority?.spendability;
    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(preview?.source.asset.address).toBe(SOLANA_NATIVE_PERSISTED_ADDRESS);
    // One read serves both legs: the source asks for the principal, the native
    // leg asks for the whole debit, which already contains it.
    expect(preview?.source.required.raw).toBe(String(PRINCIPAL));
    expect(preview?.native.required.raw).toBe(String(fullNativeDebit(true)));
  });

  it("reads the wrapped-SOL token account for the explicit mint with wrapping off", async () => {
    inputTokenMint = SOL_MINT;
    inputDecimals = 9;
    chain.splAccounts = [{ amount: String(PRINCIPAL), state: "initialized", mint: SOL_MINT, decimals: 9 }];

    const { result } = await quote({ tokenIn: SOL_MINT, wrapAndUnwrapSol: false });

    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(result.quoteAuthority?.spendability?.source.asset.address).toBe(SOL_MINT);
  });

  it("refuses the explicit mint with wrapping on, BY NAME", async () => {
    inputTokenMint = SOL_MINT;
    inputDecimals = 9;

    const { result } = await quote({ tokenIn: SOL_MINT });

    expect(result.success).toBe(false);
    expect(result.output).toContain("ambiguous");
    expect(result.output).toContain("wrapAndUnwrapSol");
    // Refused before any provider call: nothing was built.
    expect(mockPrepare).not.toHaveBeenCalled();
  });
});
