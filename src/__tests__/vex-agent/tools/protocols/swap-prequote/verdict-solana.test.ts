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
    safetyDetail: {},
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

// ── Solana verdict ──────────────────────────────────────────────────────

describe("verdict — Solana (solana.swap.quote)", () => {
  function verdictOf(
    inMint: string,
    outMint: string,
    safety: Record<string, unknown> | undefined,
  ): string | undefined {
    return mod.extractQuote("solana.swap.quote", { amountIn: "1" }, solanaResult(inMint, outMint, safety))?.verdict;
  }

  it("isSus:true → fail", () => {
    expect(
      verdictOf(SOLANA_MINT_A, SOL_MINT, { inputToken: { isSus: true } }),
    ).toBe("fail");
  });

  it("isSus:false → pass", () => {
    expect(
      verdictOf(SOLANA_MINT_A, SOL_MINT, { inputToken: { isSus: false } }),
    ).toBe("pass");
  });

  it("absent entry for a non-native mint → unknown (fail-closed)", () => {
    // Trade between two non-native mints, no safety block at all.
    expect(verdictOf(SOLANA_MINT_A, SOLANA_MINT_B, undefined)).toBe("unknown");
  });

  it("absent entry for ONE non-native leg → unknown", () => {
    // input audited clean, output non-native but no entry → unknown.
    expect(
      verdictOf(SOLANA_MINT_A, SOLANA_MINT_B, { inputToken: { isSus: false } }),
    ).toBe("unknown");
  });

  it("native SOL/wSOL leg → does not worsen (other leg clean → pass)", () => {
    expect(
      verdictOf(SOL_MINT, SOLANA_MINT_A, { outputToken: { isSus: false } }),
    ).toBe("pass");
  });

  it("both legs native → pass even with no safety block", () => {
    // wSOL→wSOL is degenerate but must not be unknown.
    expect(verdictOf(SOL_MINT, SOL_MINT, undefined)).toBe("pass");
  });

  it("worst-leg aggregation: clean + isSus:true → fail", () => {
    expect(
      verdictOf(SOLANA_MINT_A, SOLANA_MINT_B, {
        inputToken: { isSus: false },
        outputToken: { isSus: true },
      }),
    ).toBe("fail");
  });

  it("present entry with null isSus → unknown (no verdict signal)", () => {
    expect(
      verdictOf(SOLANA_MINT_A, SOL_MINT, { inputToken: { mintAuthorityDisabled: true } }),
    ).toBe("unknown");
  });

  it("safety_detail carries bounded audited fields", () => {
    const extracted = mod.extractQuote(
      "solana.swap.quote",
      { amountIn: "1" },
      solanaResult(SOLANA_MINT_A, SOL_MINT, {
        inputToken: { isSus: false, mintAuthorityDisabled: true, topHoldersPercentage: 12.5 },
      }),
    );
    expect(extracted?.safetyDetail).toEqual({
      inputToken: { isSus: false, mintAuthorityDisabled: true, topHoldersPercentage: 12.5 },
      outputToken: { native: true },
    });
  });
});
