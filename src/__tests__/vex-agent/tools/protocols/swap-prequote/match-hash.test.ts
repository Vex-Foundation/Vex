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

// ── Match-hash ──────────────────────────────────────────────────────────

describe("computePrequoteMatchHash", () => {
  const base = {
    kind: "swap" as const,
    sessionId: SESSION_ID,
    family: "eip155" as const,
    // Wave-2c venue binding (LOCKED #4) — the quoting provider is identity.
    provider: "kyberswap",
    chainId: 8453,
    walletAddress: "0xWALLET",
    tokenIn: EVM_TOKEN_IN,
    tokenOut: EVM_TOKEN_OUT,
    amount: "1.0",
    // Stage 9 money/safety leg — recorder defaults (output-to-self / no
    // approveExact / slippage omitted).
    recipient: "0xWALLET",
    approveExact: false,
    slippageBps: "",
  };

  it("is deterministic", () => {
    expect(mod.computePrequoteMatchHash(base)).toBe(mod.computePrequoteMatchHash({ ...base }));
  });

  it("produces a full sha256 hex digest (64 lowercase hex chars)", () => {
    expect(mod.computePrequoteMatchHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("EVM lowercases the wallet address + token addresses", () => {
    const lower = mod.computePrequoteMatchHash(base);
    const upper = mod.computePrequoteMatchHash({
      ...base,
      walletAddress: "0xWALLET".toUpperCase(),
      tokenIn: EVM_TOKEN_IN.toUpperCase(),
      tokenOut: EVM_TOKEN_OUT.toUpperCase(),
    });
    expect(upper).toBe(lower);
  });

  it("Solana preserves mint case (base58 is case-sensitive)", () => {
    const solBase = {
      kind: "swap" as const,
      sessionId: SESSION_ID,
      family: "solana" as const,
      provider: "jupiter",
      chainId: null,
      walletAddress: "SolWalletAddr",
      tokenIn: SOLANA_MINT_A,
      tokenOut: SOL_MINT,
      amount: "1",
      recipient: "SolWalletAddr",
      approveExact: false,
      slippageBps: "",
    };
    const original = mod.computePrequoteMatchHash(solBase);
    const lowered = mod.computePrequoteMatchHash({ ...solBase, tokenIn: SOLANA_MINT_A.toLowerCase() });
    expect(lowered).not.toBe(original);
  });

  it('"1.0" and "1" (and "1.00", " 1 ") collide', () => {
    const h1 = mod.computePrequoteMatchHash({ ...base, amount: "1.0" });
    expect(mod.computePrequoteMatchHash({ ...base, amount: "1" })).toBe(h1);
    expect(mod.computePrequoteMatchHash({ ...base, amount: "1.00" })).toBe(h1);
    expect(mod.computePrequoteMatchHash({ ...base, amount: " 1 " })).toBe(h1);
    expect(mod.computePrequoteMatchHash({ ...base, amount: "01" })).toBe(h1);
  });

  it("distinct amounts produce distinct hashes", () => {
    expect(mod.computePrequoteMatchHash({ ...base, amount: "2" })).not.toBe(
      mod.computePrequoteMatchHash({ ...base, amount: "1" }),
    );
  });

  it("different session / wallet / token change the hash", () => {
    const h = mod.computePrequoteMatchHash(base);
    expect(mod.computePrequoteMatchHash({ ...base, sessionId: "other" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...base, walletAddress: "0xOTHER" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...base, tokenIn: "0xCAFE" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...base, tokenOut: "0xCAFE" })).not.toBe(h);
  });

  it("EVM chainId is part of the hash; Solana uses empty chain slot", () => {
    const evm = mod.computePrequoteMatchHash(base);
    const evmOtherChain = mod.computePrequoteMatchHash({ ...base, chainId: 1 });
    expect(evmOtherChain).not.toBe(evm);
    // Solana: chainId is ignored (always ""), so two solana inputs with the
    // same identity collide regardless of any chainId value passed.
    const sol1 = mod.computePrequoteMatchHash({ ...base, family: "solana", chainId: null });
    const sol2 = mod.computePrequoteMatchHash({ ...base, family: "solana", chainId: 999 });
    expect(sol1).toBe(sol2);
  });

  it("matches an explicit reference digest (composition is stable)", () => {
    const expected = createHash("sha256")
      .update(
        [
          "swap",
          SESSION_ID,
          "eip155",
          "8453",
          "0xwallet",
          EVM_TOKEN_IN.toLowerCase(),
          EVM_TOKEN_OUT.toLowerCase(),
          "1",
          // Stage 9 tail: recipient (family-canonical), approveExact "1"/"0",
          // slippageBps integer string or "".
          "0xwallet",
          "0",
          "",
          // Wave-2c venue binding — the provider token (lowercased).
          "kyberswap",
          // W5 (design §6 R4) Jupiter fee-bearing tail — "" for a non-Jupiter
          // swap (the `base` fixture omits every one of these fields).
          "",
          "",
          "",
          "",
          "",
        ].join(" "),
      )
      .digest("hex");
    expect(mod.computePrequoteMatchHash(base)).toBe(expected);
  });

  // ── W5 (design §6 R4) — Jupiter fee-bearing tail ─────────────────────────
  it("a Jupiter fee/tip/CU-strategy/route-knobs tail changes the hash; a non-Jupiter swap is unaffected by the new fields", () => {
    const withoutTail = mod.computePrequoteMatchHash(base);
    // Non-Jupiter callers never set the tail — omitting it must still match
    // the explicit-digest reference above (i.e. "" on every new field).
    expect(mod.computePrequoteMatchHash({ ...base, feeBps: undefined })).toBe(withoutTail);

    const jupiterBase = {
      ...base,
      family: "solana" as const,
      provider: "jupiter",
      chainId: null,
      feeBps: "25",
      feeMint: "MintA",
      tipLamports: "1000000",
      cuStrategy: "high",
      routeKnobs: "|| |1|0",
    };
    const jupiterHash = mod.computePrequoteMatchHash(jupiterBase);
    expect(jupiterHash).not.toBe(mod.computePrequoteMatchHash({ ...jupiterBase, feeBps: undefined, feeMint: undefined, tipLamports: undefined, cuStrategy: undefined, routeKnobs: undefined }));
    expect(jupiterHash).not.toBe(mod.computePrequoteMatchHash({ ...jupiterBase, tipLamports: "2000000" }));
    expect(jupiterHash).not.toBe(mod.computePrequoteMatchHash({ ...jupiterBase, routeKnobs: "Raydium||1|0" }));
    expect(jupiterHash).not.toBe(mod.computePrequoteMatchHash({ ...jupiterBase, feeBps: "50" }));
  });

  // ── Stage 9 — recipient / approveExact / slippageBps sensitivity ──────────

  it("a different recipient changes the swap hash", () => {
    const h = mod.computePrequoteMatchHash(base);
    expect(mod.computePrequoteMatchHash({ ...base, recipient: "0xATTACKER" })).not.toBe(h);
    // recipient is family-canonical for EVM (case-insensitive).
    expect(mod.computePrequoteMatchHash({ ...base, recipient: "0xWALLET".toUpperCase() })).toBe(h);
  });

  it("flipping approveExact changes the swap hash", () => {
    const h = mod.computePrequoteMatchHash(base);
    expect(mod.computePrequoteMatchHash({ ...base, approveExact: true })).not.toBe(h);
  });

  it("a different slippageBps changes the swap hash; omitted ('') is its own token", () => {
    const omitted = mod.computePrequoteMatchHash(base); // slippageBps: ""
    const fifty = mod.computePrequoteMatchHash({ ...base, slippageBps: "50" });
    const tenK = mod.computePrequoteMatchHash({ ...base, slippageBps: "10000" });
    expect(fifty).not.toBe(omitted);
    expect(tenK).not.toBe(fifty);
    expect(tenK).not.toBe(omitted);
  });

  // ── Wave-2c — venue binding (LOCKED #4) ──────────────────────────────────
  it("a different venue/provider changes the swap hash (kyber vs uniswap)", () => {
    const kyber = mod.computePrequoteMatchHash({ ...base, provider: "kyberswap" });
    const uni = mod.computePrequoteMatchHash({ ...base, provider: "uniswap" });
    // Same tokens/amount/chain/wallet, DIFFERENT venue → DIFFERENT hash, so a
    // kyber quote can never authorize a uniswap execute (and vice-versa).
    expect(uni).not.toBe(kyber);
    // Provider is case/space-insensitive (canonicalized).
    expect(mod.computePrequoteMatchHash({ ...base, provider: " KyberSwap " })).toBe(kyber);
  });

  it("a bridge hash binds its provider (khalani vs relay)", () => {
    const bridgeBase = {
      kind: "bridge" as const,
      sessionId: SESSION_ID,
      provider: "khalani",
      sourceFamily: "eip155" as const,
      destFamily: "eip155" as const,
      fromChainId: 8453,
      toChainId: 4663,
      sourceWallet: "0xWALLET",
      recipient: "0xWALLET",
      fromToken: EVM_TOKEN_IN,
      toToken: EVM_TOKEN_OUT,
      amount: "1000",
      tradeType: "EXACT_INPUT" as const,
      refundTo: "0xWALLET",
      referrer: "",
      referrerFeeBps: "",
      filler: "",
      slippageBps: "",
    };
    const khalani = mod.computePrequoteMatchHash(bridgeBase);
    const relay = mod.computePrequoteMatchHash({ ...bridgeBase, provider: "relay" });
    expect(relay).not.toBe(khalani);
  });
});
