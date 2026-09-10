/**
 * The spendability line on the approval card, end to end.
 *
 * WHAT THIS BINDS. The model-visible description of every swap execute promises
 * the human "a QUOTE-TIME spendability line - the source-token requirement and
 * the total native debit including every fee leg and the reserve". Until now
 * nothing held that SENTENCE against the string the card actually renders: the
 * existing card test drives a preview with no sealed debit plan, so the leg
 * set, the per-gas ceiling, the reserve and the pricing-basis caveat - the four
 * facts `renderSpendability` promises when a plan IS present - were rendered by
 * code no test read the output of.
 *
 * So these experiments drive the REAL chain a person's card comes down:
 * `safety_detail` as it comes back out of JSONB -> the gate's own restorer
 * (`spendabilityFromSafetyDetail`) -> the REAL approval gate
 * (`evaluateApprovalGate`) -> the REAL card builder
 * (`buildApprovalIntentPreview`), and assert on the rendered line. Nothing is
 * faked: every one of those is the production function, and the manifest is the
 * production manifest.
 */

import { describe, it, expect } from "vitest";
import { formatUnits } from "viem";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { sealUniswapSnapshot, restoreUniswapSnapshot } from "@vex-agent/tools/protocols/quote-authority/uniswap.js";
import { readQuoteBindingPreview, type QuoteBindingPreview } from "@vex-agent/tools/protocols/quote-authority/restore.js";

import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { evaluateApprovalGate } from "@vex-agent/tools/protocols/runtime/gates.js";
import { buildApprovalIntentPreview } from "@vex-agent/engine/core/approval-runtime/enqueue.js";
import { spendabilityFromSafetyDetail } from "@vex-agent/tools/protocols/prequote/gate/safety-detail.js";
import { SPENDABILITY_CARD_VERSION } from "@vex-agent/tools/protocols/quote-authority/spendability-contract.js";
import {
  buildBoundDebitPlan,
  boundDebitPlanSchema,
  type BoundDebitPlan,
} from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";

const TOOL_ID = "kyberswap.swap.execute";
const TOKEN_IN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_OUT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PARAMS = { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" };
const OBSERVED_AT = "2026-08-31T12:00:00.000Z";
const WALLET = "0xwallet";

/** The maximum length `coerceSummaryValue` would cut an allow-listed arg to. */
const MAX_PREVIEW_STRING_LEN = 200;

/** The one per-gas ceiling every leg of the fixture plan is signed under. */
const FEE_CAP = {
  mode: "eip1559" as const,
  maxFeePerGasWei: 11_210_000n,
  maxPriorityFeePerGasWei: 1_210_000n,
};

/**
 * The plan this quote sealed, built through the REAL builder so the fixture
 * tracks the plan shape rather than restating it - a hand-written leg would
 * keep passing this suite after the shape it is meant to prove had changed.
 *
 * The swap leg is CONSERVATIVELY priced: its calldata cannot be simulated until
 * the allowance leg lands, so its figure comes from the quoter plus headroom.
 * That is the case whose caveat the card must carry.
 */
const SEALED_PLAN = buildBoundDebitPlan({
  legs: [
    { role: "allowance_reset", pricing: "measured" },
    { role: "allowance", pricing: "measured" },
    { role: "swap", pricing: "conservative" },
  ],
  feeCap: FEE_CAP,
});

/** The value as it comes back out of `safety_detail`: JSONB, not a live object. */
function asPersisted(plan: BoundDebitPlan): unknown {
  return JSON.parse(JSON.stringify(plan));
}

/**
 * The persisted spendability block of a row whose quote sealed that plan.
 * Written as plain JSON, because that is how it comes back out of
 * `safety_detail` - the restorer, not this fixture, is what types it.
 */
const SPENDABILITY_PREVIEW = {
  cardVersion: SPENDABILITY_CARD_VERSION,
  source: {
    asset: { chainId: 8453, address: TOKEN_IN, symbol: "AAA" },
    wallet: WALLET,
    blockTag: "pending",
    observedAt: OBSERVED_AT,
    required: { raw: "1000000", human: "1", decimals: 6, symbol: "AAA" },
    current: { raw: "5000000", human: "5", decimals: 6, symbol: "AAA" },
  },
  native: {
    asset: { chainId: 8453, address: "0xeeee", symbol: "ETH" },
    wallet: WALLET,
    blockTag: "pending",
    observedAt: OBSERVED_AT,
    required: { raw: "500000000000000", human: "0.0005", decimals: 18, symbol: "ETH" },
    current: { raw: "1000000000000000000", human: "1", decimals: 18, symbol: "ETH" },
  },
  debitPlan: asPersisted(SEALED_PLAN),
};

/** The whole `safety_detail` block of that row: the preview under its own key. */
const SPENDABILITY_DETAIL = { spendability: SPENDABILITY_PREVIEW };

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "00000000-0000-4000-8000-000000000001",
  };
}

/**
 * Run one `safety_detail` down the whole card path and hand back what the
 * person would read. The gate and the builder are the production ones; only the
 * matched row's detail is supplied, because that is the input under test.
 */
function cardFor(safetyDetail: Record<string, unknown>, quoteBinding?: QuoteBindingPreview, toolId = TOOL_ID): Record<string, unknown> {
  const spendability = spendabilityFromSafetyDetail(safetyDetail);
  const manifest = getProtocolManifest(toolId);
  if (!manifest) throw new Error(`${toolId} manifest missing`);
  const pending = evaluateApprovalGate(
    manifest,
    { toolId },
    PARAMS,
    ctx(),
    "pass",
    undefined,
    undefined,
    undefined,
    undefined,
    quoteBinding,
    spendability,
    undefined,
    undefined,
  );
  if (pending === undefined) throw new Error("expected a pending-approval result");
  return buildApprovalIntentPreview({
    toolName: toolId,
    toolArgs: PARAMS,
    result: pending,
  }).criticalArgs;
}

/** The rendered spendability line, or a failure if the card grew none. */
function spendabilityLine(safetyDetail: Record<string, unknown>): string {
  const value = cardFor(safetyDetail).spendability;
  if (typeof value !== "string") throw new Error("the card carried no spendability line");
  return value;
}

describe("the approval card's spendability line", () => {
  it("states the leg set, the ceiling, the reserve and the pricing-basis caveat", () => {
    const line = spendabilityLine(SPENDABILITY_DETAIL);

    // The four facts the render promises about a sealed plan: WHICH
    // transactions, under WHICH ceiling, WHAT is held back beside them, and
    // which leg's cost was estimated rather than measured.
    expect(line).toContain("will send allowance_reset -> allowance -> swap");
    expect(line).toContain("at most 11210000 wei/gas (tip up to 1210000)");
    expect(line).toContain("plus a reserved zero_value_self_transfer");
    expect(line).toContain("swap gas could not be simulated yet");
    expect(line).toContain("CONSERVATIVELY");
  });

  it("states the source requirement and the native debit the description promises", () => {
    const line = spendabilityLine(SPENDABILITY_DETAIL);

    expect(line).toContain(SPENDABILITY_CARD_VERSION);
    expect(line).toContain("source: required 1 AAA, held 5 AAA");
    expect(line).toContain("native debit incl. fees and reserve: required 0.0005 ETH, held 1 ETH");
    expect(line).toContain(OBSERVED_AT);
    // What the number is NOT: a sign-time guarantee.
    expect(line).toContain("quote-time observation, re-read before signing");
  });

  it("renders what the model-visible description says the card carries", () => {
    // The claim and the render are written in two different files by two
    // different lanes. This is the assertion that keeps them one statement.
    const alias = ACTION_ALIAS_TOOLS.find((tool) => tool.name === "SwapExecute");
    if (alias === undefined) throw new Error("SwapExecute alias missing");
    expect(alias.description).toContain("QUOTE-TIME spendability line");
    expect(alias.description).toContain(
      "the source-token requirement and the total native debit including every fee leg and the reserve",
    );

    const line = spendabilityLine(SPENDABILITY_DETAIL);
    // The source-token requirement.
    expect(line).toContain("source: required 1 AAA");
    // The total native debit, and the fee legs and the reserve it includes.
    expect(line).toContain("native debit incl. fees and reserve: required 0.0005 ETH");
    expect(line).toContain("allowance_reset -> allowance -> swap");
    expect(line).toContain("zero_value_self_transfer");
    // And the description's "not a live balance" promise, in the render's words.
    expect(line).toContain("re-read before signing");
  });

  it("never truncates the leg set: the line is rendered whole, not through the arg cutter", () => {
    // `coerceSummaryValue` cuts an allow-listed ARGUMENT at 200 characters and
    // marks the cut with an ellipsis. The spendability line is longer than that
    // and must NOT travel that path - routing it through would silently drop
    // the tail of the plan, which is where the ceiling and the reserve are.
    const line = spendabilityLine(SPENDABILITY_DETAIL);
    expect(line.length).toBeGreaterThan(MAX_PREVIEW_STRING_LEN);
    expect(line).not.toContain("…");
    // Every leg of the plan reaches the card, including the last one.
    for (const role of ["allowance_reset", "allowance", "swap"]) {
      expect(line).toContain(role);
    }
    expect(line.endsWith("re-read before signing.")).toBe(true);
  });

  it("refuses an over-long plan whole rather than shortening it", () => {
    // Ordinary plans remain bounded at four legs. A fifth duplicate fee is
    // not the explicit Permit2 exception and must make the preview unreadable.
    const overlong = {
      ...SPENDABILITY_PREVIEW,
      debitPlan: asPersisted(
        buildBoundDebitPlan({
          legs: [
            { role: "allowance_reset", pricing: "measured" },
            { role: "allowance", pricing: "measured" },
            { role: "swap", pricing: "measured" },
            { role: "swap_fee", pricing: "measured" },
            { role: "swap_fee", pricing: "measured" },
          ],
          feeCap: FEE_CAP,
        }),
      ),
    };
    expect(cardFor({ spendability: overlong }).spendability).toBeUndefined();
    const parsed = boundDebitPlanSchema.safeParse(overlong.debitPlan);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("over-long plan unexpectedly admitted");
    expect(parsed.error.issues.some(issue => issue.message.includes("debit_plan_leg_limit"))).toBe(true);
  });

  it("renders all five legs only for the complete ordered Permit2 plan", () => {
    const roles = ["allowance_reset", "allowance", "permit2_allowance", "swap", "swap_fee"] as const;
    const debitPlan = buildBoundDebitPlan({ legs: roles.map(role => ({ role, pricing: "conservative" })), feeCap: FEE_CAP });
    const line = spendabilityLine({ spendability: { ...SPENDABILITY_PREVIEW, debitPlan: asPersisted(debitPlan) } });
    expect(line).toContain(`will send ${roles.join(" -> ")}`);
    expect(line.endsWith("re-read before signing.")).toBe(true);
    expect(line).not.toContain("…");
    const six = { ...debitPlan, legs: [...debitPlan.legs, debitPlan.legs[0]] };
    expect(cardFor({ spendability: { ...SPENDABILITY_PREVIEW, debitPlan: six } }).spendability).toBeUndefined();
    const wrongOrder = { ...debitPlan, legs: [...debitPlan.legs].reverse() };
    expect(cardFor({ spendability: { ...SPENDABILITY_PREVIEW, debitPlan: wrongOrder } }).spendability).toBeUndefined();
  });

  it("keeps maximum-width v4 fields and the full Permit2 spend plan visible through the real card path", () => {
    const deployment = getUniswapDeployment(8453);
    if (!deployment?.v4) throw new Error("missing Base v4 deployment");
    const raw = (1n << 127n) - 1n;
    const held = (1n << 256n) - 1n;
    const symbol = "S".repeat(64);
    const human = formatUnits(raw, 36);
    const wallet = `0x${"f".repeat(40)}`;
    const roles = ["allowance_reset", "allowance", "permit2_allowance", "swap", "swap_fee"] as const;
    const debitPlan = buildBoundDebitPlan({ legs: roles.map(role => ({ role, pricing: "conservative" })),
      feeCap: { mode: "eip1559", maxFeePerGasWei: held, maxPriorityFeePerGasWei: held } });
    const key = { currency0: TOKEN_IN, currency1: TOKEN_OUT, fee: 0x800000, tickSpacing: 32767,
      hooks: "0xffffffffffffffffffffffffffffffffffffffff" } as const;
    const snapshot = sealUniswapSnapshot({ v: 2, provider: "uniswap", chainId: 8453,
      tokenIn: { address: TOKEN_IN, isNative: false, symbol, decimals: 36 },
      tokenOut: { address: TOKEN_OUT, isNative: false, symbol, decimals: 36 },
      totalInRaw: raw.toString(), swapAmountRaw: raw.toString(), approvedAmountOutRaw: raw.toString(),
      approvedMinOutRaw: raw.toString(), approvedAmountOutHuman: human, approvedMinOutHuman: human, slippageBps: 0,
      fee: { disposition: "charged", amountRaw: "1", disclosureText: "Vex fee 25 bps, charged only after successful settlement" },
      expiresAt: OBSERVED_AT, debitPlan, v4: { recipient: wallet, route: { poolId: v4PoolId(key), poolKey: key,
        zeroForOne: true, hookPermissions: 0x3fff, dynamicFee: true, observedLpFee: 1000000,
        universalRouter: deployment.v4.universalRouter, universalRouterVersion: "2.1.1", permit2: deployment.v4.permit2 } } });
    const leg = { ...SPENDABILITY_PREVIEW.source, wallet,
      required: { raw: raw.toString(), human, decimals: 36, symbol },
      current: { raw: held.toString(), human: formatUnits(held, 36), decimals: 36, symbol } };
    const binding = readQuoteBindingPreview("9999999999999999", snapshot, snapshot.expiresAt);
    expect(binding).toBeDefined();
    const card = cardFor({ spendability: { ...SPENDABILITY_PREVIEW, source: leg, native: leg, debitPlan } }, binding, "uniswap.swap.execute");
    expect(card.spendability).toContain(roles.join(" -> "));
    expect(card.spendability).toContain(held.toString());
    expect(card.spendability).toContain(formatUnits(held, 36));
    expect(card.spendability).toContain("re-read before signing.");
    for (const fact of [symbol, human, snapshot.digest, v4PoolId(key), key.hooks, "dynamic, currently 1000000",
      "tick spacing 32767", "can change the output after the swap", "quote is not a guarantee", "Permit2",
      deployment.v4.permit2, deployment.v4.universalRouter, "UniversalRouter 2.1.1", "decimals 36",
      "600 seconds", wallet, snapshot.fee.disclosureText, "irreversibly"]) expect(card.quoteBinding).toContain(fact);
    expect(String(card.spendability) + String(card.quoteBinding)).not.toContain("…");
    const invalid = sealUniswapSnapshot({ ...snapshot, debitPlan: { ...debitPlan,
      legs: debitPlan.legs.map(leg => leg.role === "permit2_allowance" ? { ...leg, role: "swap_fee" as const } : leg) } });
    expect(restoreUniswapSnapshot(invalid)).toMatchObject({ ok: false, refusal: { kind: "snapshot_unreadable" } });
  });

  it.each([true, false])("keeps the native settlement policy on the real card (native input=%s)", nativeIn => {
    const deployment = getUniswapDeployment(8453);
    if (!deployment?.v4) throw new Error("missing Base v4 deployment");
    const native = { address: "0x0000000000000000000000000000000000000000", isNative: true, symbol: "ETH", decimals: 18 } as const;
    const token = { address: TOKEN_OUT, isNative: false, symbol: "S".repeat(64), decimals: 36 };
    const raw = ((1n << 127n) - 1n).toString();
    const key = { currency0: native.address, currency1: TOKEN_OUT, fee: 0x800000, tickSpacing: 32767,
      hooks: "0xffffffffffffffffffffffffffffffffffffffff" } as const;
    const snapshot = sealUniswapSnapshot({ v: 2, provider: "uniswap", chainId: 8453,
      tokenIn: nativeIn ? native : token, tokenOut: nativeIn ? token : native,
      totalInRaw: raw, swapAmountRaw: raw, approvedAmountOutRaw: raw, approvedMinOutRaw: raw,
      approvedAmountOutHuman: formatUnits(BigInt(raw), nativeIn ? 36 : 18),
      approvedMinOutHuman: formatUnits(BigInt(raw), nativeIn ? 36 : 18), slippageBps: 0,
      fee: { disposition: "charged", amountRaw: "1", disclosureText: "Vex fee 25 bps, capped by approval" },
      expiresAt: OBSERVED_AT, debitPlan: buildBoundDebitPlan({ feeCap: FEE_CAP,
        legs: [{ role: "swap", pricing: "conservative" }, { role: "swap_fee", pricing: "measured" }] }),
      v4: { recipient: TOKEN_IN, route: { poolId: v4PoolId(key), poolKey: key,
        zeroForOne: nativeIn, hookPermissions: 0x3fff, dynamicFee: true, observedLpFee: 1000000,
        universalRouter: deployment.v4.universalRouter, universalRouterVersion: "2.1.1", permit2: deployment.v4.permit2 } } });
    const binding = readQuoteBindingPreview("9999999999999999", snapshot, snapshot.expiresAt);
    expect(binding).toBeDefined();
    const card = cardFor(SPENDABILITY_DETAIL, binding, "uniswap.swap.execute");
    for (const fact of [v4PoolId(key), key.hooks, deployment.v4.universalRouter, snapshot.approvedMinOutHuman,
      nativeIn ? "Native input can be a labelled lower bound" : "Unproven native output remains unknown",
      nativeIn ? "missing required evidence means no fee" : "Proven ERC-20 input can still incur the disclosed fee"]) {
      expect(card.quoteBinding).toContain(fact);
    }
  });

  it("grows no line at all when the row carries no spendability observation", () => {
    // The absent case: a venue that measures no balances, or a row written
    // before the lane existed. The card must state nothing rather than a
    // fabricated or partial line - and the rest of the card is untouched.
    const criticalArgs = cardFor({});
    expect(criticalArgs.spendability).toBeUndefined();
    expect(criticalArgs.safety).toBe("pass");
  });
});
