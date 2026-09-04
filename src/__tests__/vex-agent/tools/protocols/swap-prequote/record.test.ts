/**
 * Swap prequote module — Stage 6c unit tests.
 *
 * Pins:
 *   - Verdict (EVM): honeypot→fail (the ONLY hard block per owner doctrine),
 *     FoT tax>50→pass, FoT tax<=50→pass (fee-on-transfer is the model's call,
 *     not a fail), checkFailed→unknown, native→ok, clean→pass, malformed
 *     leg→unknown, worst-leg aggregation. safety_detail STILL discloses
 *     { isHoneypot, isFOT, tax } even though the verdict softened.
 *   - Verdict (Solana): isSus:true→fail, isSus:false→pass, absent entry for
 *     non-native mint→unknown, native/wSOL leg→ok, worst-leg aggregation.
 *   - Match-hash: determinism; EVM lowercases address+wallet; Solana preserves
 *     mint case; "1.0" vs "1" collide; slippage does NOT change the hash;
 *     session/wallet/token/amount DO change it.
 *   - Recording: EVM-shaped result writes a row with expected verdict/identity;
 *     Solana-shaped result writes; malformed result records nothing without
 *     throwing; a resolveSelectedAddress throw records nothing without throwing.
 *   - Gate (Stage 7): allow/block matrix, guardrail #1 (fresh fail never slips),
 *     R1 kind-isolation, R2 EVM native canon + bare-symbol block, EVM/Solana
 *     quote→execute hash collision, R3 fail-closed (DB throw / resolve throw /
 *     no session → bounded block, no raw text).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { createHash } from "node:crypto";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { SwapPrequote, SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import { rowVexFee, venueSwapVexFee } from "../prequote/vex-fee-fixtures.js";

// ── Mocks ─────────────────────────────────────────────────────────────────

type CreateMock = Mock<(input: unknown) => Promise<void>>;
type ResolveMock = Mock<(...args: unknown[]) => string>;
type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;
type JupiterMock = Mock<(q: string) => Promise<{ address: string }>>;

let mockCreate: CreateMock;
let mockResolveSelectedAddress: ResolveMock;
let mockFindLatest: FindMock;
let mockExistsFail: ExistsMock;
let mockRequireJupiter: JupiterMock;

function resetMocks() {
  mockCreate = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  mockResolveSelectedAddress = vi
    .fn<(...args: unknown[]) => string>()
    .mockReturnValue("0xWALLET");
  mockFindLatest = vi
    .fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>()
    .mockResolvedValue(null);
  mockExistsFail = vi
    .fn<(s: string, h: string, k: string) => Promise<boolean>>()
    .mockResolvedValue(false);
  // Default Solana resolver: identity (mint passed through) — tests override.
  mockRequireJupiter = vi
    .fn<(q: string) => Promise<{ address: string }>>()
    .mockImplementation(async (q: string) => ({ address: q }));
}
resetMocks();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: unknown) => mockCreate(input),
  findLatestFreshByMatch: (s: string, h: string, k: string) => mockFindLatest(s, h, k),
  existsFreshFailByMatch: (s: string, h: string, k: string) => mockExistsFail(s, h, k),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  requireJupiterResolvedToken: (q: string) => mockRequireJupiter(q),
}));

const mod = await import("@vex-agent/tools/protocols/swap-prequote.js");

/** Build a full SwapPrequote row stub with a given verdict (gate reads only a few fields). */
function prequoteRow(verdict: SafetyVerdict, overrides: Partial<SwapPrequote> = {}): SwapPrequote {
  return {
    prequoteId: "prequote-row-1",
    sessionId: SESSION_ID,
    matchHash: "h".repeat(64),
    kind: "swap",
    family: "eip155",
    provider: "kyberswap",
    chainId: 8453,
    walletAddress: "0xWALLET",
    tokenIn: EVM_TOKEN_IN,
    tokenOut: EVM_TOKEN_OUT,
    amount: "1",
    slippageBps: 50,
    safetyVerdict: verdict,
    safetyDetail: { vexFee: rowVexFee() },
    routeRef: null,
    // Migration 095: a row that predates the claim lane reads as an
    // executable, unclaimed quote. It authorizes nothing on its own - the
    // claim additionally requires a stored route snapshot.
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: "2026-06-04T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
});

// ── Fixtures ────────────────────────────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const EVM_TOKEN_IN = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const EVM_TOKEN_OUT = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SOLANA_MINT_A = "FooMintCaseSensitiveABC123";
const SOLANA_MINT_B = "BarMintCaseSensitiveXYZ789";

function ctx(overrides: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
    ...overrides,
  };
}

// EVM kyberswap.swap.quote result.data builder.
function evmResult(
  tokenInLeg: Record<string, unknown>,
  tokenOutLeg: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chain: "base",
    chainId: 8453,
    tokenIn: { address: EVM_TOKEN_IN, symbol: "AAA", decimals: 18 },
    tokenOut: { address: EVM_TOKEN_OUT, symbol: "BBB", decimals: 18 },
    routeSummary: { foo: "bar" },
    routerAddress: "0xROUTER",
    safety: { tokenIn: tokenInLeg, tokenOut: tokenOutLeg },
    vexFee: venueSwapVexFee(),
    ...overrides,
  };
}

// Solana solana.swap.quote result.data builder.
function solanaResult(
  inMint: string,
  outMint: string,
  safety: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    inputToken: { chain: "solana", address: inMint, symbol: "IN", name: "In", decimals: 6 },
    outputToken: { chain: "solana", address: outMint, symbol: "OUT", name: "Out", decimals: 6 },
    inputAmountRaw: "1000000",
    slippageBps: 50,
    requestId: "req-1",
    ...overrides,
  };
  if (safety !== undefined) base.safety = safety;
  return base;
}

// ── Recording ───────────────────────────────────────────────────────────

describe("recordPrequoteFromQuote", () => {
  it("writes a row for a successful EVM quote with expected verdict + identity", async () => {
    // Mixed-case checksum-style address — stored verbatim; only the hash lowercases.
    const evmWallet = "0xDeAdBeEf00000000000000000000000000001234";
    mockResolveSelectedAddress.mockReturnValue(evmWallet);
    await mod.recordPrequoteFromQuote(
      "kyberswap.swap.quote",
      { amountIn: "1.0", slippageBps: 30 },
      evmResult({ isHoneypot: false, isFOT: false, tax: 0 }, { native: true }),
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const input = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.sessionId).toBe(SESSION_ID);
    expect(input.kind).toBe("swap");
    expect(input.family).toBe("eip155");
    expect(input.provider).toBe("kyberswap");
    expect(input.chainId).toBe(8453);
    expect(input.tokenIn).toBe(EVM_TOKEN_IN);
    expect(input.tokenOut).toBe(EVM_TOKEN_OUT);
    expect(input.amount).toBe("1.0");
    expect(input.slippageBps).toBe(30);
    expect(input.safetyVerdict).toBe("pass");
    // Wallet address is stored VERBATIM (mixed case preserved); only the hash
    // lowercases EVM addresses.
    expect(input.walletAddress).toBe(evmWallet);
    expect(typeof input.prequoteId).toBe("string");
    expect(String(input.prequoteId).startsWith("prequote-")).toBe(true);
    // match_hash must equal the exported pure function on the SAME identity.
    // Stage 9: the recorder defaults recipient → the resolved wallet (self) and
    // approveExact → false, and reads slippageBps from the QUOTE params (30 here).
    expect(input.matchHash).toBe(
      mod.computePrequoteMatchHash({
        kind: "swap",
        sessionId: SESSION_ID,
        family: "eip155",
        provider: "kyberswap",
        chainId: 8453,
        walletAddress: evmWallet,
        tokenIn: EVM_TOKEN_IN,
        tokenOut: EVM_TOKEN_OUT,
        amount: "1.0",
        recipient: evmWallet,
        approveExact: false,
        slippageBps: "30",
      }),
    );
    // expires_at is in the future.
    expect(new Date(String(input.expiresAt)).getTime()).toBeGreaterThan(Date.now());
  });

  it("writes a row for a successful Solana quote", async () => {
    mockResolveSelectedAddress.mockReturnValue("SolWalletAddr");
    await mod.recordPrequoteFromQuote(
      "solana.swap.quote",
      { amountIn: "2.5", slippageBps: 100 },
      solanaResult(SOLANA_MINT_A, SOL_MINT, { inputToken: { isSus: false } }),
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const input = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.family).toBe("solana");
    expect(input.provider).toBe("jupiter");
    expect(input.chainId).toBeNull();
    expect(input.tokenIn).toBe(SOLANA_MINT_A);
    expect(input.tokenOut).toBe(SOL_MINT);
    expect(input.amount).toBe("2.5");
    expect(input.safetyVerdict).toBe("pass");
  });

  it("records nothing for a malformed result (no throw)", async () => {
    await expect(
      mod.recordPrequoteFromQuote(
        "kyberswap.swap.quote",
        { amountIn: "1" },
        { totally: "wrong" },
        ctx(),
      ),
    ).resolves.toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("records nothing when resolveSelectedAddress throws (no throw, no fabricated address)", async () => {
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_NOT_SELECTED, "no wallet");
    });
    await expect(
      mod.recordPrequoteFromQuote(
        "kyberswap.swap.quote",
        { amountIn: "1" },
        evmResult({ native: true }, { native: true }),
        ctx(),
      ),
    ).resolves.toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("records nothing when sessionId is absent", async () => {
    await mod.recordPrequoteFromQuote(
      "kyberswap.swap.quote",
      { amountIn: "1" },
      evmResult({ native: true }, { native: true }),
      ctx({ sessionId: undefined }),
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("ignores an unregistered tool id", async () => {
    await mod.recordPrequoteFromQuote(
      "kyberswap.swap.sell",
      { amountIn: "1" },
      evmResult({ native: true }, { native: true }),
      ctx(),
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("swallows a DB write failure (never throws to the caller)", async () => {
    // The module owns its own "never throws" contract — a rejecting create()
    // must resolve, not propagate (the runtime caller also guards, but the
    // module must not rely on that). The throw site is reached (create called),
    // and only a bounded reason is logged.
    mockCreate.mockRejectedValueOnce(new Error("boom"));
    await expect(
      mod.recordPrequoteFromQuote(
        "kyberswap.swap.quote",
        { amountIn: "1" },
        evmResult({ isHoneypot: false, isFOT: false, tax: 0 }, { native: true }),
        ctx(),
      ),
    ).resolves.toBeUndefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
