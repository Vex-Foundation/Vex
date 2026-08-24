/**
 * Pendle SY family (R5d card D3) — `pendle.sy.mint` / `pendle.sy.redeem`.
 *
 * Three contracts are pinned here, each against something real rather than
 * against a restatement of the code:
 *
 *   1. ROUTE SAFETY — the two LIVE quote-only captures in `./r5d-fixtures.ts`
 *      (chain 1, 2026-07-28, HTTP 201) must pass `selectSafeRoute` under the new
 *      `sy-mint` / `sy-redeem` intents, and every poisoned variant — produced by
 *      decoding a real capture and moving ONE field — must be REFUSED. A poison
 *      test can therefore never pass because the surrounding body was wrong.
 *   2. PREQUOTE IDENTITY — the dry-run recorder and the execute gate call the
 *      SAME builder, so identical params must collide and any divergence in the
 *      execute-variance surface (chain / sy / token / amount / slippage /
 *      direction) must produce a different digest → the gate BLOCKS.
 *   3. THE RECOVERY CROSS-REFERENCE — `pendle.sy.redeem` exists because the
 *      `pendle.pt.redeem` Router fallback pays SY. The two must name each other,
 *      and the fallback's note must no longer claim the tool does not exist.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import { selectSafeRoute, type PendleTxIntent } from "@vex-agent/tools/protocols/pendle/calldata.js";
import { PENDLE_ROUTER_ABI } from "@tools/pendle/constants.js";
import type { PendleConvertResponse } from "@tools/pendle/types.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_R5D_FIXTURES as F } from "./r5d-fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const SY = getAddress("0xcbc72d92b2dc8187414f6734718563898740c0bc");
const WSTETH = getAddress("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0");
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const ONE = 1_000_000_000_000_000_000n;
/** The slippage every R5d capture was quoted at. */
const BPS = 100;

function expectUnsafe(fn: () => unknown, match?: RegExp): void {
  try {
    fn();
    throw new Error("expected PENDLE_UNSAFE_TX, but the call succeeded");
  } catch (err) {
    const e = err as { code?: string; message?: string };
    expect(e.code).toBe(ErrorCodes.PENDLE_UNSAFE_TX);
    if (match) expect(e.message).toMatch(match);
  }
}

const mintResponse = (): PendleConvertResponse => mutableConvertFixture(F.mintSy);
const redeemResponse = (): PendleConvertResponse => mutableConvertFixture(F.redeemSy);

const mintIntent = (over: Partial<PendleTxIntent> = {}): PendleTxIntent => ({
  action: "sy-mint",
  wallet: WALLET,
  slippageBps: BPS,
  inputToken: WSTETH,
  inputAmountWei: ONE,
  isNative: false,
  expectedSy: SY,
  expectedRouteOutputs: [SY],
  ...over,
});

const redeemIntent = (over: Partial<PendleTxIntent> = {}): PendleTxIntent => ({
  action: "sy-redeem",
  wallet: WALLET,
  slippageBps: BPS,
  inputToken: SY,
  inputAmountWei: ONE,
  isNative: false,
  expectedSy: SY,
  expectedOutputToken: WSTETH,
  expectedRouteOutputs: [WSTETH],
  ...over,
});

/** Decode a real capture, move ONE field, re-encode. */
function tamper(data: string, mutate: (args: unknown[]) => void): Hex {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex });
  const args: unknown[] = [...structuredClone(d.args)];
  mutate(args);
  return encodeFunctionData({ abi: PENDLE_ROUTER_ABI, functionName: d.functionName, args: args as never });
}

// ── 1. Route safety ──────────────────────────────────────────────────

describe("the LIVE SY captures pass the full fund-safety extractor", () => {
  it("mint-sy: the provider's own route is accepted under a sy-mint intent", () => {
    const response = mintResponse();
    expect(() => selectSafeRoute(mintIntent(), response)).not.toThrow();
  });

  it("redeem-sy: the provider's own route is accepted under a sy-redeem intent", () => {
    const response = redeemResponse();
    expect(() => selectSafeRoute(redeemIntent(), response)).not.toThrow();
  });
});

describe("an SY route that is not the one asked for is REFUSED", () => {
  it("a different SY at arg 1 is refused BY NAME", () => {
    const response = mintResponse();
    expectUnsafe(
      () => selectSafeRoute(mintIntent({ expectedSy: getAddress("0x1111111111111111111111111111111111111111") }), response),
      /SY does not match/,
    );
  });

  it("a mint intent cannot be satisfied by a redeem route (method bind)", () => {
    const response = redeemResponse();
    expectUnsafe(() => selectSafeRoute(mintIntent({ inputToken: SY }), response), /not valid for a sy-mint/);
  });

  it("a redeem intent cannot be satisfied by a mint route (method bind)", () => {
    const response = mintResponse();
    expectUnsafe(
      () => selectSafeRoute(redeemIntent({ inputToken: WSTETH, expectedOutputToken: SY }), response),
      /not valid for a sy-redeem/,
    );
  });

  it("a receiver other than the session wallet is refused", () => {
    const response = mintResponse();
    for (const route of response.routes) {
      route.tx.data = tamper(route.tx.data, (args) => {
        args[0] = "0x1111111111111111111111111111111111111111";
      });
      route.contractParamInfo.contractCallParams[0] = "0x1111111111111111111111111111111111111111";
    }
    expectUnsafe(() => selectSafeRoute(mintIntent(), response), /receiver is not the session wallet/);
  });

  it("an inflated spend inside the calldata is refused", () => {
    const response = mintResponse();
    for (const route of response.routes) {
      route.tx.data = tamper(route.tx.data, (args) => {
        args[3] = { ...(args[3] as Record<string, unknown>), netTokenIn: ONE * 2n };
      });
    }
    expectUnsafe(() => selectSafeRoute(mintIntent(), response), /spend amount does not match/);
  });

  it("an approval for a token other than the input is refused", () => {
    const response = mintResponse();
    response.requiredApprovals = [{ token: USDC, amount: ONE.toString() }];
    expectUnsafe(() => selectSafeRoute(mintIntent(), response), /approval targets a token other than the input/);
  });

  it("a redeem delivering a token other than the quoted one is refused", () => {
    const response = redeemResponse();
    expectUnsafe(() => selectSafeRoute(redeemIntent({ expectedOutputToken: USDC }), response), /output token does not match/);
  });

  it("a min-out lowered past the one-raw-unit allowance is refused as price_floor", () => {
    // minSyOut sits EXACTLY on our computed floor in the capture, so floor − 2n
    // is two units below it.
    const response = mintResponse();
    for (const route of response.routes) {
      const declared = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: route.tx.data as Hex }).args[2] as bigint;
      route.tx.data = tamper(route.tx.data, (args) => {
        args[2] = declared - 2n;
      });
    }
    expectUnsafe(() => selectSafeRoute(mintIntent(), response), /price_floor: minSyOut/);
  });

  it("a redeem min-out lowered past the allowance is refused as price_floor", () => {
    const response = redeemResponse();
    for (const route of response.routes) {
      const tuple = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: route.tx.data as Hex }).args[3] as { minTokenOut: bigint };
      route.tx.data = tamper(route.tx.data, (args) => {
        args[3] = { ...(args[3] as Record<string, unknown>), minTokenOut: tuple.minTokenOut - 2n };
      });
    }
    expectUnsafe(() => selectSafeRoute(redeemIntent(), response), /price_floor: minTokenOut/);
  });
});

describe("a hostile response cannot re-point the floor at a token it invented", () => {
  // `mintSyFromToken`'s minSyOut is a bare uint256 naming NO token, so before the
  // topology bind the floor was computed from whatever `outputs` declared: one
  // dust output of an unrelated token makes the floor ~0 and every min-out clears
  // it, while the calldata still delivers the real SY at an unbounded price.
  it("sy.mint: an unrelated dust output is REFUSED before any floor is computed", () => {
    const response = mintResponse();
    for (const route of response.routes) route.outputs = [{ token: USDC, amount: "1" }];
    expectUnsafe(() => selectSafeRoute(mintIntent(), response), /route declares outputs this action does not deliver/);
  });

  it("sy.redeem: an unrelated dust output is REFUSED before any floor is computed", () => {
    const response = redeemResponse();
    for (const route of response.routes) route.outputs = [{ token: USDC, amount: "1" }];
    expectUnsafe(() => selectSafeRoute(redeemIntent(), response), /route declares outputs this action does not deliver/);
  });

  it("an EXTRA declared output is refused too — the match is exact, not a subset", () => {
    const response = mintResponse();
    for (const route of response.routes) route.outputs = [...route.outputs, { token: USDC, amount: "1" }];
    expectUnsafe(() => selectSafeRoute(mintIntent(), response), /route declares outputs this action does not deliver/);
  });

  it("a route declaring NO output is refused rather than treated as unbounded", () => {
    const response = mintResponse();
    for (const route of response.routes) route.outputs = [];
    expectUnsafe(() => selectSafeRoute(mintIntent(), response), /route declares outputs this action does not deliver/);
  });
});

// ── 2. Prequote identity ─────────────────────────────────────────────

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
}));

const { buildPendleSyIdentity, PENDLE_SY_PREQUOTE_PROVIDER } = await import(
  "../../../../../vex-agent/tools/protocols/prequote/identity/pendle-sy.js"
);
const { computePrequoteMatchHash } = await import(
  "../../../../../vex-agent/tools/protocols/prequote/identity/hash.js"
);
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const CTX = {} as unknown as ProtocolExecutionContext;
// `tokenIn` (mint) and `tokenOut` (redeem) name the SAME plain-token leg for
// opposite directions (W6e); both are set so one fixture drives both builders.
const syParams = (over: Record<string, unknown> = {}) => ({
  chain: "ethereum",
  sy: SY,
  tokenIn: WSTETH,
  tokenOut: WSTETH,
  amountIn: "1",
  slippageBps: 50,
  ...over,
});
const mintHash = (over: Record<string, unknown> = {}): string =>
  computePrequoteMatchHash(buildPendleSyIdentity("sess-1", syParams(over), CTX, "mint"));
const redeemHash = (over: Record<string, unknown> = {}): string =>
  computePrequoteMatchHash(buildPendleSyIdentity("sess-1", syParams(over), CTX, "redeem"));

describe("SY prequote identity — dry run ↔ execute agreement", () => {
  it("identical params collide (the SAME builder runs on both sides)", () => {
    expect(mintHash()).toBe(mintHash());
    expect(redeemHash()).toBe(redeemHash());
  });

  it("mint and redeem never collide — the legs are swapped", () => {
    expect(mintHash()).not.toBe(redeemHash());
  });

  it("agree on a non-Ethereum chain, distinct from Ethereum", () => {
    const arb = mintHash({ chain: "arbitrum" });
    expect(arb).toBe(mintHash({ chain: "arbitrum" }));
    expect(arb).not.toBe(mintHash({ chain: "ethereum" }));
  });

  it("a changed SY / token / amount / slippage each diverge", () => {
    expect(mintHash()).not.toBe(mintHash({ sy: USDC }));
    expect(mintHash()).not.toBe(mintHash({ tokenIn: USDC }));
    expect(mintHash()).not.toBe(mintHash({ amountIn: "1.0001" }));
    expect(mintHash()).not.toBe(mintHash({ slippageBps: VEX_DEFAULT_SLIPPAGE_BPS + 50 }));
  });

  it("an omitted slippage normalizes to the ONE Vex default on both sides", () => {
    expect(mintHash({ slippageBps: undefined })).toBe(mintHash({ slippageBps: VEX_DEFAULT_SLIPPAGE_BPS }));
  });

  it("the venue label is NOT plain 'pendle', so a PT quote can never authorize a wrap", () => {
    expect(PENDLE_SY_PREQUOTE_PROVIDER).toBe("pendle-sy");
    const identity = buildPendleSyIdentity("sess-1", syParams(), CTX, "mint");
    expect(identity.provider).toBe("pendle-sy");
    expect(computePrequoteMatchHash({ ...identity, provider: "pendle" })).not.toBe(mintHash());
  });

  it("refuses to build rather than guessing: missing legs, bad chain, same address twice", () => {
    expect(() => buildPendleSyIdentity("s", syParams({ sy: "" }), CTX, "mint")).toThrow();
    expect(() => buildPendleSyIdentity("s", syParams({ amountIn: "" }), CTX, "mint")).toThrow();
    expect(() => buildPendleSyIdentity("s", syParams({ chain: "dogecoin" }), CTX, "mint")).toThrow();
    expect(() => buildPendleSyIdentity("s", syParams({ tokenIn: SY }), CTX, "mint")).toThrow();
    expect(() => buildPendleSyIdentity("s", syParams({ sy: "not-an-address" }), CTX, "mint")).toThrow();
    // A fractional slippage is refused, never truncated into the digest.
    expect(() => buildPendleSyIdentity("s", syParams({ slippageBps: 0.5 }), CTX, "mint")).toThrow();
  });
});

// ── 3. The manifests + the recovery cross-reference ──────────────────

const { PENDLE_SY_TOOLS } = await import(
  "../../../../../vex-agent/tools/protocols/pendle/manifests/sy.js"
);

const manifestFor = (toolId: string) => {
  const found = PENDLE_SY_TOOLS.find((t) => t.toolId === toolId);
  if (!found) throw new Error(`no manifest for ${toolId}`);
  return found;
};

describe("the SY manifests meet the context-free agent bar", () => {
  it("both tools are approval-gated broadcast tools with the rank-8 param set", () => {
    for (const toolId of ["pendle.sy.mint", "pendle.sy.redeem"]) {
      const m = manifestFor(toolId);
      expect(m.mutating).toBe(true);
      expect(m.actionKind).toBe("user_wallet_broadcast");
      const tokenLeg = toolId === "pendle.sy.mint" ? "tokenIn" : "tokenOut";
      expect(m.params.map((param) => param.key)).toEqual(["chain", "sy", tokenLeg, "amountIn", "slippageBps", "dryRun"]);
      expect(m.params.filter((param) => param.required).map((param) => param.key)).toEqual([
        "chain",
        "sy",
        tokenLeg,
        "amountIn",
      ]);
    }
  });

  it("each description states the dryRun-then-execute contract and what the tool CANNOT do", () => {
    for (const toolId of ["pendle.sy.mint", "pendle.sy.redeem"]) {
      const d = manifestFor(toolId).description;
      expect(d).toMatch(/dryRun: true/);
      expect(d).toMatch(/EXACT same params/);
      expect(d).toMatch(/CANNOT/);
      expect(d).toMatch(/Approval-gated/);
      expect(d).toMatch(/human-readable units/);
    }
  });

  it("slippage is documented as whole basis points with the policy maximum", () => {
    const slippage = manifestFor("pendle.sy.mint").params.find((param) => param.key === "slippageBps");
    expect(slippage?.unit).toBe("bps");
    expect(slippage?.description).toMatch(new RegExp(`default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%`));
    expect(slippage?.description).toMatch(/1000 = 10%/);
  });

  it("sy.redeem names the pt.redeem fallback it recovers", () => {
    const d = manifestFor("pendle.sy.redeem").description;
    expect(d).toMatch(/pendle__pt_redeem/);
    expect(d).toMatch(/deliveredAsset/);
  });
});

describe("the pt.redeem fallback note now names sy.redeem as REAL", () => {
  const read = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  it("the handler's fallback note points at pendle.sy.redeem and no longer says it does not exist", () => {
    const source = read("../../../../../vex-agent/tools/protocols/pendle/handlers/pt/redeem.ts");
    expect(source).toMatch(/pendle__sy_redeem/);
    expect(source).not.toMatch(/pendle\.sy\.redeem, which does not exist yet/);
  });

  it("the manifest's redeem description no longer claims Vex cannot unwrap SY", () => {
    const source = read("../../../../../vex-agent/tools/protocols/pendle/manifests/pt.ts");
    expect(source).not.toMatch(/no tool to unwrap SY yet/);
    expect(source).toMatch(/pendle__sy_redeem/);
  });
});
