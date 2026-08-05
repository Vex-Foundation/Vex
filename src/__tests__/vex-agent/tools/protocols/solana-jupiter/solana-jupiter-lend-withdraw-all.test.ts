/**
 * `solana.lend.withdraw` — dust-free full exit (`withdrawAll`) through the
 * SHARES-denominated `/earn/redeem` primitive (P3).
 *
 * WHY THIS EXISTS. An amount-denominated "full" withdrawal cannot reach zero:
 * Earn interest accrues between the balance read and the signed execution, so
 * a live funded exit left 5 shares (0.000005 USDC) behind. `/earn/redeem`
 * takes SHARES, so redeeming the position's exact current share balance is the
 * only primitive that closes a position completely.
 *
 * Pinned contracts:
 *   1. STRICT XOR params — exactly one of {amount} / {withdrawAll: true}.
 *      Every other combination is refused BY NAME before any provider call;
 *      `withdrawAll: false` is refused rather than silently dropped (a dropped
 *      money param hides the caller's confusion instead of surfacing it).
 *   2. Position resolution — matched on wallet AND underlying asset. No match,
 *      several matches, or an empty position is a NAMED refusal that says what
 *      to change; the handler never guesses which position to close.
 *   3. The redeem request carries the position's exact `shares` string, while
 *      the `agent_activity` out-leg carries `underlyingAssets` as the REQUESTED
 *      amount (executed truth comes from the settlement decoder, not from here).
 *
 * Deliberately a new sibling file: `solana-jupiter-lend-mutation-conversion.
 * test.ts` owns the amount-path write protocol and is under concurrent edit.
 * The mocking recipe is copied from it — earn-api service, the K2 staged seam
 * and the `agent_activity` repo façade are mocked, while the REAL
 * `atomicToExactDecimalString` stays so the leg's `amountHuman` is produced by
 * production's own BigInt formatter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SIGNER = Keypair.generate();
const WALLET_ADDRESS = SIGNER.publicKey.toBase58();
const OTHER_WALLET_ADDRESS = Keypair.generate().publicKey.toBase58();

/** Real USDC mint — the UNDERLYING asset (`token.assetAddress`), what the agent passes as `asset`. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** The Earn/vault share token (`token.address`) — a DIFFERENT address, never the match key. */
const JLUSDC_MINT = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

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

const mockGetPositions = vi.fn();
const mockRequestWithdraw = vi.fn();
const mockRequestRedeem = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/service.js", () => ({
  getJupiterLendEarnTokens: vi.fn(),
  getJupiterLendEarnPositions: (...args: unknown[]) => mockGetPositions(...args),
  getJupiterLendEarnEarnings: vi.fn(),
  requestJupiterLendEarnDepositTransaction: vi.fn(),
  requestJupiterLendEarnWithdrawTransaction: (...args: unknown[]) => mockRequestWithdraw(...args),
  requestJupiterLendEarnRedeemTransaction: (...args: unknown[]) => mockRequestRedeem(...args),
}));

const mockPrepareVersionedTx = vi.fn();
const mockSubmitOverRpc = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  prepareVersionedTx: (...args: unknown[]) => mockPrepareVersionedTx(...args),
  submitPreparedTxOverRpc: (...args: unknown[]) => mockSubmitOverRpc(...args),
}));

vi.mock("@tools/solana-ecosystem/shared/solana-validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/solana-ecosystem/shared/solana-validation.js")>();
  return { ...actual, solanaExplorerUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}` };
});

const mockResolveJupiterToken = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  resolveJupiterToken: (...args: unknown[]) => mockResolveJupiterToken(...args),
}));

const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn();
const mockMarkActivitySolanaBroadcast = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockMarkBroadcastAccepted = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivitySolanaBroadcast: (...args: unknown[]) => mockMarkActivitySolanaBroadcast(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  markBroadcastAccepted: (...args: unknown[]) => mockMarkBroadcastAccepted(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { LEND_HANDLERS } = await import("@vex-agent/tools/protocols/solana-jupiter/handlers/lend.js");

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

/** Invoke the REAL registered handler (no non-null assertion — a missing registration must fail loudly). */
function withdraw(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext = ctx(),
): Promise<ToolResult> {
  const handler = LEND_HANDLERS["solana.lend.withdraw"];
  if (handler === undefined) throw new Error("solana.lend.withdraw is not registered in LEND_HANDLERS");
  return handler(params, context);
}

const PREPARED = {
  serialized: new Uint8Array([1, 2, 3]),
  signature: "LocalSig111",
  recentBlockhash: "FreshBlockhash111",
  lastValidBlockHeight: 12345,
};

const USDC_METADATA = {
  chain: "solana", address: USDC_MINT, symbol: "USDC", name: "USD Coin", decimals: 6,
};

/**
 * Shape of a real `GET /earn/positions` row, trimmed to the fields any consumer
 * reads. `shares` and `underlyingAssets` DIFFER, as they do live once the vault
 * has accrued: the redeem request must carry the former, the activity leg the
 * latter.
 */
function earnPosition(over: {
  assetAddress?: string;
  ownerAddress?: string;
  shares?: string;
  underlyingAssets?: string;
} = {}) {
  return {
    token: {
      address: JLUSDC_MINT,
      assetAddress: over.assetAddress ?? USDC_MINT,
      symbol: "jlUSDC",
      decimals: 6,
    },
    ownerAddress: over.ownerAddress ?? WALLET_ADDRESS,
    shares: over.shares ?? "1046532",
    underlyingAssets: over.underlyingAssets ?? "1047061",
    underlyingBalance: "1047061",
    allowance: "0",
  };
}

/** Nothing reached the provider, the ledger, or the signer. */
function expectNothingHappened(): void {
  expect(mockGetPositions).not.toHaveBeenCalled();
  expect(mockRequestRedeem).not.toHaveBeenCalled();
  expect(mockRequestWithdraw).not.toHaveBeenCalled();
  expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
  expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
  expect(mockSubmitOverRpc).not.toHaveBeenCalled();
}

/**
 * A refusal decided from the positions READ: the read happened, but nothing was
 * requested, recorded, signed or broadcast. Recording semantics match the
 * sibling amount path, which files `createAgentActivityPreBroadcastFailure`
 * ONLY for a provider rejection of the unsigned-transaction request.
 */
function expectRefusedAfterPositionsRead(): void {
  expect(mockGetPositions).toHaveBeenCalledTimes(1);
  expect(mockRequestRedeem).not.toHaveBeenCalled();
  expect(mockRequestWithdraw).not.toHaveBeenCalled();
  expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
  expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
  expect(mockSubmitOverRpc).not.toHaveBeenCalled();
}

describe("solana.lend.withdraw — withdrawAll full exit via /earn/redeem (P3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSigningWallet.mockReturnValue({ family: "solana", address: WALLET_ADDRESS, secretKey: SIGNER.secretKey });
    mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
    mockGetPositions.mockResolvedValue([earnPosition()]);
    mockRequestWithdraw.mockResolvedValue({ transaction: "unsigned-withdraw-tx-b64" });
    mockRequestRedeem.mockResolvedValue({ transaction: "unsigned-redeem-tx-b64" });
    mockPrepareVersionedTx.mockResolvedValue(PREPARED);
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }] });
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 43, event: { id: 8 } });
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
    mockResolveJupiterToken.mockResolvedValue(USDC_METADATA);
  });

  // ── 1. Strict XOR param contract ─────────────────────────────────

  describe("strict XOR: exactly one of {amount} / {withdrawAll: true}", () => {
    it("refuses BOTH amount and withdrawAll:true by name, before any provider call", async () => {
      const result = await withdraw({ asset: USDC_MINT, amountRaw: "500000", withdrawAll: true });

      expect(result.success).toBe(false);
      expect(result.output).toMatch(/exactly one/i);
      expect(result.output).toContain("amount");
      expect(result.output).toContain("withdrawAll");
      expectNothingHappened();
    });

    it("refuses NEITHER amount nor withdrawAll by name, before any provider call", async () => {
      const result = await withdraw({ asset: USDC_MINT });

      expect(result.success).toBe(false);
      expect(result.output).toMatch(/exactly one/i);
      expect(result.output).toContain("amount");
      expect(result.output).toContain("withdrawAll");
      expectNothingHappened();
    });

    it("refuses withdrawAll:false BY NAME and points at amount instead", async () => {
      const result = await withdraw({ asset: USDC_MINT, withdrawAll: false });

      expect(result.success).toBe(false);
      expect(result.output).toContain("withdrawAll: false");
      expect(result.output).toContain("amount");
      expectNothingHappened();
    });

    it("refuses withdrawAll:false even alongside amount — a money param is never silently dropped", async () => {
      const result = await withdraw({ asset: USDC_MINT, amountRaw: "500000", withdrawAll: false });

      expect(result.success).toBe(false);
      expect(result.output).toContain("withdrawAll: false");
      expectNothingHappened();
    });

    it("still refuses a missing asset by name", async () => {
      const result = await withdraw({ withdrawAll: true });

      expect(result.success).toBe(false);
      expect(result.output).toContain("asset");
      expectNothingHappened();
    });

    it("fails closed without an active session — no positions read", async () => {
      const result = await withdraw({ asset: USDC_MINT, withdrawAll: true }, ctx({ sessionId: undefined }));

      expect(result.success).toBe(false);
      expectNothingHappened();
    });
  });

  // ── 2. Position resolution (wallet AND asset) ────────────────────

  describe("position resolution", () => {
    it("no Earn position for the asset → named refusal, nothing recorded, nothing signed", async () => {
      mockGetPositions.mockResolvedValue([earnPosition({ assetAddress: USDT_MINT })]);

      const result = await withdraw({ asset: USDC_MINT, withdrawAll: true });

      expect(result.success).toBe(false);
      expect(result.output).toContain(USDC_MINT);
      expect(result.output).toMatch(/no .*position/i);
      expect(result.output).toContain("solana.lend.positions");
      expectRefusedAfterPositionsRead();
    });

    it("a same-asset position owned by ANOTHER wallet is not a match", async () => {
      mockGetPositions.mockResolvedValue([earnPosition({ ownerAddress: OTHER_WALLET_ADDRESS })]);

      const result = await withdraw({ asset: USDC_MINT, withdrawAll: true });

      expect(result.success).toBe(false);
      expect(result.output).toMatch(/no .*position/i);
      expectRefusedAfterPositionsRead();
    });

    it("SEVERAL matching positions → named refusal, never guesses which one to exit", async () => {
      mockGetPositions.mockResolvedValue([
        earnPosition({ shares: "1046532" }),
        earnPosition({ shares: "77" }),
      ]);

      const result = await withdraw({ asset: USDC_MINT, withdrawAll: true });

      expect(result.success).toBe(false);
      expect(result.output).toContain(USDC_MINT);
      expect(result.output).toMatch(/amount/);
      expectRefusedAfterPositionsRead();
    });

    it("a position holding 0 shares → named 'nothing to withdraw' refusal", async () => {
      mockGetPositions.mockResolvedValue([earnPosition({ shares: "0", underlyingAssets: "0" })]);

      const result = await withdraw({ asset: USDC_MINT, withdrawAll: true });

      expect(result.success).toBe(false);
      expect(result.output).toMatch(/nothing to withdraw/i);
      expectRefusedAfterPositionsRead();
    });

    it("a share balance that is not a whole number → refuses rather than redeem an unprovable amount", async () => {
      mockGetPositions.mockResolvedValue([earnPosition({ shares: "1046532.5" })]);

      const result = await withdraw({ asset: USDC_MINT, withdrawAll: true });

      expect(result.success).toBe(false);
      expect(result.output).toMatch(/amount/);
      expectRefusedAfterPositionsRead();
    });
  });

  // ── 3. Happy path ────────────────────────────────────────────────

  describe("full exit", () => {
    it("redeems the position's EXACT current shares — never the amount-denominated /withdraw", async () => {
      // Noise in the same response: a different asset and a different owner.
      mockGetPositions.mockResolvedValue([
        earnPosition({ assetAddress: USDT_MINT, shares: "999" }),
        earnPosition({ ownerAddress: OTHER_WALLET_ADDRESS, shares: "888" }),
        earnPosition({ shares: "1046532", underlyingAssets: "1047061" }),
      ]);

      await withdraw({ asset: USDC_MINT, withdrawAll: true });

      expect(mockGetPositions).toHaveBeenCalledWith(WALLET_ADDRESS);
      expect(mockRequestRedeem).toHaveBeenCalledTimes(1);
      expect(mockRequestRedeem).toHaveBeenCalledWith({
        asset: USDC_MINT, shares: "1046532", signer: WALLET_ADDRESS,
      });
      expect(mockRequestWithdraw).not.toHaveBeenCalled();
    });

    it("records underlyingAssets as the requested out-leg and runs the staged seam exactly once", async () => {
      const result = await withdraw({ asset: USDC_MINT, withdrawAll: true });

      expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
      expect(mockCreateAgentActivityIntent).toHaveBeenCalledWith(expect.objectContaining({
        toolId: "solana.lend.withdraw",
        namespace: "solana",
        // Provenance: the audit row shows the call was a full exit, not a partial.
        intentParams: { asset: USDC_MINT, withdrawAll: true },
        events: [expect.objectContaining({
          eventRole: "lend_withdraw",
          kind: "lend",
          chainFamily: "solana",
          walletAddress: WALLET_ADDRESS,
          // The REQUESTED magnitude is the position's underlying value at read
          // time — 1047061 @ 6 decimals = 1.047061 USDC. Executed truth comes
          // from the settlement decoder, never from this estimate.
          tokenOut: {
            tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6,
            amountHuman: "1.047061", amountRaw: "1047061",
          },
        })],
      }));

      // The seam is entered ONCE, in order, and the tipless redeem goes over RPC.
      expect(mockPrepareVersionedTx).toHaveBeenCalledTimes(1);
      expect(mockPrepareVersionedTx).toHaveBeenCalledWith("unsigned-redeem-tx-b64", expect.any(Keypair));
      expect(mockMarkActivitySolanaBroadcast).toHaveBeenCalledTimes(1);
      expect(mockSubmitOverRpc).toHaveBeenCalledTimes(1);

      // Truthful-pending — never a fabricated confirm.
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/pending/i);
      expect(result.output).toMatch(/do not retry/i);
      const data = result.data;
      expect(data?.status).toBe("pending");
      expect(data?.signature).toBe(PREPARED.signature);
    });
  });

  // ── 4. Amount path — existing behaviour unchanged ────────────────

  describe("amount path (sibling flow) is unchanged", () => {
    it("a partial withdrawal still calls /withdraw with the raw amount and never reads positions", async () => {
      const result = await withdraw({ asset: USDC_MINT, amountRaw: "500000" });

      expect(mockRequestWithdraw).toHaveBeenCalledWith({
        asset: USDC_MINT, amount: "500000", signer: WALLET_ADDRESS,
      });
      expect(mockRequestRedeem).not.toHaveBeenCalled();
      // No extra provider round-trip on the path that does not need one.
      expect(mockGetPositions).not.toHaveBeenCalled();
      expect(mockCreateAgentActivityIntent).toHaveBeenCalledWith(expect.objectContaining({
        intentParams: { asset: USDC_MINT, amountRaw: "500000" },
        events: [expect.objectContaining({
          eventRole: "lend_withdraw",
          tokenOut: {
            tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6,
            amountHuman: "0.5", amountRaw: "500000",
          },
        })],
      }));
      expect(result.output).toMatch(/pending/i);
    });

    it("a provider rejection on the amount path is still recorded as a PRE-broadcast failure", async () => {
      mockRequestWithdraw.mockRejectedValue(new Error("insufficient balance for withdraw"));

      const result = await withdraw({ asset: USDC_MINT, amountRaw: "500000" });

      expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
      expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
      expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });
});
