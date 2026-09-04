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

// ── Gate (Stage 7) ──────────────────────────────────────────────────────

describe("evaluateSwapPrequoteGate", () => {
  // The gate validates EVM legs with viem `isAddress` (strict checksum, same as
  // the kyber execute handler). The all-uppercase 6c hashing fixtures are NOT
  // valid checksummed addresses, so the gate uses LOWERCASE address legs (which
  // pass strict isAddress) — these stand in for the exact address a quote
  // returned. The recorder stores a checksummed/lowercased address; the hash
  // lowercases both, so a lowercase leg here collides with a recorded leg.
  const GATE_TOKEN_IN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const GATE_TOKEN_OUT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  // Standard EVM execute params (address legs — gate-able identity).
  const EVM_PARAMS = {
    chain: "base",
    tokenIn: GATE_TOKEN_IN,
    tokenOut: GATE_TOKEN_OUT,
    amountIn: "1",
  };
  const SOL_PARAMS = { tokenIn: SOLANA_MINT_A, tokenOut: SOL_MINT, amountIn: "1" };

  // ── Decision matrix ────────────────────────────────────────────────────

  it("no fresh prequote → block(no_quote)", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(null);
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("no_quote");
      expect(d.message).toMatch(/no fresh quote/i);
    }
  });

  it("fresh fail → block(safety_fail)", async () => {
    mockExistsFail.mockResolvedValue(true);
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toBe("safety_fail");
    // existsFreshFail short-circuits — latest is never consulted.
    expect(mockFindLatest).not.toHaveBeenCalled();
  });

  it("fresh pass → allow(pass)", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    expect(d.kind).toBe("allow");
    if (d.kind === "allow") {
      expect(d.verdict).toBe("pass");
      expect(d.prequoteId).toBe("prequote-row-1");
    }
  });

  it("fresh unknown → allow(unknown) + unknown_allowed warn (prefix only)", async () => {
    const warnSpy = vi.spyOn((await import("@utils/logger.js")).default, "warn");
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("unknown"));
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    expect(d.kind).toBe("allow");
    if (d.kind === "allow") expect(d.verdict).toBe("unknown");
    const unknownLog = warnSpy.mock.calls.find(
      (args) => String(Array.from(args)[0]) === "protocol.prequote.gate.unknown_allowed",
    );
    expect(unknownLog).toBeDefined();
    const [, meta] = unknownLog === undefined ? [] : Array.from(unknownLog);
    expect(isRecord(meta)).toBe(true);
    if (!isRecord(meta)) throw new Error("expected unknown_allowed log metadata");
    // Only an 8-char prefix is logged — never the full hash or any address.
    expect(String(meta.matchHashPrefix)).toHaveLength(8);
    expect(JSON.stringify(meta)).not.toContain(GATE_TOKEN_IN);
    warnSpy.mockRestore();
  });

  // ── Guardrail #1 — a fresh fail is NEVER allowed ───────────────────────

  it("guardrail#1: a fresh fail blocks even when latest row is pass/unknown (existsFreshFail dominates)", async () => {
    // existsFreshFail returns true → block BEFORE the latest pass row is read.
    mockExistsFail.mockResolvedValue(true);
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    expect(d.kind === "block" && d.reason).toBe("safety_fail");
    expect(mockFindLatest).not.toHaveBeenCalled();
  });

  it("guardrail#1: a latest-row fail also blocks (belt-and-suspenders, existsFreshFail false)", async () => {
    // existsFreshFail false (e.g. race) but the latest row is itself a fail →
    // must still block, never allow a fail verdict through.
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("fail"));
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    expect(d.kind === "block" && d.reason).toBe("safety_fail");
  });

  // ── R1 kind-isolation ──────────────────────────────────────────────────

  it("R1: gate reads only the 'swap' kind (a bridge row with the same hash is invisible)", async () => {
    // The repo is mocked, so we assert the gate passes kind='swap' to BOTH
    // reads — a bridge row never reaches the swap gate (DB filters it out).
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(null);
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    expect(d.kind === "block" && d.reason).toBe("no_quote");
    expect(mockExistsFail.mock.calls[0]![2]).toBe("swap");
    expect(mockFindLatest.mock.calls[0]![2]).toBe("swap");
  });

  // ── R2 EVM native canonicalization + bare-symbol block ─────────────────

  it("R2: native ETH input hashes to the same identity as the sentinel address", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.execute",
      { ...EVM_PARAMS, tokenIn: "ETH" },
      ctx(),
    );
    const hashFromKeyword = mockFindLatest.mock.calls[0]![1];
    resetMocks();
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.execute",
      { ...EVM_PARAMS, tokenIn: NATIVE_TOKEN_ADDRESS },
      ctx(),
    );
    const hashFromSentinel = mockFindLatest.mock.calls[0]![1];
    expect(hashFromKeyword).toBe(hashFromSentinel);
    // And both equal the recorder-side hash for a native-sentinel leg.
    // Stage 9: the EVM_PARAMS carry no recipient/approveExact/slippageBps, so the
    // gate defaults recipient → the selected wallet (self), approveExact → false,
    // slippageBps → "" (omitted), matching the recorder's quote-time defaults.
    expect(hashFromKeyword).toBe(
      mod.computePrequoteMatchHash({
        kind: "swap",
        sessionId: SESSION_ID,
        family: "eip155",
        provider: "kyberswap",
        chainId: 8453,
        walletAddress: "0xWALLET",
        tokenIn: NATIVE_TOKEN_ADDRESS,
        tokenOut: GATE_TOKEN_OUT,
        amount: "1",
        recipient: "0xWALLET",
        approveExact: false,
        slippageBps: "",
      }),
    );
  });

  it("R2: a non-native bare symbol leg → block(unresolved_token), no DB read, no network resolve", async () => {
    const d = await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.execute",
      { ...EVM_PARAMS, tokenIn: "USDC" },
      ctx(),
    );
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toBe("unresolved_token");
    expect(mockExistsFail).not.toHaveBeenCalled();
    expect(mockFindLatest).not.toHaveBeenCalled();
  });

  // ── Quote→execute hash collision ───────────────────────────────────────

  it("EVM: a recorded prequote and a matching execute collide (allow); a different amount misses", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    const matchHash = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "kyberswap",
      chainId: 8453,
      walletAddress: "0xWALLET",
      tokenIn: GATE_TOKEN_IN,
      tokenOut: GATE_TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
    await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    expect(mockFindLatest.mock.calls[0]![1]).toBe(matchHash);
    // A different amount produces a different hash → would miss the recorded row.
    resetMocks();
    mockFindLatest.mockResolvedValue(null);
    await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.execute",
      { ...EVM_PARAMS, amountIn: "2" },
      ctx(),
    );
    expect(mockFindLatest.mock.calls[0]![1]).not.toBe(matchHash);
  });

  it("Solana: symbol legs resolve to mints via the jupiter resolver, then hash + allow", async () => {
    // input passed as a SYMBOL; resolver maps it to SOLANA_MINT_A (the recorded mint).
    mockRequireJupiter.mockImplementation(async (q: string) =>
      q === "SOLSYM" ? { address: SOLANA_MINT_A } : { address: q },
    );
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass", { family: "solana", chainId: null }));
    const d = await mod.evaluateSwapPrequoteGate(
      "solana.swap.execute",
      { tokenIn: "SOLSYM", tokenOut: SOL_MINT, amountIn: "1" },
      ctx(),
    );
    expect(d.kind).toBe("allow");
    // Hash must equal the recorder hash for the RESOLVED mint (not the symbol).
    // Stage 9: Solana pins recipient → self, approveExact → false; slippageBps
    // omitted ("") here as the execute params carry none.
    const expected = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "solana",
      provider: "jupiter",
      chainId: null,
      walletAddress: "0xWALLET",
      tokenIn: SOLANA_MINT_A,
      tokenOut: SOL_MINT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
      // W5 (design §6 R4): the Jupiter fee-bearing tail — the execute params
      // carry none of the knobs, so every one resolves to its canonical
      // default (tip 0.001 SOL, CU strategy "high", no DEX filters, wrap on,
      // not a Jito bundle), matching `resolveJupiterFeeSwapKnobs`'s defaults.
      feeBps: "25",
      feeMint: SOLANA_MINT_A,
      tipLamports: "1000000",
      cuStrategy: "high",
      routeKnobs: "|||1|0",
    });
    expect(mockFindLatest.mock.calls[0]![1]).toBe(expected);
    expect(mockFindLatest.mock.calls[0]![2]).toBe("swap");
  });

  // W5a fail-closed proof. The retired spellings are rejected by
  // `validateProtocolParams` before this gate ever runs, but if one ever
  // reached here the identity must degrade to a NON-MATCHING digest — never to
  // a hash over `undefined` that could collide with a real recorded row.
  it("Solana: the retired amount/inputToken spellings never produce a matching identity", async () => {
    mockRequireJupiter.mockImplementation(async (q: string) => ({ address: q }));
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(null);

    await mod.evaluateSwapPrequoteGate(
      "solana.swap.execute",
      { inputToken: SOLANA_MINT_A, outputToken: SOL_MINT, amount: 1 },
      ctx(),
    );
    const staleHash = mockFindLatest.mock.calls[0]?.[1];

    mockFindLatest.mockClear();
    await mod.evaluateSwapPrequoteGate("solana.swap.execute", SOL_PARAMS, ctx());
    expect(mockFindLatest.mock.calls[0]?.[1]).not.toBe(staleHash);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
