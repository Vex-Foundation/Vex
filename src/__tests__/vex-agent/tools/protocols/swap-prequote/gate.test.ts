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
  const SOL_PARAMS = { inputToken: SOLANA_MINT_A, outputToken: SOL_MINT, amount: 1 };

  // ── Decision matrix ────────────────────────────────────────────────────

  it("no fresh prequote → block(no_quote)", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(null);
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("no_quote");
      expect(d.message).toMatch(/no fresh quote/i);
    }
  });

  it("fresh fail → block(safety_fail)", async () => {
    mockExistsFail.mockResolvedValue(true);
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toBe("safety_fail");
    // existsFreshFail short-circuits — latest is never consulted.
    expect(mockFindLatest).not.toHaveBeenCalled();
  });

  it("fresh pass → allow(pass)", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
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
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind).toBe("allow");
    if (d.kind === "allow") expect(d.verdict).toBe("unknown");
    const unknownLog = warnSpy.mock.calls.find(
      (c) => c[0] === "protocol.prequote.gate.unknown_allowed",
    );
    expect(unknownLog).toBeDefined();
    const meta = unknownLog?.[1] as Record<string, unknown>;
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
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind === "block" && d.reason).toBe("safety_fail");
    expect(mockFindLatest).not.toHaveBeenCalled();
  });

  it("guardrail#1: a latest-row fail also blocks (belt-and-suspenders, existsFreshFail false)", async () => {
    // existsFreshFail false (e.g. race) but the latest row is itself a fail →
    // must still block, never allow a fail verdict through.
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("fail"));
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind === "block" && d.reason).toBe("safety_fail");
  });

  // ── R1 kind-isolation ──────────────────────────────────────────────────

  it("R1: gate reads only the 'swap' kind (a bridge row with the same hash is invisible)", async () => {
    // The repo is mocked, so we assert the gate passes kind='swap' to BOTH
    // reads — a bridge row never reaches the swap gate (DB filters it out).
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(null);
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind === "block" && d.reason).toBe("no_quote");
    expect(mockExistsFail.mock.calls[0]![2]).toBe("swap");
    expect(mockFindLatest.mock.calls[0]![2]).toBe("swap");
  });

  // ── R2 EVM native canonicalization + bare-symbol block ─────────────────

  it("R2: native ETH input hashes to the same identity as the sentinel address", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.sell",
      { ...EVM_PARAMS, tokenIn: "ETH" },
      ctx(),
    );
    const hashFromKeyword = mockFindLatest.mock.calls[0]![1];
    resetMocks();
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.sell",
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
      "kyberswap.swap.sell",
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
    await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(mockFindLatest.mock.calls[0]![1]).toBe(matchHash);
    // A different amount produces a different hash → would miss the recorded row.
    resetMocks();
    mockFindLatest.mockResolvedValue(null);
    await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.sell",
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
      { inputToken: "SOLSYM", outputToken: SOL_MINT, amount: 1 },
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
    });
    expect(mockFindLatest.mock.calls[0]![1]).toBe(expected);
    expect(mockFindLatest.mock.calls[0]![2]).toBe("swap");
  });

  // ── Wave-2c venue binding (LOCKED #4) — cross-venue quote→execute REJECTED ──

  it("VENUE: a kyberswap quote hash can never authorize a uniswap execute (same identity)", async () => {
    // The hash a kyber QUOTE would have recorded for this exact identity.
    const kyberHash = mod.computePrequoteMatchHash({
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
    // A UNISWAP execute for the SAME tokens/amount/chain/wallet looks up a
    // DIFFERENT hash — so the kyber prequote row can never match → no_quote.
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(null);
    const d = await mod.evaluatePrequoteGate("uniswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toBe("no_quote");
    expect(mockFindLatest.mock.calls[0]![1]).not.toBe(kyberHash);
    // And the uniswap gate hash equals the uniswap-provider hash (record-side
    // symmetry: the uniswap quote recorder pins provider "uniswap").
    const uniswapHash = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "uniswap",
      chainId: 8453,
      walletAddress: "0xWALLET",
      tokenIn: GATE_TOKEN_IN,
      tokenOut: GATE_TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
    expect(mockFindLatest.mock.calls[0]![1]).toBe(uniswapHash);
  });

  it("VENUE: uniswap execute on Robinhood Chain (4663) is gate-able (de-kyber-coupled chain resolution)", async () => {
    // "robinhood" is NOT a KyberSwap slug — pre-2c the EVM identity builder would
    // have thrown (gate_error). Now the uniswap provider branch resolves 4663 via
    // the local registry and the gate computes a real identity.
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass", { provider: "uniswap", chainId: 4663 }));
    const d = await mod.evaluatePrequoteGate(
      "uniswap.swap.sell",
      { ...EVM_PARAMS, chain: "robinhood" },
      ctx(),
    );
    expect(d.kind).toBe("allow");
    const expected = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "uniswap",
      chainId: 4663,
      walletAddress: "0xWALLET",
      tokenIn: GATE_TOKEN_IN,
      tokenOut: GATE_TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
    expect(mockFindLatest.mock.calls[0]![1]).toBe(expected);
  });

  // ── Uniswap native-leg identity — record→gate hash collision ────────────
  //
  // The uniswap quote echoes its routing WETH address for a native leg
  // (isNative: true) while the gate canonicalizes execute-time "native"/ETH
  // input to NATIVE_TOKEN_ADDRESS. The recorder must store the SAME sentinel
  // or a native-leg quote can never authorize its execute (live bug: every
  // ETH-leg uniswap swap on Robinhood 4663 blocked with no_quote).

  const ROBINHOOD_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
  const UNISWAP_SAFETY_PASS = {
    factory: { checked: true, allowlisted: true },
    liquidity: { checked: true, usd: 50_000, aboveThreshold: true },
    fot: { suspected: false },
  };

  it("UNISWAP native IN: a WETH-echoed native-leg quote records the sentinel and authorizes a 'native' execute", async () => {
    await mod.recordPrequoteFromQuote(
      "uniswap.swap.quote",
      { chain: "robinhood", tokenIn: "native", tokenOut: GATE_TOKEN_OUT, amountIn: "0.001" },
      {
        chainId: 4663,
        tokenIn: { address: ROBINHOOD_WETH, isNative: true },
        tokenOut: { address: GATE_TOKEN_OUT, isNative: false },
        safety: UNISWAP_SAFETY_PASS,
      },
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const row = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.tokenIn).toBe(NATIVE_TOKEN_ADDRESS);
    expect(row.tokenOut).toBe(GATE_TOKEN_OUT);
    const recordedHash = String(row.matchHash);

    resetMocks();
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(
      prequoteRow("pass", { provider: "uniswap", chainId: 4663, matchHash: recordedHash }),
    );
    const d = await mod.evaluatePrequoteGate(
      "uniswap.swap.buy",
      { chain: "robinhood", tokenIn: "native", tokenOut: GATE_TOKEN_OUT, amountIn: "0.001" },
      ctx(),
    );
    expect(d.kind).toBe("allow");
    expect(mockFindLatest.mock.calls[0]![1]).toBe(recordedHash);
  });

  it("UNISWAP native OUT: a token→ETH quote records the sentinel out-leg and matches an 'ETH' execute hash", async () => {
    await mod.recordPrequoteFromQuote(
      "uniswap.swap.quote",
      { chain: "robinhood", tokenIn: GATE_TOKEN_IN, tokenOut: "ETH", amountIn: "5" },
      {
        chainId: 4663,
        tokenIn: { address: GATE_TOKEN_IN, isNative: false },
        tokenOut: { address: ROBINHOOD_WETH, isNative: true },
        safety: UNISWAP_SAFETY_PASS,
      },
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const row = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.tokenOut).toBe(NATIVE_TOKEN_ADDRESS);
    const recordedHash = String(row.matchHash);

    resetMocks();
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(
      prequoteRow("pass", { provider: "uniswap", chainId: 4663, matchHash: recordedHash }),
    );
    const d = await mod.evaluatePrequoteGate(
      "uniswap.swap.sell",
      { chain: "robinhood", tokenIn: GATE_TOKEN_IN, tokenOut: "ETH", amountIn: "5" },
      ctx(),
    );
    expect(d.kind).toBe("allow");
    expect(mockFindLatest.mock.calls[0]![1]).toBe(recordedHash);
  });

  it("VENUE: kyberswap flows are byte-identical — the kyber gate hash did not change shape", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    const kyberHash = mod.computePrequoteMatchHash({
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
    expect(mockFindLatest.mock.calls[0]![1]).toBe(kyberHash);
  });

  // ── R3 fail-closed ─────────────────────────────────────────────────────

  it("R3: a thrown DB read → block(gate_error), no raw text in message", async () => {
    mockExistsFail.mockRejectedValue(new Error("connection refused at 10.0.0.1:5432 secret=hunter2"));
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("gate_error");
      expect(d.message).not.toContain("hunter2");
      expect(d.message).not.toContain("10.0.0.1");
      expect(d.message).toMatch(/could not verify a fresh quote/i);
    }
  });

  it("R3: a thrown Solana resolve → block(gate_error), no raw text", async () => {
    mockRequireJupiter.mockRejectedValue(new Error("jupiter 500 https://api.jup.ag/key=SECRET"));
    const d = await mod.evaluateSwapPrequoteGate("solana.swap.execute", SOL_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("gate_error");
      expect(d.message).not.toContain("SECRET");
      expect(d.message).not.toContain("jup.ag");
    }
    // Fail-closed: a resolve throw must never reach a DB read or allow.
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  // A wallet-resolution throw is STILL a fail-closed block (no DB read, no
  // fabricated address), but the reason/message is now ACCURATE instead of the
  // misleading "could not verify a fresh quote" that previously looped the agent.
  it("R3: WALLET_NOT_SELECTED throw → block(wallet_not_selected), accurate message, no DB read", async () => {
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_NOT_SELECTED, "no wallet selected");
    });
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("wallet_not_selected");
      expect(d.message).toMatch(/no wallet is selected/i);
      // Must NOT regress to the misleading loop-inducing message.
      expect(d.message).not.toMatch(/could not verify a fresh quote/i);
      // No raw thrown text leaks.
      expect(d.message).not.toContain("no wallet selected");
    }
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  it("R3: WALLET_SCOPE_MISMATCH during mission setup (invalid policy, no active run) → block(wallet_setup)", async () => {
    // resolveSelectedEntry succeeds, but the fail-closed policy assert rejects an
    // invalid setup policy — the real cause of the reported 100%-block bug.
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "Mission wallet policy is invalid");
    });
    const d = await mod.evaluateSwapPrequoteGate(
      "solana.swap.execute",
      SOL_PARAMS,
      ctx({ walletPolicy: { kind: "invalid", reason: "mission_without_active_run" } }),
    );
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("wallet_setup");
      expect(d.message).toMatch(/setup|active run/i);
      expect(d.message).not.toMatch(/could not verify a fresh quote/i);
    }
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  it("R3: WALLET_SCOPE_MISMATCH with a valid (non-setup) policy → block(wallet_scope)", async () => {
    // A valid mission_allowed policy but the selected wallet is not in the set →
    // a genuine scope mismatch (NOT setup), distinct actionable message.
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "not in the allowed wallet set");
    });
    const d = await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.sell",
      EVM_PARAMS,
      ctx({ walletPolicy: { kind: "mission_allowed", allowedWallets: ["0xOTHER"] } }),
    );
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("wallet_scope");
      expect(d.message).toMatch(/can't be used|allowed set/i);
      expect(d.message).not.toMatch(/could not verify a fresh quote/i);
    }
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  it("R3: WALLET_SCOPE_MISMATCH from wallet drift WITHOUT a mission (policy none) → block(wallet_scope), message does NOT claim setup", async () => {
    // resolveSelectedEntry throws WALLET_SCOPE_MISMATCH for a removed/drifted
    // selected wallet BEFORE any policy check. With no mission (policy "none")
    // this must NOT be mislabeled wallet_setup, and the message must not falsely
    // assert a mission setup / active-run requirement.
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "The wallet selected for this session is no longer available.");
    });
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("wallet_scope");
      expect(d.message).not.toMatch(/setup|active run/i);
      expect(d.message).not.toMatch(/could not verify a fresh quote/i);
    }
  });

  it("R3: WALLET_NOT_CONFIGURED (default resolution, no wallet) → block(wallet_not_selected)", async () => {
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_NOT_CONFIGURED, "No solana wallet is configured.");
    });
    const d = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("wallet_not_selected");
      expect(d.message).toMatch(/no wallet is selected/i);
      expect(d.message).not.toContain("No solana wallet is configured");
    }
  });

  it("R3: missing sessionId → block(no_session), no execution", async () => {
    const d = await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.sell",
      EVM_PARAMS,
      ctx({ sessionId: undefined }),
    );
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toBe("no_session");
    expect(mockResolveSelectedAddress).not.toHaveBeenCalled();
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  it("an unsupported EVM chain → block(gate_error) (resolveChainSlug throws, caught fail-closed)", async () => {
    const d = await mod.evaluateSwapPrequoteGate(
      "kyberswap.swap.sell",
      { ...EVM_PARAMS, chain: "not-a-real-chain" },
      ctx(),
    );
    expect(d.kind === "block" && d.reason).toBe("gate_error");
  });

  // ── Stage 9 EXPLOIT GUARDS — recipient / approveExact / slippageBps binding ─
  //
  // The recorder defaults a swap QUOTE's recipient → the resolved wallet (self),
  // approveExact → false, and reads slippageBps from the quote params. The gate
  // reads recipient/approveExact/slippageBps from the EXECUTE params. A recorded
  // quote (defaulted self / false / omitted) must NOT authorize an execute that
  // redirects the output, flips approveExact, or changes slippage.

  /** Record from a QUOTE then return the recorded match-hash (recorder ≡ gate proof). */
  async function recordedSwapHash(quoteParams: Record<string, unknown>): Promise<string> {
    resetMocks();
    await mod.recordPrequoteFromQuote(
      "kyberswap.swap.quote",
      quoteParams,
      evmResult({ isHoneypot: false, isFOT: false, tax: 0 }, { isHoneypot: false, isFOT: false, tax: 0 }),
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    return (mockCreate.mock.calls[0]![0] as Record<string, unknown>).matchHash as string;
  }

  /** Drive the gate with EXECUTE params; capture the gate hash + the decision. */
  async function gateHashAndDecision(
    executeParams: Record<string, unknown>,
    recordedHash: string,
  ): Promise<{ gateHash: string; decision: Awaited<ReturnType<typeof mod.evaluateSwapPrequoteGate>> }> {
    resetMocks();
    let gateHash = "";
    // The DB returns a fresh row ONLY when the gate's hash equals the recorded
    // one — exactly the real session+kind+match lookup semantics.
    mockFindLatest.mockImplementation(async (_s, h) => {
      gateHash = h;
      return h === recordedHash ? prequoteRow("pass", { matchHash: h }) : null;
    });
    const decision = await mod.evaluateSwapPrequoteGate("kyberswap.swap.sell", executeParams, ctx());
    return { gateHash, decision };
  }

  it("EXPLOIT(recipient): a quote (no recipient) does NOT authorize an execute with a different recipient → block(no_quote)", async () => {
    // Quote omits recipient → recorder defaults to the wallet (self).
    const recordedHash = await recordedSwapHash({ amountIn: "1" });

    // Execute redirects the output to a DIFFERENT address → hash diverges → block.
    const attacker = "0xcccccccccccccccccccccccccccccccccccccccc";
    const tampered = await gateHashAndDecision({ ...EVM_PARAMS, recipient: attacker }, recordedHash);
    expect(tampered.gateHash).not.toBe(recordedHash);
    expect(tampered.decision.kind).toBe("block");
    if (tampered.decision.kind === "block") expect(tampered.decision.reason).toBe("no_quote");

    // Execute that OMITS recipient (→ self) collides → allow.
    const matching = await gateHashAndDecision({ ...EVM_PARAMS }, recordedHash);
    expect(matching.gateHash).toBe(recordedHash);
    expect(matching.decision.kind).toBe("allow");

    // Execute that explicitly passes the SELF recipient also collides → allow.
    const selfExplicit = await gateHashAndDecision({ ...EVM_PARAMS, recipient: "0xWALLET" }, recordedHash);
    expect(selfExplicit.gateHash).toBe(recordedHash);
    expect(selfExplicit.decision.kind).toBe("allow");
  });

  it("EXPLOIT(approveExact): a quote (default false) does NOT authorize an execute with approveExact=true → block(no_quote)", async () => {
    const recordedHash = await recordedSwapHash({ amountIn: "1" });

    const tampered = await gateHashAndDecision({ ...EVM_PARAMS, approveExact: true }, recordedHash);
    expect(tampered.gateHash).not.toBe(recordedHash);
    expect(tampered.decision.kind).toBe("block");
    if (tampered.decision.kind === "block") expect(tampered.decision.reason).toBe("no_quote");

    // approveExact omitted (or explicitly false) → matches the default → allow.
    const omitted = await gateHashAndDecision({ ...EVM_PARAMS }, recordedHash);
    expect(omitted.decision.kind).toBe("allow");
    const explicitFalse = await gateHashAndDecision({ ...EVM_PARAMS, approveExact: false }, recordedHash);
    expect(explicitFalse.decision.kind).toBe("allow");
  });

  it("EXPLOIT(slippage): a 50bps quote does NOT authorize a 10000bps execute → block(no_quote); same slippage → allow", async () => {
    // Quote pins slippageBps=50.
    const recordedHash = await recordedSwapHash({ amountIn: "1", slippageBps: 50 });

    // Execute jacks slippage to 10000bps (100%) → hash diverges → block.
    const tampered = await gateHashAndDecision({ ...EVM_PARAMS, slippageBps: 10000 }, recordedHash);
    expect(tampered.gateHash).not.toBe(recordedHash);
    expect(tampered.decision.kind).toBe("block");
    if (tampered.decision.kind === "block") expect(tampered.decision.reason).toBe("no_quote");

    // Execute with the SAME slippage collides → allow.
    const matching = await gateHashAndDecision({ ...EVM_PARAMS, slippageBps: 50 }, recordedHash);
    expect(matching.gateHash).toBe(recordedHash);
    expect(matching.decision.kind).toBe("allow");
  });

  it("EXPLOIT(slippage omitted): quote-omitted and execute-omitted slippage collide; a value diverges from omitted", async () => {
    // Both quote and execute omit slippage → sentinel "" on both sides → allow.
    const recordedHash = await recordedSwapHash({ amountIn: "1" });
    const bothOmit = await gateHashAndDecision({ ...EVM_PARAMS }, recordedHash);
    expect(bothOmit.gateHash).toBe(recordedHash);
    expect(bothOmit.decision.kind).toBe("allow");

    // Execute that ADDS a slippage to an omitted quote diverges → block.
    const added = await gateHashAndDecision({ ...EVM_PARAMS, slippageBps: 50 }, recordedHash);
    expect(added.gateHash).not.toBe(recordedHash);
    expect(added.decision.kind).toBe("block");
  });

  // ── Etap 1: kyberswap quote→BUY slippage alignment (end-to-end) ─────────
  //
  // The production bug: kyberswap.swap.quote could not carry slippageBps, so a
  // recorded quote hashed slippage="" while kyberswap.swap.buy carrying
  // slippageBps:50 hashed "50" → permanent no_quote loop. These drive the REAL
  // recorder from a kyberswap.swap.quote AND the REAL gate for a
  // kyberswap.swap.buy execute (the buy tool the plan names), proving the fixed
  // flow: quote(50) authorizes buy(50); a quote-omitted slippage still
  // (correctly) diverges from a buy(50).

  const KYBER_QUOTE_PARAMS = {
    chain: "base",
    tokenIn: GATE_TOKEN_IN,
    tokenOut: GATE_TOKEN_OUT,
    amountIn: "1",
  };

  async function recordKyberQuote(quoteParams: Record<string, unknown>): Promise<string> {
    resetMocks();
    await mod.recordPrequoteFromQuote(
      "kyberswap.swap.quote",
      quoteParams,
      evmResult({ isHoneypot: false, isFOT: false, tax: 0 }, { isHoneypot: false, isFOT: false, tax: 0 }),
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    return (mockCreate.mock.calls[0]![0] as Record<string, unknown>).matchHash as string;
  }

  async function gateBuy(
    executeParams: Record<string, unknown>,
    recordedHash: string,
  ): Promise<Awaited<ReturnType<typeof mod.evaluatePrequoteGate>>> {
    resetMocks();
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockImplementation(async (_s, h) =>
      h === recordedHash ? prequoteRow("pass", { matchHash: h }) : null,
    );
    return mod.evaluatePrequoteGate("kyberswap.swap.buy", executeParams, ctx());
  }

  it("(a) quote WITH slippageBps:50 authorizes a kyberswap.swap.buy WITH slippageBps:50 → allow", async () => {
    const recordedHash = await recordKyberQuote({ ...KYBER_QUOTE_PARAMS, slippageBps: 50 });
    const d = await gateBuy({ ...KYBER_QUOTE_PARAMS, slippageBps: 50 }, recordedHash);
    expect(d.kind).toBe("allow");
  });

  it("(b) quote WITHOUT slippageBps does NOT authorize a kyberswap.swap.buy WITH slippageBps:50 → block(no_quote)", async () => {
    const recordedHash = await recordKyberQuote({ ...KYBER_QUOTE_PARAMS });
    const d = await gateBuy({ ...KYBER_QUOTE_PARAMS, slippageBps: 50 }, recordedHash);
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toBe("no_quote");
  });
});
