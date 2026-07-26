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
    amount: "1000000",
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

describe("bridge quote ↔ execute identity collision", () => {
  it("a recorded bridge_quote and a matching khalani.bridge execute collide (allow)", async () => {
    // 1) Record from the QUOTE params.
    await mod.recordPrequoteFromQuote("khalani.quote.get", bridgeParams(), { quoteId: "q1" }, ctx());
    const recorded = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const recordedHash = recorded.matchHash as string;

    // 2) The gate, given the IDENTICAL execute params, computes the same hash.
    resetMocks();
    let gateHash = "";
    mockFindLatest.mockImplementation(async (_s, h) => {
      gateHash = h;
      return bridgeRow("unknown", { matchHash: h });
    });
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(), ctx());
    expect(d.kind).toBe("allow");
    expect(gateHash).toBe(recordedHash);
  });

  it("a different fromChain/toChain/token/amount/recipient/tradeType MISSES the recorded row", async () => {
    await mod.recordPrequoteFromQuote("khalani.quote.get", bridgeParams(), { quoteId: "q1" }, ctx());
    const recordedHash = (mockCreate.mock.calls[0]![0] as Record<string, unknown>).matchHash as string;

    const variants: Array<Record<string, unknown>> = [
      { toChain: "ethereum", toToken: EVM_TOKEN }, // dest now EVM (different chain + family)
      { fromChain: "ethereum" },
      { fromToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
      { toToken: "DifferentMintXYZ" },
      { amount: "2000000" },
      { recipient: "ADifferentRecipient" },
      { tradeType: "EXACT_OUTPUT" },
    ];
    for (const v of variants) {
      resetMocks();
      let gateHash = "";
      mockFindLatest.mockImplementation(async (_s, h) => {
        gateHash = h;
        return null;
      });
      await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(v), ctx());
      expect(gateHash, `variant ${JSON.stringify(v)} should not collide`).not.toBe(recordedHash);
    }
  });

  it("EXPLOIT GUARD: a caller-variable param cannot be changed between quote and execute", async () => {
    // The hash binds what a caller can LEGITIMATELY vary. Changing such a param
    // between quote and execute must not collide → no matching prequote → block.
    //
    // `refundTo`, `referrer` and `referrerFeeBps` are deliberately NOT tested
    // here any more. They are no longer caller-suppliable at all: each is
    // rejected BY NAME at every entry point and `refundTo` is now DERIVED from
    // the selected source wallet, so the identity binds the derived value and a
    // supplied one cannot move the hash. Binding a param a caller cannot supply
    // would protect nothing; the real guarantee is the rejection, proven in
    // `khalani-refund-destination.test.ts` and
    // `khalani-referrer-fee-rejection.test.ts`. Asserting hash divergence for
    // them here would silently re-test a vector that no longer exists.
    await mod.recordPrequoteFromQuote("khalani.quote.get", bridgeParams(), { quoteId: "q1" }, ctx());
    const recordedHash = (mockCreate.mock.calls[0]![0] as Record<string, unknown>).matchHash as string;

    const tampered: Array<Record<string, unknown>> = [
      { filler: "evil-filler" },
    ];
    for (const v of tampered) {
      resetMocks();
      let gateHash = "";
      mockFindLatest.mockImplementation(async (_s, h) => {
        gateHash = h;
        return null;
      });
      const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(v), ctx());
      expect(gateHash, `tampered ${JSON.stringify(v)} must not collide`).not.toBe(recordedHash);
      expect(d.kind === "block" && d.reason, `tampered ${JSON.stringify(v)} must block`).toBe("no_quote");
    }
  });

  it("identical money/fee params (both omit → defaults) COLLIDE → allow", async () => {
    // Both quote and execute omit the whole money/fee leg → identical defaults →
    // identical hash → allow. (Already implied by the base collision test, but
    // pinned explicitly as the positive counterpart to the exploit guard.)
    await mod.recordPrequoteFromQuote("khalani.quote.get", bridgeParams(), { quoteId: "q1" }, ctx());
    const recordedHash = (mockCreate.mock.calls[0]![0] as Record<string, unknown>).matchHash as string;

    resetMocks();
    let gateHash = "";
    mockFindLatest.mockImplementation(async (_s, h) => {
      gateHash = h;
      return bridgeRow("unknown", { matchHash: h });
    });
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(), ctx());
    expect(d.kind).toBe("allow");
    expect(gateHash).toBe(recordedHash);
  });

  it("identical EXPLICIT money/fee params COLLIDE → allow (quote and execute agree)", async () => {
    const money = {
      refundTo: "0xRefundElsewhere",
      referrer: "0xReferrerAddr",
      referrerFeeBps: "100",
      filler: "native-filler",
    };
    await mod.recordPrequoteFromQuote("khalani.quote.get", bridgeParams(money), { quoteId: "q1" }, ctx());
    const recordedHash = (mockCreate.mock.calls[0]![0] as Record<string, unknown>).matchHash as string;

    resetMocks();
    let gateHash = "";
    mockFindLatest.mockImplementation(async (_s, h) => {
      gateHash = h;
      return bridgeRow("unknown", { matchHash: h });
    });
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(money), ctx());
    expect(d.kind).toBe("allow");
    expect(gateHash).toBe(recordedHash);
  });

  it("referrerFeeBps numeric equivalence end-to-end: quote \"100\" ↔ execute \"0100\" COLLIDE (builder canonicalizes)", async () => {
    // The shared builder canonicalizes "0100" → "100" on BOTH sides, so a fee
    // expressed with a leading zero on execute still matches the quote.
    await mod.recordPrequoteFromQuote(
      "khalani.quote.get",
      bridgeParams({ referrerFeeBps: "100" }),
      { quoteId: "q1" },
      ctx(),
    );
    const recordedHash = (mockCreate.mock.calls[0]![0] as Record<string, unknown>).matchHash as string;

    resetMocks();
    let gateHash = "";
    mockFindLatest.mockImplementation(async (_s, h) => {
      gateHash = h;
      return bridgeRow("unknown", { matchHash: h });
    });
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams({ referrerFeeBps: "0100" }), ctx());
    expect(d.kind).toBe("allow");
    expect(gateHash).toBe(recordedHash);
  });
});
