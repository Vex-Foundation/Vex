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
 *     are bound into the identity. EXPLOIT GUARD — a quote does NOT authorize an
 *     execute that changes referrer/feeBps/filler: hash misses → block(no_quote).
 *     Matching money/fee params (both omit → defaults, or both explicit, incl.
 *     numeric "0100"≡"100") collide → allow. Per-field canonicalization: referrer
 *     EVM-lowercase, filler case-PRESERVED (opaque provider name), referrerFeeBps
 *     numeric.
 *   - `refundTo` is now DERIVED from the source wallet, never read from params
 *     (refund-destination policy in `@tools/khalani/request.js`). Binding it
 *     from params could not stop the vector it was meant to stop: an attacker
 *     setting the SAME address on quote and execute collides the hashes.
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

describe("buildBridgeIdentity — defaults", () => {
  it("derives families + chain ids and defaults recipient to the dest-family wallet", async () => {
    const id = await mod.buildBridgeIdentity(SESSION_ID, bridgeParams(), ctx());
    expect(id.kind).toBe("bridge");
    expect(id.sourceFamily).toBe("eip155");
    expect(id.destFamily).toBe("solana");
    expect(id.fromChainId).toBe(8453);
    expect(id.toChainId).toBe(20011000000);
    expect(id.sourceWallet).toBe("0xEVMWALLET"); // EVM source wallet
    expect(id.recipient).toBe("SoLDestWa11et"); // defaulted to dest-family wallet
    expect(id.tradeType).toBe("EXACT_INPUT"); // default
  });

  it("an explicit recipient is honored (not defaulted)", async () => {
    const id = await mod.buildBridgeIdentity(
      SESSION_ID,
      bridgeParams({ recipient: "ExplicitRecipient" }),
      ctx(),
    );
    expect(id.recipient).toBe("ExplicitRecipient");
  });

  it("tradeType EXACT_OUTPUT is preserved; anything else defaults to EXACT_INPUT", async () => {
    const out = await mod.buildBridgeIdentity(SESSION_ID, bridgeParams({ tradeType: "EXACT_OUTPUT" }), ctx());
    expect(out.tradeType).toBe("EXACT_OUTPUT");
    const garbage = await mod.buildBridgeIdentity(SESSION_ID, bridgeParams({ tradeType: "WAT" }), ctx());
    expect(garbage.tradeType).toBe("EXACT_INPUT");
  });

  it("throws on a missing required field", async () => {
    await expect(
      mod.buildBridgeIdentity(SESSION_ID, bridgeParams({ amountRaw: "" }), ctx()),
    ).rejects.toBeInstanceOf(VexError);
  });

  it("throws on an unresolved chain", async () => {
    await expect(
      mod.buildBridgeIdentity(SESSION_ID, bridgeParams({ fromChain: "not-a-chain" }), ctx()),
    ).rejects.toBeInstanceOf(VexError);
  });

  it("defaults the money/fee leg (refundTo=sourceWallet, referrer/referrerFeeBps/filler empty)", async () => {
    const id = await mod.buildBridgeIdentity(SESSION_ID, bridgeParams(), ctx());
    // refundTo mirrors prepareQuoteRequest: omitted → the resolved fromAddress,
    // which under a session IS the source wallet.
    expect(id.refundTo).toBe("0xEVMWALLET");
    expect(id.referrer).toBe("");
    expect(id.referrerFeeBps).toBe("");
    expect(id.filler).toBe("");
  });

  it("IGNORES a caller-supplied refundTo — it is always the source wallet", async () => {
    // Binding `refundTo` from PARAMS was the hole this closes: an attacker who
    // set the same address on the QUOTE and the EXECUTE produced two colliding
    // hashes, so the gate passed a redirected refund. The tool/alias surfaces
    // no longer accept the key and both handlers reject it by name; the
    // identity binds the DERIVED value, so even a param that reached here
    // cannot move the hash.
    const id = await mod.buildBridgeIdentity(
      SESSION_ID,
      bridgeParams({ refundTo: "0xRefundElsewhere" }),
      ctx(),
    );
    expect(id.refundTo).toBe("0xEVMWALLET");
  });

  it("honors explicit money/fee params (and canonicalizes referrerFeeBps)", async () => {
    const id = await mod.buildBridgeIdentity(
      SESSION_ID,
      bridgeParams({
        referrer: "0xReferrer",
        referrerFeeBps: "0100", // leading zero → canonical "100"
        filler: "native-filler",
      }),
      ctx(),
    );
    expect(id.referrer).toBe("0xReferrer");
    expect(id.referrerFeeBps).toBe("100");
    expect(id.filler).toBe("native-filler");
  });

  it("throws on an out-of-range / non-integer referrerFeeBps (fail-closed parity with the handler)", async () => {
    await expect(
      mod.buildBridgeIdentity(SESSION_ID, bridgeParams({ referrerFeeBps: "10000" }), ctx()),
    ).rejects.toBeInstanceOf(VexError);
    await expect(
      mod.buildBridgeIdentity(SESSION_ID, bridgeParams({ referrerFeeBps: "1.5" }), ctx()),
    ).rejects.toBeInstanceOf(VexError);
  });
});
