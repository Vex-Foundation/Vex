/**
 * Pendle TERM-MOBILITY family (R5d card E4) — `pendle.pt.rollover`,
 * `pendle.lp.transfer`, `pendle.lp.toPt`.
 *
 * Three contracts are pinned, each against something real rather than against a
 * restatement of the code:
 *
 *   1. ROUTE SAFETY, AS THE HANDLER COMPOSES IT — the LIVE quote-only captures in
 *      `./r5d-fixtures.ts` must pass under the EXACT intents the handlers build:
 *      the two reflect actions through `selectSafeReflectRoute` with
 *      `[sourceMarket, destinationMarket]` in execution order, and `lp.toPt`
 *      through the ORDINARY `selectSafeRoute` with the `lp-to-pt` action. The
 *      deep per-field poisons live in `./bind-reflect.test.ts`; what is pinned
 *      here is that a wrong DESTINATION, a wrong ACTION, or a lowered floor
 *      cannot be composed past the binders.
 *   2. PREQUOTE IDENTITY — the dry-run recorder and the execute gate call the
 *      SAME builder, so identical params + identical resolutions must collide,
 *      and any divergence in the execute-variance surface (chain / either leg /
 *      amount / slippage / action) must produce a different digest → BLOCK.
 *   3. THE MANIFESTS — the context-free agent bar, and the two claims the card
 *      makes about the family's shape: NO `keepYt` param exists anywhere, and
 *      the three tools are deliberately NOT yet registered.
 */

import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import { selectSafeRoute, type PendleTxIntent } from "@vex-agent/tools/protocols/pendle/calldata.js";
import {
  selectSafeReflectRoute,
  type PendleReflectIntent,
} from "@vex-agent/tools/protocols/pendle/calldata/bind-reflect.js";
import { PENDLE_ROUTER_ABI } from "@tools/pendle/constants.js";
import type { PendleConvertResponse } from "@tools/pendle/types.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_R5D_FIXTURES as F } from "./r5d-fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const SOURCE_MARKET = getAddress("0x34280882267ffa6383b363e278b027be083bbe3b");
const DEST_MARKET = getAddress("0xba1cbaece600beec76dabc0a4ead31e0339cbe37");
const SOURCE_PT = getAddress("0xb253eff1104802b97ac7e3ac9fdd73aece295a2c");
const DEST_PT = getAddress("0xa3e7ccf0d0fa014892372c0321731a1ed977068c");
const STRANGER = getAddress("0x1111111111111111111111111111111111111111");
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

const response = (key: keyof typeof F): PendleConvertResponse => mutableConvertFixture(F[key]);

/** Exactly the intent `executePendlePtRollover` builds. */
const rolloverIntent = (over: Partial<PendleReflectIntent> = {}): PendleReflectIntent => ({
  action: "pt-rollover",
  chainId: 1,
  wallet: WALLET,
  inputToken: SOURCE_PT,
  inputAmountWei: ONE,
  slippageBps: BPS,
  expectedLegMarkets: [SOURCE_MARKET, DEST_MARKET],
  expectedRouteOutputs: [DEST_PT],
  ...over,
});

/** Exactly the intent `executePendleLpTransfer` builds. */
const transferIntent = (over: Partial<PendleReflectIntent> = {}): PendleReflectIntent => ({
  action: "lp-transfer",
  chainId: 1,
  wallet: WALLET,
  inputToken: SOURCE_MARKET,
  inputAmountWei: ONE,
  slippageBps: BPS,
  expectedLegMarkets: [SOURCE_MARKET, DEST_MARKET],
  // The destination market IS the LP token it delivers.
  expectedRouteOutputs: [DEST_MARKET],
  ...over,
});

/** Exactly the intent `executePendleLpToPt` builds — a PLAIN single-leg route. */
const lpToPtIntent = (over: Partial<PendleTxIntent> = {}): PendleTxIntent => ({
  action: "lp-to-pt",
  wallet: WALLET,
  slippageBps: BPS,
  inputToken: SOURCE_MARKET,
  inputAmountWei: ONE,
  isNative: false,
  expectedMarket: SOURCE_MARKET,
  // Same-market only: the PT this LP converts into is its OWN market's PT.
  expectedRouteOutputs: [SOURCE_PT],
  ...over,
});

// ── 1. Route safety, as the handlers compose it ──────────────────────

describe("the LIVE term-mobility captures pass the binders the handlers use", () => {
  it("roll-over-pt: the provider's own reflect route is accepted", () => {
    expect(() => selectSafeReflectRoute(rolloverIntent(), response("rollOverPtR5d"))).not.toThrow();
  });

  it("transfer-liquidity: the provider's own reflect route is accepted", () => {
    expect(() => selectSafeReflectRoute(transferIntent(), response("transferLiquidity"))).not.toThrow();
  });

  it("convert-lp-to-pt: the PLAIN single-leg route is accepted by the ordinary binder", () => {
    expect(() => selectSafeRoute(lpToPtIntent(), response("convertLpToPt"))).not.toThrow();
  });
});

describe("a destination other than the one resolved is REFUSED", () => {
  it("a rollover into a market the quote does not carry is refused by leg", () => {
    expectUnsafe(
      () => selectSafeReflectRoute(rolloverIntent({ expectedLegMarkets: [SOURCE_MARKET, STRANGER] }), response("rollOverPtR5d")),
      /reflect leg 2 market does not match/,
    );
  });

  it("a transfer OUT OF the wrong market is refused by leg 1", () => {
    expectUnsafe(
      () => selectSafeReflectRoute(transferIntent({ expectedLegMarkets: [STRANGER, DEST_MARKET] }), response("transferLiquidity")),
      /reflect leg 1 market does not match/,
    );
  });

  it("an lp.toPt on a market the route does not carry is refused", () => {
    expectUnsafe(
      () => selectSafeRoute(lpToPtIntent({ expectedMarket: STRANGER }), response("convertLpToPt")),
      /market does not match the quote/,
    );
  });
});

describe("one action's route can never satisfy another's intent", () => {
  it("an lp-to-pt intent refuses a DUAL remove route (method bind)", () => {
    expectUnsafe(
      () => selectSafeRoute(lpToPtIntent(), response("removeLiquidityDual")),
      /removeLiquidityDualTokenAndPt is not valid for a lp-to-pt/,
    );
  });

  it("an lp-to-pt intent cannot read a reflect body at all (the single-leg decoder refuses it)", () => {
    expectUnsafe(() => selectSafeRoute(lpToPtIntent(), response("transferLiquidity")));
  });

  it("a reflect intent refuses a plain single-leg body", () => {
    expectUnsafe(
      () => selectSafeReflectRoute(transferIntent(), response("convertLpToPt")),
      /does not decode as callAndReflect/,
    );
  });
});

describe("the price floor still binds through the composition", () => {
  it("an lp.toPt minPtOut lowered past the one-raw-unit allowance is refused BY NAME", () => {
    // The capture's minPtOut sits EXACTLY on our computed floor, so −2n is two
    // units below it.
    const poisoned = response("convertLpToPt");
    for (const route of poisoned.routes) {
      const decoded = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: route.tx.data as Hex });
      const args: unknown[] = [...structuredClone(decoded.args)];
      args[3] = (args[3] as bigint) - 2n;
      route.tx.data = encodeFunctionData({
        abi: PENDLE_ROUTER_ABI,
        functionName: decoded.functionName,
        args: args as never,
      });
    }
    expectUnsafe(() => selectSafeRoute(lpToPtIntent(), poisoned), /price_floor: minPtOut/);
  });
});

describe("a hostile response cannot re-point the floor at a token it invented", () => {
  // All three of these actions end on a BARE-uint256 min-out (`minPtOut`,
  // `minLpOut`) that names no token in the calldata. Before the topology bind,
  // the floor was therefore derived from whatever `route.outputs` declared — so
  // one dust output of an unrelated token produced a floor of ~0 that any
  // min-out cleared, while the calldata delivered the real asset unbounded.
  const STRANGER_DUST = [{ token: STRANGER, amount: "1" }];

  it("pt.rollover: an unrelated dust output is REFUSED before any floor is computed", () => {
    const poisoned = response("rollOverPtR5d");
    for (const route of poisoned.routes) route.outputs = [...STRANGER_DUST];
    expectUnsafe(
      () => selectSafeReflectRoute(rolloverIntent(), poisoned),
      /route declares outputs this action does not deliver/,
    );
  });

  it("lp.transfer: an unrelated dust output is REFUSED before any floor is computed", () => {
    const poisoned = response("transferLiquidity");
    for (const route of poisoned.routes) route.outputs = [...STRANGER_DUST];
    expectUnsafe(
      () => selectSafeReflectRoute(transferIntent(), poisoned),
      /route declares outputs this action does not deliver/,
    );
  });

  it("lp.toPt: an unrelated dust output is REFUSED before any floor is computed", () => {
    const poisoned = response("convertLpToPt");
    for (const route of poisoned.routes) route.outputs = [...STRANGER_DUST];
    expectUnsafe(
      () => selectSafeRoute(lpToPtIntent(), poisoned),
      /route declares outputs this action does not deliver/,
    );
  });

  it("a rollover into the SOURCE PT is refused — the declared output must be the DESTINATION", () => {
    const poisoned = response("rollOverPtR5d");
    for (const route of poisoned.routes) route.outputs = [{ token: SOURCE_PT, amount: "969279060056085269" }];
    expectUnsafe(
      () => selectSafeReflectRoute(rolloverIntent(), poisoned),
      /route declares outputs this action does not deliver/,
    );
  });

  it("an EXTRA declared leg is refused too — the match is exact, not a subset", () => {
    const poisoned = response("transferLiquidity");
    for (const route of poisoned.routes) route.outputs = [...route.outputs, ...STRANGER_DUST];
    expectUnsafe(
      () => selectSafeReflectRoute(transferIntent(), poisoned),
      /route declares outputs this action does not deliver/,
    );
  });
});

// ── 2. Prequote identity ─────────────────────────────────────────────

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
}));

const { buildPendleTermMatchInput, PENDLE_TERM_PREQUOTE_PROVIDER } = await import(
  "../../../../../vex-agent/tools/protocols/pendle/handlers/reflect-prequote.js"
);
const { computePrequoteMatchHash } = await import(
  "../../../../../vex-agent/tools/protocols/prequote/identity/hash.js"
);
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { PendleTermAction, PendleTermLegs } from "@vex-agent/tools/protocols/pendle/handlers/reflect-prequote.js";

const CTX = {} as unknown as ProtocolExecutionContext;

const rollLegs = (over: Partial<PendleTermLegs> = {}): PendleTermLegs => ({
  source: SOURCE_PT,
  destination: DEST_PT,
  amount: "1",
  ...over,
});

const hashFor = (
  action: PendleTermAction,
  params: Record<string, unknown> = {},
  legs: Partial<PendleTermLegs> = {},
): string =>
  computePrequoteMatchHash(
    buildPendleTermMatchInput(action, "sess-1", { chain: "ethereum", slippageBps: 50, ...params }, CTX, rollLegs(legs)),
  );

describe("term-mobility prequote identity — dry run ↔ execute agreement", () => {
  it("identical params AND identical resolutions collide (ONE builder, both sides)", () => {
    expect(hashFor("pt_rollover")).toBe(hashFor("pt_rollover"));
    expect(hashFor("lp_transfer")).toBe(hashFor("lp_transfer"));
    expect(hashFor("lp_to_pt")).toBe(hashFor("lp_to_pt"));
  });

  it("the three actions never collide on identical legs — the kind tag rides first", () => {
    const digests = new Set([hashFor("pt_rollover"), hashFor("lp_transfer"), hashFor("lp_to_pt")]);
    expect(digests.size).toBe(3);
  });

  it("a changed DESTINATION diverges — a roll into another maturity is a different authorization", () => {
    expect(hashFor("pt_rollover")).not.toBe(hashFor("pt_rollover", {}, { destination: STRANGER }));
  });

  it("a changed SOURCE, amount or slippage each diverge", () => {
    expect(hashFor("lp_transfer")).not.toBe(hashFor("lp_transfer", {}, { source: STRANGER }));
    expect(hashFor("lp_transfer")).not.toBe(hashFor("lp_transfer", {}, { amount: "1.0001" }));
    expect(hashFor("lp_transfer")).not.toBe(hashFor("lp_transfer", { slippageBps: 100 }));
  });

  it("the direction is bound: a reversed roll hashes differently", () => {
    expect(hashFor("pt_rollover")).not.toBe(
      hashFor("pt_rollover", {}, { source: DEST_PT, destination: SOURCE_PT }),
    );
  });

  it("agrees on a non-Ethereum chain, distinct from Ethereum", () => {
    const arb = hashFor("pt_rollover", { chain: "arbitrum" });
    expect(arb).toBe(hashFor("pt_rollover", { chain: "arbitrum" }));
    expect(arb).not.toBe(hashFor("pt_rollover", { chain: "ethereum" }));
  });

  it("an omitted slippage normalizes to the handler default (50) on both sides", () => {
    expect(hashFor("pt_rollover", { slippageBps: undefined })).toBe(hashFor("pt_rollover", { slippageBps: 50 }));
  });

  it("the venue label is neither 'pendle' nor 'pendle-sy', so no other family's quote can authorize these", () => {
    expect(PENDLE_TERM_PREQUOTE_PROVIDER).toBe("pendle-term");
    const identity = buildPendleTermMatchInput("pt_rollover", "sess-1", { chain: "ethereum", slippageBps: 50 }, CTX, rollLegs());
    expect(identity.provider).toBe("pendle-term");
    expect(computePrequoteMatchHash({ ...identity, provider: "pendle" })).not.toBe(hashFor("pt_rollover"));
    expect(computePrequoteMatchHash({ ...identity, provider: "pendle-sy" })).not.toBe(hashFor("pt_rollover"));
  });

  it("the DB kind equals the action, so a row of one kind cannot be read as another", () => {
    for (const action of ["pt_rollover", "lp_transfer", "lp_to_pt"] as const) {
      const identity = buildPendleTermMatchInput(action, "s", { chain: "ethereum" }, CTX, rollLegs());
      expect(identity.kind).toBe(action);
    }
  });

  it("refuses to build rather than guessing: missing leg, bad chain, malformed address, same address twice", () => {
    const build = (params: Record<string, unknown>, legs: Partial<PendleTermLegs>) =>
      buildPendleTermMatchInput("pt_rollover", "s", { chain: "ethereum", ...params }, CTX, rollLegs(legs));
    expect(() => build({}, { destination: "" })).toThrow();
    expect(() => build({}, { amount: "" })).toThrow();
    expect(() => build({ chain: "dogecoin" }, {})).toThrow();
    expect(() => build({}, { destination: "not-an-address" })).toThrow();
    expect(() => build({}, { destination: SOURCE_PT })).toThrow();
    // A fractional slippage is refused, never truncated into the digest.
    expect(() => build({ slippageBps: 0.5 }, {})).toThrow();
  });
});

// ── 3. The manifests ─────────────────────────────────────────────────

const { PENDLE_REFLECT_TOOLS } = await import(
  "../../../../../vex-agent/tools/protocols/pendle/manifests/reflect.js"
);
const { PENDLE_TOOLS } = await import("../../../../../vex-agent/tools/protocols/pendle/manifest.js");

const TOOL_IDS = ["pendle.pt.rollover", "pendle.lp.transfer", "pendle.lp.toPt"] as const;

const manifestFor = (toolId: string) => {
  const found = PENDLE_REFLECT_TOOLS.find((t) => t.toolId === toolId);
  if (!found) throw new Error(`no manifest for ${toolId}`);
  return found;
};

describe("the term-mobility manifests meet the context-free agent bar", () => {
  it("all three are approval-gated broadcast tools carrying the dryRun param", () => {
    for (const toolId of TOOL_IDS) {
      const m = manifestFor(toolId);
      expect(m.mutating).toBe(true);
      expect(m.actionKind).toBe("user_wallet_broadcast");
      expect(m.namespace).toBe("pendle");
      expect(m.params.map((param) => param.key)).toContain("dryRun");
      expect(m.params.map((param) => param.key)).toContain("slippageBps");
    }
  });

  it("each names its two legs as required params", () => {
    const required = (toolId: string) =>
      manifestFor(toolId).params.filter((param) => param.required).map((param) => param.key);
    expect(required("pendle.pt.rollover")).toEqual(["chain", "fromPt", "toPt", "amountIn"]);
    expect(required("pendle.lp.transfer")).toEqual(["chain", "fromMarket", "toMarket", "amountIn"]);
    expect(required("pendle.lp.toPt")).toEqual(["chain", "market", "amountIn"]);
    // `pt` is the OPTIONAL check, not a destination.
    expect(manifestFor("pendle.lp.toPt").params.map((param) => param.key)).toContain("pt");
  });

  it("each description states the dryRun-then-execute contract and what the tool CANNOT do", () => {
    for (const toolId of TOOL_IDS) {
      const d = manifestFor(toolId).description;
      expect(d).toMatch(/dryRun: true/);
      expect(d).toMatch(/EXACT same params/);
      expect(d).toMatch(/CANNOT/);
      expect(d).toMatch(/Approval-gated/);
      expect(d).toMatch(/human-readable units/);
      expect(d).toMatch(/triplet/);
    }
  });

  it("the cross-maturity tools promise the percent-string APY comparison the roll is judged on", () => {
    for (const toolId of ["pendle.pt.rollover", "pendle.lp.transfer"]) {
      const d = manifestFor(toolId).description;
      expect(d).toMatch(/impliedApyBeforePercent/);
      expect(d).toMatch(/impliedApyAfterPercent/);
      expect(d).toMatch(/PERCENT STRING/);
    }
  });

  it("every description states the maturity rule per leg — matured source allowed, matured destination refused", () => {
    for (const toolId of ["pendle.pt.rollover", "pendle.lp.transfer"]) {
      const d = manifestFor(toolId).description;
      expect(d).toMatch(/MAY BE MATURED/);
      expect(d).toMatch(/MUST BE ACTIVE/);
      expect(d).toMatch(/matured destination is refused by name/);
    }
    // lp.toPt acquires the SAME market's PT, so it is destination-shaped end to end.
    expect(manifestFor("pendle.lp.toPt").description).toMatch(/MUST BE ACTIVE/);
    expect(manifestFor("pendle.lp.toPt").description).toMatch(/pendle\.lp\.remove/);
  });

  it("lp.toPt says it is same-market only and that a foreign PT is refused", () => {
    const d = manifestFor("pendle.lp.toPt").description;
    expect(d).toMatch(/SAME MARKET ONLY/);
    expect(d).toMatch(/refusing by name/);
  });

  it("slippage is documented as whole basis points with the policy maximum", () => {
    for (const toolId of TOOL_IDS) {
      const slippage = manifestFor(toolId).params.find((param) => param.key === "slippageBps");
      expect(slippage?.unit).toBe("bps");
      expect(slippage?.description).toMatch(/0\.50%/);
      expect(slippage?.description).toMatch(/1000 = 10%/);
    }
  });

  it("NO keepYt param exists anywhere in the family — the captures showed no such variant", () => {
    for (const tool of PENDLE_REFLECT_TOOLS) {
      expect(tool.params.map((param) => param.key)).not.toContain("keepYt");
    }
  });
});

// Card E5 registered the family. The assertion below used to be the inverse —
// "none of the three appears in PENDLE_TOOLS yet" — which existed only to keep
// the exact-count manifest lock meaningful while E4's modules sat unwired. The
// full end-to-end wiring contract (handler, passage, facet, matrix row, failure
// product) lives in `r5d-registration.test.ts`; this one stays narrow, proving
// only that the family module itself is the thing composed in.
describe("the family is registered (card E5)", () => {
  it("all three appear in PENDLE_TOOLS", () => {
    const registered = PENDLE_TOOLS.map((t) => t.toolId);
    for (const toolId of TOOL_IDS) expect(registered).toContain(toolId);
  });

  it("the manifest module still exposes exactly the three tools, each once", () => {
    expect(PENDLE_REFLECT_TOOLS.map((t) => t.toolId).sort()).toEqual([...TOOL_IDS].sort());
  });
});
