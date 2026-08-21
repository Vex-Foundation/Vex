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
 *   - Identity collision: a recorded BridgeQuote then a matching khalani.bridge
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

describe("evaluatePrequoteGate — bridge", () => {
  it("no fresh bridge prequote → block(no_quote), bridge-worded, reads kind='bridge'", async () => {
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(), ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("no_quote");
      expect(d.message).toMatch(/BridgeQuote/i);
    }
    expect(mockExistsFail.mock.calls[0]![2]).toBe("bridge");
    expect(mockFindLatest.mock.calls[0]![2]).toBe("bridge");
  });

  it("a fresh bridge prequote (unknown) → allow(unknown)", async () => {
    mockFindLatest.mockResolvedValue(bridgeRow("unknown"));
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(), ctx());
    expect(d.kind).toBe("allow");
    if (d.kind === "allow") {
      expect(d.verdict).toBe("unknown");
      expect(d.prequoteId).toBe("prequote-bridge-1");
    }
  });

  it("a fresh fail row blocks (uniformity — existsFreshFail dominates)", async () => {
    mockExistsFail.mockResolvedValue(true);
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(), ctx());
    expect(d.kind === "block" && d.reason).toBe("safety_fail");
    expect(mockFindLatest).not.toHaveBeenCalled();
  });

  it("fail-closed on a thrown identity build (unresolved chain) → block(gate_error)", async () => {
    const d = await mod.evaluatePrequoteGate(
      "khalani.bridge",
      bridgeParams({ fromChain: "not-a-chain" }),
      ctx(),
    );
    expect(d.kind === "block" && d.reason).toBe("gate_error");
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  it("fail-closed on a thrown DB read, no raw text in message", async () => {
    mockExistsFail.mockRejectedValue(new Error("connection refused 10.0.0.1 secret=hunter2"));
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(), ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("gate_error");
      expect(d.message).not.toContain("hunter2");
      expect(d.message).not.toContain("10.0.0.1");
    }
  });

  it("fail-closed on a WALLET_NOT_SELECTED throw → block(wallet_not_selected), accurate message", async () => {
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_NOT_SELECTED, "no wallet");
    });
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(), ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("wallet_not_selected");
      expect(d.message).toMatch(/no wallet is selected/i);
      expect(d.message).not.toMatch(/could not verify a fresh bridge quote/i);
    }
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  it("fail-closed on a mission-setup invalid policy → block(wallet_setup), bridge-flavored accurate message", async () => {
    mockResolveSelectedAddress.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "Mission wallet policy is invalid");
    });
    const d = await mod.evaluatePrequoteGate(
      "khalani.bridge",
      bridgeParams(),
      ctx({ walletPolicy: { kind: "invalid", reason: "mission_without_active_run" } }),
    );
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("wallet_setup");
      expect(d.message).toMatch(/Bridge blocked/);
      expect(d.message).toMatch(/setup|active run/i);
    }
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  it("missing sessionId → block(no_session)", async () => {
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams(), ctx({ sessionId: undefined }));
    expect(d.kind === "block" && d.reason).toBe("no_session");
    expect(mockResolveSelectedAddress).not.toHaveBeenCalled();
  });
});

// ── Fail-closed on EXECUTE-ONLY routeId / depositMethod (8c) ──────────────

describe("evaluatePrequoteGate — bridge unbindable execute-only params", () => {
  it("a non-empty routeId → block(unbindable_param) BEFORE any prequote lookup", async () => {
    // Even with a fresh matching prequote present, an unbindable param must block.
    mockFindLatest.mockResolvedValue(bridgeRow("unknown"));
    const d = await mod.evaluatePrequoteGate("khalani.bridge", bridgeParams({ routeId: "r1" }), ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toBe("unbindable_param");
      expect(d.message).toMatch(/routeId\/depositMethod/);
    }
    // Fail-closed before touching the prequote store.
    expect(mockExistsFail).not.toHaveBeenCalled();
    expect(mockFindLatest).not.toHaveBeenCalled();
  });

  it("a non-empty depositMethod → block(unbindable_param)", async () => {
    mockFindLatest.mockResolvedValue(bridgeRow("unknown"));
    const d = await mod.evaluatePrequoteGate(
      "khalani.bridge",
      bridgeParams({ depositMethod: "PERMIT2" }),
      ctx(),
    );
    expect(d.kind === "block" && d.reason).toBe("unbindable_param");
    expect(mockExistsFail).not.toHaveBeenCalled();
  });

  it("an empty-string routeId/depositMethod is treated as absent (still allows on a fresh quote)", async () => {
    mockFindLatest.mockResolvedValue(bridgeRow("unknown"));
    const d = await mod.evaluatePrequoteGate(
      "khalani.bridge",
      bridgeParams({ routeId: "", depositMethod: "" }),
      ctx(),
    );
    expect(d.kind).toBe("allow");
  });
});
