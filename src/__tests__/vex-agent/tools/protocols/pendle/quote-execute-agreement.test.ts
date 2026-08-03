/**
 * Pendle quote↔execute identity agreement on a NON-Ethereum chain (Arbitrum).
 *
 * The prequote is fail-closed: a buy/sell/redeem executes only when the execute
 * gate's identity hash equals the identity the quote recorded. This proves the
 * RESOLVED chainId (and, for redeem, the slippage) is bound on both sides so a
 * quote on Arbitrum authorizes only the matching Arbitrum execute — and never a
 * different chain or a widened slippage.
 *
 *  - swap  : both sides derive chainId via the SAME `resolvePendleChainId`
 *            (quote echoes it → recorder pins `extracted.chainId`; gate pins it
 *            from the execute `chain`). A different chain → different hash.
 *  - redeem: both sides run the SAME shared `buildPendleRedeemIdentity`, so
 *            quote-shaped and execute-shaped params collide; divergent slippage
 *            or chain → different hash (BLOCK).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

// Redeem identity resolves YT from the PT via market-lookup, and the receiver
// from the wallet resolver — stub both so the builder is deterministic offline.
const mockResolveYtForPt = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveYtForPt: (...a: unknown[]) => mockResolveYtForPt(...a),
}));
// R5b: the exit actions (pt.redeem, lp.remove, claim) resolve through the
// matured-capable lane. Delegates to the SAME market doubles this suite
// already sets up, wrapped in the {market, maturity} envelope.
vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitYtForPt: (...a: unknown[]) => mockResolveYtForPt(...a),
}));
const mockResolveSelectedAddress = vi.fn();
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...a: unknown[]) => mockResolveSelectedAddress(...a),
}));

const { computePrequoteMatchHash } = await import(
  "@vex-agent/tools/protocols/prequote/identity/hash.js"
);
const { buildPendleRedeemIdentity } = await import(
  "@vex-agent/tools/protocols/prequote/identity/pendle-redeem.js"
);
const { resolvePendleChainId } = await import("@tools/pendle/chains.js");

const WALLET = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const PT = "0x1a69154f6f6247e4457332860fb173251a36e03f";
const YT = "0x8a9e90fe18e9d243f804022224fbd8380d6b76f6";

const ctx = { walletResolution: {}, walletPolicy: {} } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveYtForPt.mockResolvedValue(YT);
  mockResolveSelectedAddress.mockReturnValue(WALLET);
});

// ── swap kind ────────────────────────────────────────────────────────
// The recorder pins chainId to the quote's echoed `extracted.chainId`; the gate
// pins it from the execute `chain` via resolvePendleChainId. Both use the SAME
// resolver, so an Arbitrum quote and an Arbitrum execute agree.
function swapIdentity(chain: string): string {
  const chainId = resolvePendleChainId(chain);
  return computePrequoteMatchHash({
    kind: "swap",
    sessionId: "s1",
    family: "eip155",
    provider: "pendle",
    chainId,
    walletAddress: WALLET,
    tokenIn: USDC,
    tokenOut: PT,
    amount: "100",
    recipient: WALLET, // output-to-self default (no recipient param)
    approveExact: false,
    slippageBps: "50",
  });
}

describe("pendle swap quote↔execute agreement (arbitrum)", () => {
  it("an arbitrum quote authorizes an arbitrum execute (alias-equivalent chains agree)", () => {
    expect(swapIdentity("arbitrum")).toBe(swapIdentity("arb"));
    expect(swapIdentity("arbitrum")).toBe(swapIdentity("42161"));
  });

  it("an arbitrum quote NEVER authorizes an ethereum execute (chainId bound)", () => {
    expect(swapIdentity("arbitrum")).not.toBe(swapIdentity("ethereum"));
  });
});

// ── YT swap kind (P3) ─────────────────────────────────────────────────
// A YT trade is ALWAYS a swap: the recorder (pendle.yt.quote) pins chainId to the
// quote's echoed chainId with tokenOut = the YT; the gate (pendle.yt.buy) pins it
// from the execute `chain` via the SAME resolver + provider "pendle". So a YT
// quote authorizes only the matching YT execute on the same chain — and the YT
// leg (a plain address) is chain-scoped, so it never collides across chains.
const YT_SUSDE = "0x45a699a11a4a17fe0931ef3cea4bfc3235e659f2";

function ytSwapIdentity(chain: string): string {
  const chainId = resolvePendleChainId(chain);
  return computePrequoteMatchHash({
    kind: "swap",
    sessionId: "s1",
    family: "eip155",
    provider: "pendle",
    chainId,
    walletAddress: WALLET,
    tokenIn: USDC,
    tokenOut: YT_SUSDE, // buying the YT
    amount: "100",
    recipient: WALLET,
    approveExact: false,
    slippageBps: "50",
  });
}

describe("pendle YT swap quote↔execute agreement (arbitrum)", () => {
  it("an arbitrum YT quote authorizes an arbitrum YT execute (aliases agree)", () => {
    expect(ytSwapIdentity("arbitrum")).toBe(ytSwapIdentity("arb"));
    expect(ytSwapIdentity("arbitrum")).toBe(ytSwapIdentity("42161"));
  });

  it("an arbitrum YT quote NEVER authorizes an ethereum YT execute (chainId bound)", () => {
    expect(ytSwapIdentity("arbitrum")).not.toBe(ytSwapIdentity("ethereum"));
  });

  it("a YT buy identity differs from a PT buy identity for the same payment leg (distinct tokenOut)", () => {
    // The output leg (YT vs PT) is part of the identity, so a YT quote can never
    // authorize a PT execute (different tokenOut → different hash).
    expect(ytSwapIdentity("arbitrum")).not.toBe(swapIdentity("arbitrum"));
  });
});

// ── redeem kind ──────────────────────────────────────────────────────
describe("pendle redeem quote↔execute agreement (arbitrum)", () => {
  it("quote-shaped and execute-shaped params collide on arbitrum", async () => {
    // Quote (pendle.pt.quote) carries the PT as tokenIn + amountIn; execute
    // (pendle.pt.redeem) is identical here — both go through the shared builder.
    const quoteId = await buildPendleRedeemIdentity(
      "s1",
      { chain: "arbitrum", tokenIn: PT, amountIn: "100" },
      ctx,
    );
    const executeId = await buildPendleRedeemIdentity(
      "s1",
      { chain: "arb", tokenIn: PT, amountIn: "100", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
      ctx,
    );
    expect(quoteId.chainId).toBe(42161);
    expect(computePrequoteMatchHash(quoteId)).toBe(computePrequoteMatchHash(executeId));
  });

  it("a different execute chain diverges (arbitrum quote ≠ ethereum execute)", async () => {
    const arb = await buildPendleRedeemIdentity("s1", { chain: "arbitrum", tokenIn: PT, amountIn: "100" }, ctx);
    const eth = await buildPendleRedeemIdentity("s1", { chain: "ethereum", tokenIn: PT, amountIn: "100" }, ctx);
    expect(computePrequoteMatchHash(arb)).not.toBe(computePrequoteMatchHash(eth));
  });

  it("a widened execute slippage BLOCKS (50 bps quote ≠ 5000 bps execute)", async () => {
    const quote = await buildPendleRedeemIdentity("s1", { chain: "arbitrum", tokenIn: PT, amountIn: "100" }, ctx);
    const execute = await buildPendleRedeemIdentity(
      "s1",
      { chain: "arbitrum", tokenIn: PT, amountIn: "100", slippageBps: 5000 },
      ctx,
    );
    expect(computePrequoteMatchHash(quote)).not.toBe(computePrequoteMatchHash(execute));
  });
});
