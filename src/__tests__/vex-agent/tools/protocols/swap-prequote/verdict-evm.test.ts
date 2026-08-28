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

// ── EVM verdict ─────────────────────────────────────────────────────────

describe("verdict — EVM (kyberswap.swap.quote)", () => {
  function verdictOf(inLeg: Record<string, unknown>, outLeg: Record<string, unknown>): string | undefined {
    return mod.extractQuote("kyberswap.swap.quote", { amountIn: "1" }, evmResult(inLeg, outLeg))?.verdict;
  }

  it("honeypot leg → fail", () => {
    expect(verdictOf({ isHoneypot: true, isFOT: false, tax: 0 }, { native: true })).toBe("fail");
  });

  it("FoT with tax > 50 → pass (owner doctrine: only a confirmed honeypot is a hard block)", () => {
    expect(verdictOf({ isHoneypot: false, isFOT: true, tax: 60 }, { native: true })).toBe("pass");
    expect(verdictOf({ isHoneypot: false, isFOT: true, tax: 9999 }, { native: true })).toBe("pass");
  });

  it("FoT with tax <= 50 → pass (info-only, not a fail)", () => {
    expect(verdictOf({ isHoneypot: false, isFOT: true, tax: 50 }, { native: true })).toBe("pass");
    expect(verdictOf({ isHoneypot: false, isFOT: true, tax: 10 }, { native: true })).toBe("pass");
  });

  it("checkFailed leg → unknown (fail-closed)", () => {
    expect(verdictOf({ checkFailed: true, reason: "timeout" }, { native: true })).toBe("unknown");
  });

  it("native leg → does not worsen (clean other leg → pass)", () => {
    expect(verdictOf({ native: true }, { isHoneypot: false, isFOT: false, tax: 0 })).toBe("pass");
  });

  it("clean audited legs → pass", () => {
    expect(
      verdictOf(
        { isHoneypot: false, isFOT: false, tax: 0 },
        { isHoneypot: false, isFOT: false, tax: 0 },
      ),
    ).toBe("pass");
  });

  it("malformed leg shape → whole extraction fails (null)", () => {
    // A leg that matches none of the three shapes fails the safety schema, so
    // the EVM result no longer structurally validates → extraction returns null.
    const result = mod.extractQuote(
      "kyberswap.swap.quote",
      { amountIn: "1" },
      evmResult({ bogus: 1 }, { native: true }),
    );
    expect(result).toBeNull();
  });

  it("worst-leg aggregation: clean + honeypot → fail", () => {
    expect(
      verdictOf({ isHoneypot: false, isFOT: false, tax: 0 }, { isHoneypot: true, isFOT: false, tax: 0 }),
    ).toBe("fail");
  });

  it("worst-leg aggregation: clean + checkFailed → unknown", () => {
    expect(
      verdictOf({ isHoneypot: false, isFOT: false, tax: 0 }, { checkFailed: true, reason: "unavailable" }),
    ).toBe("unknown");
  });

  it("worst-leg aggregation: clean + FoT(any tax, not honeypot) → pass (no longer a fail)", () => {
    // A non-honeypot FoT leg no longer worsens the verdict, regardless of tax.
    expect(
      verdictOf({ isHoneypot: false, isFOT: false, tax: 0 }, { isHoneypot: false, isFOT: true, tax: 80 }),
    ).toBe("pass");
    expect(
      verdictOf({ isHoneypot: false, isFOT: true, tax: 51 }, { isHoneypot: false, isFOT: false, tax: 0 }),
    ).toBe("pass");
  });

  it("worst-leg aggregation: fail dominates unknown", () => {
    expect(
      verdictOf({ checkFailed: true, reason: "timeout" }, { isHoneypot: true, isFOT: false, tax: 0 }),
    ).toBe("fail");
  });

  it("safety_detail carries bounded fields only", () => {
    const extracted = mod.extractQuote(
      "kyberswap.swap.quote",
      { amountIn: "1" },
      evmResult({ isHoneypot: false, isFOT: true, tax: 12 }, { native: true }),
    );
    expect(extracted?.safetyDetail).toEqual({
      tokenIn: { isHoneypot: false, isFOT: true, tax: 12 },
      tokenOut: { native: true },
    });
  });

  it("safety_detail STILL discloses a high-tax FoT leg even though the verdict is now pass", () => {
    // The verdict softens (pass), but the disclosure must NOT — the model/human
    // still sees the fee-on-transfer in the quote output.
    const extracted = mod.extractQuote(
      "kyberswap.swap.quote",
      { amountIn: "1" },
      evmResult({ isHoneypot: false, isFOT: true, tax: 75 }, { native: true }),
    );
    expect(extracted?.verdict).toBe("pass");
    expect(extracted?.safetyDetail).toEqual({
      tokenIn: { isHoneypot: false, isFOT: true, tax: 75 },
      tokenOut: { native: true },
    });
  });

  it("checkFailed detail surfaces only a bounded reason class", () => {
    const extracted = mod.extractQuote(
      "kyberswap.swap.quote",
      { amountIn: "1" },
      evmResult({ checkFailed: true, reason: "rate_limited" }, { native: true }),
    );
    expect(extracted?.safetyDetail).toEqual({
      tokenIn: { checkFailed: true, reason: "rate_limited" },
      tokenOut: { native: true },
    });
  });
});
