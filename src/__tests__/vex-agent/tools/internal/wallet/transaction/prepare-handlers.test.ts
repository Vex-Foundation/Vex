/**
 * The two prepare handlers, end to end through their injected chain seams.
 *
 * No network and no database: the chain seam is an object literal, the session
 * control lock runs its callback directly, and the repo insert is captured. The
 * behaviour being proven is the ORDER of the gates, because that order is what
 * guarantees a refusal never leaves a durable row behind:
 *
 *   forbidden fields -> decode -> simulate -> MANDATORY bounds -> digest -> insert
 *
 * Every refusal case therefore asserts BOTH the refusal and that nothing was
 * written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { encodeFunctionData, parseAbi } from "viem";

const created: Record<string, unknown>[] = [];

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_sessionId: string, run: (client: unknown) => Promise<unknown>) =>
    run({}),
}));

vi.mock("@vex-agent/db/repos/wallet-transaction-intents.js", () => ({
  createWith: async (_client: unknown, input: Record<string, unknown>) => {
    created.push(input);
  },
}));

const SELECTED_EVM = "0x1111111111111111111111111111111111111111";
const solanaWallet = Keypair.generate();
const solanaOther = Keypair.generate();

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (_resolution: unknown, _policy: unknown, family: string) =>
    family === "eip155" ? SELECTED_EVM : solanaWallet.publicKey.toBase58(),
  walletScopeErrorToResult: () => ({ success: false, output: "wallet scope" }),
}));

const { handleWalletEvmTransactionPrepare } = await import(
  "@vex-agent/tools/internal/wallet/transaction/prepare-evm.js"
);
const { handleWalletSolanaTransactionPrepare } = await import(
  "@vex-agent/tools/internal/wallet/transaction/prepare-solana.js"
);

import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type {
  EvmPrepareChain,
  SolanaPrepareChain,
} from "@vex-agent/tools/internal/wallet/transaction/chain-seams.js";

const CONTEXT = { sessionId: "session-1" } as InternalToolContext;

const TOKEN = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

const ERC20 = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);
const TRANSFER_CALLDATA = encodeFunctionData({
  abi: ERC20,
  functionName: "transfer",
  args: [RECIPIENT, 1_000_000n],
});

function evmChain(overrides: Partial<EvmPrepareChain> = {}): EvmPrepareChain {
  return {
    chainId: 8453,
    chainAlias: "base",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    getCode: async () => "0x",
    simulate: async () => ({ ok: true, value: undefined }),
    estimateFees: async () => ({
      suggestedGasLimit: "60000",
      suggestedMaxFeePerGasWei: "1500000000",
      suggestedMaxPriorityFeePerGasWei: "100000000",
      suggestedGasPriceWei: "1400000000",
      supportsEip1559: true,
    }),
    ...overrides,
  };
}

const EVM_BOUNDS = {
  gasLimit: "60000",
  maxFeePerGasWei: "2000000000",
  maxPriorityFeePerGasWei: "1000000000",
};

function evmDeps(chain: EvmPrepareChain = evmChain()) {
  return { chainFactory: async () => chain };
}

function unsignedSolanaProposal(payer = solanaWallet.publicKey): string {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: solanaOther.publicKey, lamports: 7 }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function solanaChain(overrides: Partial<SolanaPrepareChain> = {}): SolanaPrepareChain {
  return {
    getLatestBlockhash: async () => ({
      blockhash: "GfV1yD9tvJoNGrLPbYSHQCPKXPPMFcpUFNWzhEUUqCXt",
      lastValidBlockHeight: 555,
    }),
    // Confirm-time only, and never reached by a prepare: the fake supplies it
    // so the seam stays one interface rather than two.
    getBlockHeight: async () => 1,
    getLookupTableAddresses: async () => null,
    simulateMessage: async () => ({ ok: true, value: undefined }),
    // The exact per-message fee queried via getFeeForMessage. Default sits
    // within SOLANA_BOUNDS (base 5000 + priority 200 = 5200 cap).
    getMessageFee: async () => 5000,
    estimateFees: async () => ({
      suggestedComputeUnitLimit: "200000",
      suggestedComputeUnitPriceMicroLamports: "5000",
    }),
    ...overrides,
  };
}

const SOLANA_BOUNDS = { computeUnitLimit: "200000", computeUnitPriceMicroLamports: "1000" };

function solanaDeps(chain: SolanaPrepareChain = solanaChain()) {
  return { chainFactory: async () => chain };
}

beforeEach(() => {
  created.length = 0;
});

// ── EVM ──────────────────────────────────────────────────────────────

describe("WalletEvmTransactionPrepare", () => {
  it("writes ONE pending intent and echoes the approved bounds", async () => {
    const result = await handleWalletEvmTransactionPrepare(
      { chain: "base", to: TOKEN, data: TRANSFER_CALLDATA, ...EVM_BOUNDS },
      CONTEXT,
      evmDeps(),
    );
    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);

    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("prepared");
    expect(data.approvedFeeBounds).toMatchObject({
      mode: "eip1559",
      // 60000 * 2 gwei, in integer arithmetic.
      maxTotalFeeWei: "120000000000000",
    });
    // The intent the caller is told about is the intent that was written.
    expect(created[0]?.intentId).toBe(data.intentId);
    expect(created[0]?.proposalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(created[0]?.walletAddress).toBe(SELECTED_EVM);
  });

  it("the preview shows the fee ceiling next to the decoded effect", async () => {
    const result = await handleWalletEvmTransactionPrepare(
      { chain: "base", to: TOKEN, data: TRANSFER_CALLDATA, ...EVM_BOUNDS },
      CONTEXT,
      evmDeps(),
    );
    const preview = (result.data as { preview: { criticalArgs: Record<string, string> } }).preview;
    expect(preview.criticalArgs.maxTotalNetworkFeeWei).toBe("120000000000000");
    expect(preview.criticalArgs.amountRaw).toBe("1000000");
    expect(preview.criticalArgs.chain).toBe("base");
  });

  it("refuses `from` BY NAME before anything else, and writes nothing", async () => {
    const result = await handleWalletEvmTransactionPrepare(
      { chain: "base", to: TOKEN, data: TRANSFER_CALLDATA, from: RECIPIENT, ...EVM_BOUNDS },
      CONTEXT,
      evmDeps(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("`from`");
    expect((result.data as { refusalCode: string }).refusalCode).toBe("forbidden_field");
    expect(created).toEqual([]);
  });

  it("refuses a MISSING fee cap with labelled estimates, and writes nothing", async () => {
    const result = await handleWalletEvmTransactionPrepare(
      { chain: "base", to: TOKEN, data: TRANSFER_CALLDATA },
      CONTEXT,
      evmDeps(),
    );
    expect(result.success).toBe(false);
    const data = result.data as { refusalCode: string; refusalDetails: Record<string, string> };
    expect(data.refusalCode).toBe("missing_fee_bounds");
    expect(data.refusalDetails.hintSuggestedMaxFeePerGasWei).toBe("1500000000");
    expect(created).toEqual([]);
  });

  it("refuses an undecodable proposal BEFORE it simulates", async () => {
    const simulate = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const result = await handleWalletEvmTransactionPrepare(
      { chain: "base", to: TOKEN, data: `0xdeadbeef${"00".repeat(32)}`, ...EVM_BOUNDS },
      CONTEXT,
      evmDeps(evmChain({ simulate })),
    );
    expect(result.success).toBe(false);
    expect((result.data as { refusalCode: string }).refusalCode).toBe("unsupported_call");
    // Nothing that cannot be described is worth a round trip, and a simulation
    // that succeeded would be evidence for a sentence nobody could write.
    expect(simulate).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("refuses `data = 0x` to an address WITH code, and writes nothing", async () => {
    const result = await handleWalletEvmTransactionPrepare(
      { chain: "base", to: TOKEN, data: "0x", valueWei: "1", ...EVM_BOUNDS },
      CONTEXT,
      evmDeps(evmChain({ getCode: async () => "0x6080" })),
    );
    expect(result.success).toBe(false);
    expect((result.data as { refusalCode: string }).refusalCode).toBe(
      "code_at_native_transfer_target",
    );
    expect(created).toEqual([]);
  });

  it("refuses when simulation fails, carrying the DECODED revert reason", async () => {
    const result = await handleWalletEvmTransactionPrepare(
      { chain: "base", to: TOKEN, data: TRANSFER_CALLDATA, ...EVM_BOUNDS },
      CONTEXT,
      evmDeps(
        evmChain({
          simulate: async () => ({
            ok: false,
            refusal: {
              code: "simulation_failed",
              message: "Refusing to prepare: the contract reverted with: ERC20: insufficient balance.",
              details: { revertReason: "ERC20: insufficient balance" },
            },
          }),
        }),
      ),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("ERC20: insufficient balance");
    expect(created).toEqual([]);
  });

  it("refuses a human decimal in `valueWei`", async () => {
    const result = await handleWalletEvmTransactionPrepare(
      { chain: "base", to: RECIPIENT, data: "0x", valueWei: "0.1", ...EVM_BOUNDS },
      CONTEXT,
      evmDeps(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("RAW decimal integer string of wei");
    expect(created).toEqual([]);
  });
});

// ── Solana ───────────────────────────────────────────────────────────

describe("WalletSolanaTransactionPrepare", () => {
  it("installs a FRESH blockhash and stores the height evidence with it", async () => {
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal(), ...SOLANA_BOUNDS },
      CONTEXT,
      solanaDeps(),
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.recentBlockhash).toBe("GfV1yD9tvJoNGrLPbYSHQCPKXPPMFcpUFNWzhEUUqCXt");
    expect(data.lastValidBlockHeight).toBe(555);
    expect(created[0]?.recentBlockhash).toBe(data.recentBlockhash);
    expect(created[0]?.lastValidBlockHeight).toBe(555);
  });

  it("simulates the CANONICAL bytes, not the caller's", async () => {
    const seen: string[] = [];
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal(), ...SOLANA_BOUNDS },
      CONTEXT,
      solanaDeps(
        solanaChain({
          simulateMessage: async (bytes) => {
            seen.push(bytes);
            return { ok: true, value: undefined };
          },
        }),
      ),
    );
    const data = result.data as { canonicalMessageBase64: string };
    expect(seen).toEqual([data.canonicalMessageBase64]);
  });

  it("displays a 60 second expiry and says the height is the real bound", async () => {
    const before = Date.now();
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal(), ...SOLANA_BOUNDS },
      CONTEXT,
      solanaDeps(),
    );
    const data = result.data as { expiresAt: string; expiryNote: string };
    // Measured from a clock read taken BEFORE the call, so the window is the
    // 60 s cap plus however long the handler took.
    const ttl = new Date(data.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(60_000);
    expect(ttl).toBeLessThan(65_000);
    expect(data.expiryNote).toContain("lastValidBlockHeight");
  });

  it("computes the priority fee from the requested CU limit and price", async () => {
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal(), ...SOLANA_BOUNDS },
      CONTEXT,
      solanaDeps(),
    );
    // 200000 CU * 1000 micro-lamports / 1e6 = 200 lamports, plus 5000 base.
    expect((result.data as { approvedFeeBounds: Record<string, string> }).approvedFeeBounds)
      .toMatchObject({
        mode: "solana",
        maxPriorityFeeLamports: "200",
        baseFeeLamports: "5000",
        maxTotalFeeLamports: "5200",
      });
  });

  it("refuses to prepare when the queried message fee EXCEEDS the caps (V5)", async () => {
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal(), ...SOLANA_BOUNDS },
      CONTEXT,
      // 200000 CU * 1000 / 1e6 + 5000 base = 5200 cap; quote 6000 is over.
      solanaDeps(solanaChain({ getMessageFee: async () => 6000 })),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("6000");
    expect(result.output).toContain("5200");
    expect(created).toEqual([]);
  });

  it("refuses to prepare when the network cannot quote the message fee (V5)", async () => {
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal(), ...SOLANA_BOUNDS },
      CONTEXT,
      solanaDeps(solanaChain({ getMessageFee: async () => null })),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("could not be queried");
    expect(created).toEqual([]);
  });

  it("queries getFeeForMessage against the CANONICAL bytes it stores (V5)", async () => {
    const seen: string[] = [];
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal(), ...SOLANA_BOUNDS },
      CONTEXT,
      solanaDeps(
        solanaChain({
          getMessageFee: async (bytes) => {
            seen.push(bytes);
            return 5000;
          },
        }),
      ),
    );
    expect(result.success).toBe(true);
    const data = result.data as { canonicalMessageBase64: string };
    expect(seen).toEqual([data.canonicalMessageBase64]);
  });

  it("refuses `feePayer` BY NAME and writes nothing", async () => {
    const result = await handleWalletSolanaTransactionPrepare(
      {
        transactionBase64: unsignedSolanaProposal(),
        feePayer: solanaOther.publicKey.toBase58(),
        ...SOLANA_BOUNDS,
      },
      CONTEXT,
      solanaDeps(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("`feePayer`");
    expect(created).toEqual([]);
  });

  it("refuses a proposal whose fee payer is not the selected wallet", async () => {
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal(solanaOther.publicKey), ...SOLANA_BOUNDS },
      CONTEXT,
      solanaDeps(),
    );
    expect(result.success).toBe(false);
    expect((result.data as { refusalCode: string }).refusalCode).toBe("forbidden_field");
    expect(created).toEqual([]);
  });

  it("refuses MISSING compute-unit caps with labelled estimates", async () => {
    const result = await handleWalletSolanaTransactionPrepare(
      { transactionBase64: unsignedSolanaProposal() },
      CONTEXT,
      solanaDeps(),
    );
    expect(result.success).toBe(false);
    const data = result.data as { refusalCode: string; refusalDetails: Record<string, string> };
    expect(data.refusalCode).toBe("missing_fee_bounds");
    expect(data.refusalDetails.hintSuggestedComputeUnitPriceMicroLamports).toBe("5000");
    expect(created).toEqual([]);
  });
});

// ── The registered stubs ─────────────────────────────────────────────
