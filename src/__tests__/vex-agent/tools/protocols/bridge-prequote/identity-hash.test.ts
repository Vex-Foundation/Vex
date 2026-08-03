/**
 * Bridge prequote — Stage 8c unit tests.
 *
 * Pins (Codex 8c requirements #3/#4 + identical quote↔execute identity):
 *   - Discriminated match-hash: a swap and a bridge with otherwise-similar
 *     values NEVER collide; bridge determinism; per-field sensitivity for every
 *     bridge field (fromChainId/toChainId/fromToken/toToken/amount/recipient/
 *     tradeType/sourceWallet); recipient + tradeType defaults applied identically.
 *   - Bridge recording: a khalani.quote.get success records ONE kind='bridge'
 *     row with verdict='unknown' + the shared bridge identity; malformed →
 *     no row (no throw); wallet-unresolved → skip.
 *   - Bridge gate: no bridge quote → block before approval; fresh bridge
 *     prequote → allow; a thrown identity build / DB read → fail-closed block;
 *     gate reads kind='bridge'.
 *   - Identity collision: a recorded bridge_quote then a matching khalani.bridge
 *     execute → SAME match-hash (allow); a different chain/token/amount/recipient/
 *     tradeType → different hash (block).
 *   - Money/fee binding (8c security fix): refundTo/referrer/referrerFeeBps/filler
 *     are bound into the identity. EXPLOIT GUARD — a quote without refundTo does
 *     NOT authorize an execute that changes refundTo (or referrer/feeBps/filler):
 *     hash misses → block(no_quote). Matching money/fee params (both omit →
 *     defaults, or both explicit, incl. numeric "0100"≡"100") collide → allow.
 *     Per-field canonicalization: refundTo source-family, referrer EVM-lowercase,
 *     filler case-PRESERVED (opaque provider name), referrerFeeBps numeric.
 *   - Unbindable execute-only params: a non-empty routeId/depositMethod on the
 *     bridge EXECUTE → block(unbindable_param) BEFORE any prequote lookup
 *     (fail-closed; protects the direct execute_tool path too).
 *
 * `getCachedKhalaniChains` / `resolveChainId` / `getChainFamily` are mocked so
 * the chain registry is deterministic and offline; the alias for both the QUOTE
 * (khalani.quote.get) and the EXECUTE (khalani.bridge) is identical, proving the
 * shared `buildBridgeIdentity` makes their hashes collide.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { SwapPrequote, SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";

// ── Mocks ─────────────────────────────────────────────────────────────────

type CreateMock = Mock<(input: unknown) => Promise<void>>;
type ResolveMock = Mock<(...args: unknown[]) => string>;
type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;

let mockCreate: CreateMock;
let mockResolveSelectedAddress: ResolveMock;
let mockFindLatest: FindMock;
let mockExistsFail: ExistsMock;

// Deterministic Khalani chain registry. EVM chain 8453 (base) → eip155; chain
// 20011000000 (solana) → solana. resolveChainId maps the known aliases/ids.
const CHAIN_FAMILY: Record<number, "eip155" | "solana"> = {
  1: "eip155",
  8453: "eip155",
  20011000000: "solana",
};
const CHAIN_ALIAS: Record<string, number> = {
  ethereum: 1,
  eth: 1,
  base: 8453,
  "8453": 8453,
  solana: 20011000000,
  sol: 20011000000,
};

function resolveChainIdMock(input: string): number {
  const norm = input.trim().toLowerCase();
  const aliased = CHAIN_ALIAS[norm];
  if (aliased !== undefined) return aliased;
  const numeric = Number(norm);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  throw new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, `Unsupported chain: ${input}`);
}

function getChainFamilyMock(chainId: number): "eip155" | "solana" {
  const fam = CHAIN_FAMILY[chainId];
  if (!fam) throw new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, `Chain ${chainId} unknown.`);
  return fam;
}

function resetMocks() {
  mockCreate = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  // Family-aware wallet stub: EVM wallet vs Solana wallet differ so a
  // source-vs-dest family mistake would be visible in the identity.
  mockResolveSelectedAddress = vi
    .fn<(...args: unknown[]) => string>()
    .mockImplementation((_r: unknown, _p: unknown, family: unknown) =>
      family === "solana" ? "SoLDestWa11et" : "0xEVMWALLET",
    );
  mockFindLatest = vi
    .fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>()
    .mockResolvedValue(null);
  mockExistsFail = vi
    .fn<(s: string, h: string, k: string) => Promise<boolean>>()
    .mockResolvedValue(false);
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

vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () => [],
  resolveChainId: (input: string) => resolveChainIdMock(input),
  getChainFamily: (chainId: number) => getChainFamilyMock(chainId),
}));

const mod = await import("@vex-agent/tools/protocols/swap-prequote.js");

beforeEach(() => {
  resetMocks();
});

// ── Fixtures ────────────────────────────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const EVM_TOKEN = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // source token (EVM)
const SOL_MINT_TOKEN = "DestMintCaseSensitiveABC123"; // dest token (Solana)

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

/** Alias-translated bridge params shared by quote (khalani.quote.get) + execute. */
function bridgeParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fromChain: "base",
    fromToken: EVM_TOKEN,
    toChain: "solana",
    toToken: SOL_MINT_TOKEN,
    amountRaw: "1000000",
    ...overrides,
  };
}

/** A bridge prequote row stub (gate reads only a few fields). */
function bridgeRow(verdict: SafetyVerdict, overrides: Partial<SwapPrequote> = {}): SwapPrequote {
  return {
    prequoteId: "prequote-bridge-1",
    sessionId: SESSION_ID,
    matchHash: "h".repeat(64),
    kind: "bridge",
    family: "eip155",
    provider: "khalani",
    chainId: 8453,
    walletAddress: "0xEVMWALLET",
    tokenIn: EVM_TOKEN,
    tokenOut: SOL_MINT_TOKEN,
    amount: "1000000",
    slippageBps: null,
    safetyVerdict: verdict,
    safetyDetail: { bridge: true, note: "route-only; no token-safety check" },
    routeRef: null,
    createdAt: "2026-06-04T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Discriminated match-hash ─────────────────────────────────────────────

describe("computePrequoteMatchHash — bridge identity", () => {
  const bridgeBase = {
    kind: "bridge" as const,
    sessionId: SESSION_ID,
    provider: "khalani",
    sourceFamily: "eip155" as const,
    destFamily: "solana" as const,
    fromChainId: 8453,
    toChainId: 20011000000,
    sourceWallet: "0xEVMWALLET",
    recipient: "SoLDestWa11et",
    fromToken: EVM_TOKEN,
    toToken: SOL_MINT_TOKEN,
    amount: "1000000",
    tradeType: "EXACT_INPUT" as const,
    // Money/fee leg (8c) — defaulted: refundTo == sourceWallet, the rest "".
    refundTo: "0xEVMWALLET",
    referrer: "",
    referrerFeeBps: "",
    filler: "",
    slippageBps: "",
  };

  it("is deterministic and a full sha256 hex digest", () => {
    const h = mod.computePrequoteMatchHash(bridgeBase);
    expect(h).toBe(mod.computePrequoteMatchHash({ ...bridgeBase }));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a swap and a bridge with otherwise-similar values NEVER collide", () => {
    // Construct a swap identity that reuses overlapping values; the leading kind
    // tag + different field set must yield a different digest.
    const swapHash = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "kyberswap",
      chainId: 8453,
      walletAddress: "0xEVMWALLET",
      tokenIn: EVM_TOKEN,
      tokenOut: SOL_MINT_TOKEN,
      amount: "1000000",
      // Stage 9 swap tail (irrelevant to the cross-kind non-collision, but the
      // SwapMatchInput now requires it).
      recipient: "0xEVMWALLET",
      approveExact: false,
      slippageBps: "",
    });
    expect(mod.computePrequoteMatchHash(bridgeBase)).not.toBe(swapHash);
  });

  it("EVM source leg lowercases; Solana dest leg preserves case", () => {
    const lowerSource = mod.computePrequoteMatchHash({
      ...bridgeBase,
      sourceWallet: "0xEVMWALLET".toUpperCase(),
      fromToken: EVM_TOKEN.toUpperCase(),
    });
    // EVM source fields are case-insensitive → same hash.
    expect(lowerSource).toBe(mod.computePrequoteMatchHash(bridgeBase));
    // Solana dest token IS case-sensitive → different hash.
    const lowerDest = mod.computePrequoteMatchHash({
      ...bridgeBase,
      toToken: SOL_MINT_TOKEN.toLowerCase(),
    });
    expect(lowerDest).not.toBe(mod.computePrequoteMatchHash(bridgeBase));
  });

  it("each bridge field changes the hash", () => {
    const h = mod.computePrequoteMatchHash(bridgeBase);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, fromChainId: 1 })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, toChainId: 1 })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, fromToken: "0xCAFE" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, toToken: "OtherMint" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, amount: "2000000" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, recipient: "OtherRecip" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, tradeType: "EXACT_OUTPUT" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, sourceWallet: "0xOTHER" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, sessionId: "other" })).not.toBe(h);
  });

  it("each money/fee field changes the hash (8c binding)", () => {
    const h = mod.computePrequoteMatchHash(bridgeBase);
    // refundTo differs from the defaulted sourceWallet → distinct identity.
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, refundTo: "0xATTACKER" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, referrer: "0xReFeRrEr" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, referrerFeeBps: "100" })).not.toBe(h);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, filler: "native-filler" })).not.toBe(h);
  });

  it("money/fee canonicalization: refundTo EVM case-insensitive, referrer lowercase, filler case-PRESERVED", () => {
    const h = mod.computePrequoteMatchHash(bridgeBase);
    // refundTo is a SOURCE (EVM) address → case-insensitive.
    expect(
      mod.computePrequoteMatchHash({ ...bridgeBase, refundTo: "0xEVMWALLET".toUpperCase() }),
    ).toBe(h);
    // referrer is an EVM address → lowercased: two casings collide.
    const ref = mod.computePrequoteMatchHash({ ...bridgeBase, referrer: "0xABCDEF0000000000000000000000000000000000" });
    expect(
      mod.computePrequoteMatchHash({ ...bridgeBase, referrer: "0xabcdef0000000000000000000000000000000000" }),
    ).toBe(ref);
    // filler is an OPAQUE provider name → case-SENSITIVE (NOT an address).
    const filler = mod.computePrequoteMatchHash({ ...bridgeBase, filler: "Native-Filler" });
    expect(
      mod.computePrequoteMatchHash({ ...bridgeBase, filler: "native-filler" }),
    ).not.toBe(filler);
  });

  it("the hash treats referrerFeeBps as the ALREADY-canonical string (builder owns canonicalization)", () => {
    // The pure hash does NOT re-canonicalize — `BridgeMatchInput.referrerFeeBps`
    // is the canonical integer string the builder produced. Distinct canonical
    // strings → distinct hashes; "" (omitted) is its own stable token.
    const h100 = mod.computePrequoteMatchHash({ ...bridgeBase, referrerFeeBps: "100" });
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, referrerFeeBps: "200" })).not.toBe(h100);
    expect(mod.computePrequoteMatchHash({ ...bridgeBase, referrerFeeBps: "0" })).not.toBe(
      mod.computePrequoteMatchHash({ ...bridgeBase, referrerFeeBps: "" }),
    );
  });
});
