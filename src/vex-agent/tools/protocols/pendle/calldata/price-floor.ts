/**
 * Vex's OWN price floor for a Pendle Convert route (G-19 / P0-3).
 *
 * Pendle builds the Router calldata for us and embeds its own minimum-output
 * inside it. Until R5a nothing decoded that number: `decodeRouterCall` read the
 * receiver, the market/YT, the spend and the tuple tokens, and `assertRouteSafe`
 * asserted every one of them — so a response that was correct in EVERY field we
 * checked, carrying `minPtOut = 1`, was signable. The base URL is config-driven
 * (`client.ts` → `loadConfig().services.pendleApiUrl`), so this was never a
 * claim about Pendle's own infrastructure; it was an unbound money parameter.
 *
 * This module re-derives the floor that calldata SHOULD carry, from the SAME
 * route the calldata came from, at the caller's own `slippageBps`, and holds the
 * decoded value to it before anything is signed. It is the Pendle counterpart of
 * `@tools/kyberswap/evm/swap-calldata-guard.ts`'s `price_floor` verdict.
 *
 * All amounts are RAW atomic units carried as bigints / decimal strings — never
 * `number`, never floats. Decimals deliberately do NOT enter the arithmetic: the
 * comparison is raw-to-raw within ONE token (the calldata's min-out against the
 * same route output's amount), so there is no unit to get wrong. Decimals are
 * recorded with the captures in `floor-fixtures.ts`, where they are evidence
 * rather than an input.
 */

import type { Address } from "viem";

import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";
import type { PendleRouterMethod } from "@tools/pendle/constants.js";
import type { PendleConvertRoute, PendleTokenAmount } from "@tools/pendle/types.js";

import { unsafe, type DecodedReflectCall, type DecodedRouterCall } from "./decode.js";

/**
 * Vex's slack when comparing our floor against the provider's embedded one, in
 * RAW OUTPUT UNITS. One unit — the granularity of the floor arithmetic itself —
 * and ABSOLUTE, never a percentage, so it cannot scale with trade size and hide
 * a real loss (rules/90, "Money-Path Discipline").
 *
 * It mirrors `KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW = 1n`
 * (`@tools/kyberswap/swap-price-floor.ts`), where 11 live captures proved the
 * provider's own re-derivation lands exactly one unit below ours.
 *
 * MEASURED FOR PENDLE 2026-07-27, quote-only, 11 chain-1 convert captures across
 * all eight shipped action families plus an aggregator-engaged route: Pendle
 * embeds `floor(output × (10000 − slippageBps) / 10000)` and our independently
 * computed floor matched it to the ATOMIC UNIT — delta 0, not 1 — on ten of
 * eleven. The eleventh, `addLiquiditySingleToken`, errs SAFE: its minLpOut sat
 * 2791205212855374 raw units ABOVE our floor (a ~0.5% haircut against the 1%
 * requested). So the allowance is currently pure margin against rounding drift,
 * not a number any honest route needs — which is exactly how a floor allowance
 * should look. It stays at one unit rather than zero because a provider that
 * rounds the other way on some future market must not be refused by one wei.
 */
export const PENDLE_FLOOR_ALLOWANCE_RAW = 1n;

// ── The per-selector, per-field binding table ────────────────────────

/** Where an economically material minimum-output lives inside the calldata. */
export type PendleMinOutLocation =
  /** A bare `uint256` argument, e.g. `minPtOut` at arg 2. */
  | { readonly kind: "arg"; readonly index: number }
  /** The `minTokenOut` member of the `TokenOutput` tuple at `index`. */
  | { readonly kind: "tokenOutput"; readonly index: number };

/**
 * Which of the route's declared outputs a single min-out field protects.
 *
 * `"all"` for every currently shipped selector — measured, not assumed. Eight of
 * the nine have exactly one output; `mintPyFromToken` has two (PT and YT) under
 * ONE `minPyOut`, and they are EQUAL by protocol. Covering "all" is therefore
 * both correct today and fail-closed on drift: a route that grows an output leg
 * must clear the floor for that leg too, instead of it slipping past an index
 * list. The explicit-index form exists for R5d's dual-output selectors, where
 * each field genuinely protects its own leg.
 */
export type PendleMinOutCoverage =
  | "all"
  | readonly number[]
  /**
   * The single route output whose token equals the one {@link source} names in
   * the calldata — used by a DUAL selector, where each field protects one
   * specific leg.
   */
  | { readonly kind: "outputMatching"; readonly source: PendleMinOutTokenSource }
  /**
   * The single route output whose token is NOT the one {@link source} names.
   * A dual action has exactly two outputs and the calldata names only one of
   * them, so the other field's leg is identified by elimination.
   */
  | { readonly kind: "outputOtherThan"; readonly source: PendleMinOutTokenSource };

/**
 * Where in the calldata to read the token that a dual selector's min-out field
 * protects.
 *
 * WHY THIS EXISTS INSTEAD OF AN INDEX (measured 2026-07-28, R5d probes). The
 * provider's `outputs` array is in ITS OWN canonical order, not the order we
 * requested: asking `remove-liquidity-dual` for `[underlying, PT]` and for
 * `[PT, underlying]` both returned `[PT, underlying]`, and `add-liquidity`
 * keep-YT returned `[LP, YT]` whichever way it was asked. So an index row would
 * encode an undocumented provider convention that we cannot influence and did
 * not verify across markets — and getting it backwards is not a refusal, it is a
 * min-out checked against the WRONG leg's floor (on the dual remove those two
 * amounts differ by ~14x, so a swapped pair would wave through a route paying a
 * fraction of the quote). Resolving by token cannot silently mismatch: if the
 * pairing is not unique, the guard refuses.
 */
export type PendleMinOutTokenSource =
  /** `TokenOutput.tokenOut` from the tuple at `index`. */
  | { readonly kind: "tokenOutputTuple"; readonly index: number }
  /** The `market` argument at `index` — for an LP leg the market IS the LP token. */
  | { readonly kind: "marketArg"; readonly index: number };

export interface PendleMinOutBinding {
  /** The calldata parameter's own name — what a refusal names to the agent. */
  readonly field: string;
  readonly location: PendleMinOutLocation;
  readonly coversOutputs: PendleMinOutCoverage;
}

/**
 * EVERY economically material minimum-output field of EVERY allowed Router
 * selector, as DATA the guard iterates — not prose, and not a switch someone can
 * extend a selector without touching.
 *
 * LIVE-VERIFIED 2026-07-27 (chain 1, wstETH market, 100 bps, quote-only). The
 * `contractCallParamsName` echo the API returns names each field, and decoding
 * the calldata confirmed each position:
 *
 * | selector                    | field         | location                | outputs bound      |
 * |-----------------------------|---------------|-------------------------|--------------------|
 * | swapExactTokenForPt         | minPtOut      | arg 2                   | PT                 |
 * | swapExactTokenForYt         | minYtOut      | arg 2                   | YT                 |
 * | mintPyFromToken             | minPyOut      | arg 2                   | PT **and** YT      |
 * | addLiquiditySingleToken     | minLpOut      | arg 2                   | LP                 |
 * | redeemPyToSy                | minSyOut      | arg 3                   | SY                 |
 * | swapExactPtForToken         | minTokenOut   | arg 3 `.minTokenOut`    | payment token      |
 * | swapExactYtForToken         | minTokenOut   | arg 3 `.minTokenOut`    | payment token      |
 * | redeemPyToToken             | minTokenOut   | arg 3 `.minTokenOut`    | payment token      |
 * | removeLiquiditySingleToken  | minTokenOut   | arg 3 `.minTokenOut`    | payment token      |
 *
 * CORRECTION TO THE PLAN'S PREMISE, measured rather than assumed: `mintPyFromToken`
 * carries ONE `minPyOut`, not a `minPtOut`/`minYtOut` pair. A PY mint produces an
 * EQUAL amount of PT and YT — the live capture returned two outputs with
 * identical amounts — so one number bounds both legs. Binding it against BOTH
 * outputs keeps each leg independently checked and fails closed if a response
 * ever reports a divergent pair, which by protocol it should not.
 */
export const PENDLE_MIN_OUT_BINDINGS: Readonly<
  Record<PendleRouterMethod, readonly PendleMinOutBinding[]>
> = {
  swapExactTokenForPt: [{ field: "minPtOut", location: { kind: "arg", index: 2 }, coversOutputs: "all" }],
  swapExactTokenForYt: [{ field: "minYtOut", location: { kind: "arg", index: 2 }, coversOutputs: "all" }],
  mintPyFromToken: [{ field: "minPyOut", location: { kind: "arg", index: 2 }, coversOutputs: "all" }],
  addLiquiditySingleToken: [{ field: "minLpOut", location: { kind: "arg", index: 2 }, coversOutputs: "all" }],
  redeemPyToSy: [{ field: "minSyOut", location: { kind: "arg", index: 3 }, coversOutputs: "all" }],
  swapExactPtForToken: [{ field: "minTokenOut", location: { kind: "tokenOutput", index: 3 }, coversOutputs: "all" }],
  swapExactYtForToken: [{ field: "minTokenOut", location: { kind: "tokenOutput", index: 3 }, coversOutputs: "all" }],
  redeemPyToToken: [{ field: "minTokenOut", location: { kind: "tokenOutput", index: 3 }, coversOutputs: "all" }],
  removeLiquiditySingleToken: [
    { field: "minTokenOut", location: { kind: "tokenOutput", index: 3 }, coversOutputs: "all" },
  ],

  // ── R5d rows (LIVE-VERIFIED 2026-07-28, chain 1, 100 bps, quote-only) ──
  //
  // | selector                      | field       | location             | outputs bound        |
  // |-------------------------------|-------------|----------------------|----------------------|
  // | mintSyFromToken               | minSyOut    | arg 2                | SY                   |
  // | redeemSyToToken               | minTokenOut | arg 3 `.minTokenOut` | payment token        |
  // | removeLiquidityDualTokenAndPt | minTokenOut | arg 3 `.minTokenOut` | the token leg        |
  // | removeLiquidityDualTokenAndPt | minPtOut    | arg 4                | the PT leg (by elim) |
  // | addLiquiditySingleTokenKeepYt | minLpOut    | arg 2                | the LP leg (= market)|
  // | addLiquiditySingleTokenKeepYt | minYtOut    | arg 3                | the YT leg (by elim) |
  // | removeLiquiditySinglePt       | minPtOut    | arg 3                | PT                   |
  // | swapExactPtForSy              | minSyOut    | arg 3                | SY (intermediate)    |
  // | swapExactSyForPt              | minPtOut    | arg 3                | PT                   |
  // | removeLiquiditySingleSy       | minSyOut    | arg 3                | SY (intermediate)    |
  // | addLiquiditySingleSy          | minLpOut    | arg 3                | LP                   |
  //
  // Six of these sat EXACTLY on `floor(output × (10000 − 100) / 10000)` in the
  // captures (delta 0). The LP-add-shaped ones (keep-YT's two, the transfer's
  // final minLpOut) sat ABOVE our floor — they err SAFE, exactly as
  // `addLiquiditySingleToken` does in the R5a captures.
  mintSyFromToken: [{ field: "minSyOut", location: { kind: "arg", index: 2 }, coversOutputs: "all" }],
  redeemSyToToken: [
    { field: "minTokenOut", location: { kind: "tokenOutput", index: 3 }, coversOutputs: "all" },
  ],
  removeLiquidityDualTokenAndPt: [
    {
      field: "minTokenOut",
      location: { kind: "tokenOutput", index: 3 },
      coversOutputs: { kind: "outputMatching", source: { kind: "tokenOutputTuple", index: 3 } },
    },
    {
      // The PT leg carries no token anywhere in the calldata, so it is the output
      // that is NOT the TokenOutput's token. A dual remove has exactly two.
      field: "minPtOut",
      location: { kind: "arg", index: 4 },
      coversOutputs: { kind: "outputOtherThan", source: { kind: "tokenOutputTuple", index: 3 } },
    },
  ],
  addLiquiditySingleTokenKeepYt: [
    {
      // A Pendle market contract IS its LP token, so arg 1 names the LP leg.
      field: "minLpOut",
      location: { kind: "arg", index: 2 },
      coversOutputs: { kind: "outputMatching", source: { kind: "marketArg", index: 1 } },
    },
    {
      field: "minYtOut",
      location: { kind: "arg", index: 3 },
      coversOutputs: { kind: "outputOtherThan", source: { kind: "marketArg", index: 1 } },
    },
  ],
  // NOTE the index: minPtOut is at arg 3 here, not arg 2. Reading it at 2 would
  // compare the LP amount being burned against the PT output's floor.
  removeLiquiditySinglePt: [
    { field: "minPtOut", location: { kind: "arg", index: 3 }, coversOutputs: "all" },
  ],
  // callAndReflect inner legs. Each has ONE min-out at arg 3. When such a leg is
  // the FINAL one it is floored against `route.outputs` like any single-leg
  // route; when it is intermediate it only has to be non-zero, because the
  // intermediate SY amount appears nowhere in the quote to re-derive a floor from
  // (see {@link assertReflectFloorBound}).
  swapExactPtForSy: [{ field: "minSyOut", location: { kind: "arg", index: 3 }, coversOutputs: "all" }],
  swapExactSyForPt: [{ field: "minPtOut", location: { kind: "arg", index: 3 }, coversOutputs: "all" }],
  removeLiquiditySingleSy: [
    { field: "minSyOut", location: { kind: "arg", index: 3 }, coversOutputs: "all" },
  ],
  addLiquiditySingleSy: [
    { field: "minLpOut", location: { kind: "arg", index: 3 }, coversOutputs: "all" },
  ],
};

// ── Floor arithmetic ────────────────────────────────────────────────

/**
 * `floor(outputRaw * (10000 - slippageBps) / 10000)` in exact bigint math,
 * clamped at 0n because `slippageBps` is bounded to `[0, 10000]`.
 *
 * Delegates to `@tools/kyberswap/swap-price-floor.ts`'s `computeApprovedMinOut`
 * ON PURPOSE. It is the same arithmetic, and a per-venue copy of a money formula
 * is precisely how venues drift apart — the argument `gas-limit-headroom.ts`
 * makes for keeping ONE headroom multiplier. What is venue-specific is the
 * ALLOWANCE, and that lives here as {@link PENDLE_FLOOR_ALLOWANCE_RAW}, exactly
 * as KyberSwap keeps its own. The delegate also re-validates both inputs and
 * THROWS on a bad one rather than silently clamping, which is the behaviour a
 * money floor needs at its last step.
 *
 * Its `RangeError`/`TypeError` is re-raised as a NAMED refusal, because a bare
 * throw from here would be caught by `selectSafeRoute`'s per-route loop and
 * reported as the generic "no route passed the fund-safety checks" — losing the
 * actual cause at exactly the boundary where it matters.
 */
export function computePendleFloorRaw(outputRaw: string, slippageBps: number): bigint {
  try {
    return computeApprovedMinOut(outputRaw, slippageBps);
  } catch (err) {
    return unsafe(
      `price_floor: the route's floor cannot be computed (${err instanceof Error ? err.message : "invalid input"})`,
    );
  }
}

// ── The guard ───────────────────────────────────────────────────────

function readMinOutField(args: readonly unknown[], binding: PendleMinOutBinding): bigint {
  const { location, field } = binding;
  if (location.kind === "arg") {
    const value = args[location.index];
    if (typeof value !== "bigint") return unsafe(`price_floor: ${field} is not present in the calldata`);
    return value;
  }
  const tuple = args[location.index];
  if (typeof tuple !== "object" || tuple === null) {
    return unsafe(`price_floor: ${field} is not present in the calldata`);
  }
  const value = (tuple as Record<string, unknown>).minTokenOut;
  if (typeof value !== "bigint") return unsafe(`price_floor: ${field} is not present in the calldata`);
  return value;
}

/** The token the calldata will actually deliver, when the selector names one. */
function calldataOutputToken(args: readonly unknown[], binding: PendleMinOutBinding): string | null {
  if (binding.location.kind !== "tokenOutput") return null;
  const tuple = args[binding.location.index];
  if (typeof tuple !== "object" || tuple === null) return null;
  const token = (tuple as Record<string, unknown>).tokenOut;
  return typeof token === "string" ? token.toLowerCase() : null;
}

/**
 * The token a dual selector's coverage rule keys on, read from the CALLDATA (not
 * from the quote), lowercased for comparison. Refuses rather than returning null:
 * a coverage rule we cannot evaluate must not silently degrade to "no leg".
 */
function coverageToken(args: readonly unknown[], source: PendleMinOutTokenSource, field: string): string {
  if (source.kind === "marketArg") {
    const market = args[source.index];
    if (typeof market !== "string") return unsafe(`price_floor: ${field} cannot read the market from the calldata`);
    return market.toLowerCase();
  }
  const tuple = args[source.index];
  if (typeof tuple !== "object" || tuple === null) {
    return unsafe(`price_floor: ${field} cannot read the output token from the calldata`);
  }
  const token = (tuple as Record<string, unknown>).tokenOut;
  if (typeof token !== "string") {
    return unsafe(`price_floor: ${field} cannot read the output token from the calldata`);
  }
  return token.toLowerCase();
}

/**
 * Resolve the EXACTLY ONE route output a token-keyed coverage rule selects.
 *
 * Fails closed on any ambiguity — zero matches (the calldata protects a leg the
 * route does not declare) and more than one (two outputs of the same token, so
 * "the other one" is not well defined) are both refusals, never a guess.
 */
function soleOutput(
  outputs: readonly PendleTokenAmount[],
  keep: (token: string) => boolean,
  field: string,
  describe: string,
): readonly PendleTokenAmount[] {
  const matched = outputs.filter((o) => keep(o.token.toLowerCase()));
  if (matched.length !== 1) {
    return unsafe(`price_floor: ${field} does not resolve to exactly one ${describe} the route declares`);
  }
  return matched;
}

function coveredOutputs(
  outputs: readonly PendleTokenAmount[],
  coverage: PendleMinOutCoverage,
  field: string,
  args: readonly unknown[],
): readonly PendleTokenAmount[] {
  if (coverage === "all") return outputs;
  if (Array.isArray(coverage)) {
    return coverage.map((i) => {
      const output = outputs[i];
      if (output === undefined) return unsafe(`price_floor: ${field} covers an output the route does not declare`);
      return output;
    });
  }
  const rule = coverage as Exclude<PendleMinOutCoverage, "all" | readonly number[]>;
  const token = coverageToken(args, rule.source, field);
  return rule.kind === "outputMatching"
    ? soleOutput(outputs, (t) => t === token, field, "output")
    : soleOutput(outputs, (t) => t !== token, field, "counterpart output");
}

/**
 * Bind the route's DECLARED OUTPUT TOPOLOGY to the one the action must deliver,
 * BEFORE any floor arithmetic runs.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE FLOOR. `assertRouteFloorBound` ties a
 * min-out field to a route output by TOKEN only when the selector names one —
 * i.e. through a `TokenOutput` tuple. The bare-`uint256` selectors
 * (`mintSyFromToken`, `removeLiquiditySinglePt`, `swapExactSyForPt`,
 * `addLiquiditySingleSy`, …) name no token anywhere in the calldata, so under
 * `coversOutputs: "all"` the floor is computed from WHATEVER token the response
 * chose to declare. A hostile response that declares one unrelated dust output
 * therefore produces a floor of ~0 that any min-out clears, and the calldata
 * still delivers the real asset at an unbounded price. Four actions ran on those
 * selectors: `sy.mint`, `lp.toPt`, `pt.rollover`, `lp.transfer`.
 *
 * The fix is to make the caller DECLARE what the response is allowed to say. The
 * match is EXACT — same number of outputs, and a one-to-one pairing by token
 * address — so an extra leg, a missing leg, or a substituted token is a refusal
 * rather than a differently-shaped floor. Order is not part of the contract:
 * the provider's `outputs` order is its OWN canonical order (measured
 * 2026-07-28, see {@link PendleMinOutTokenSource}).
 */
export function assertRouteOutputTopology(
  route: PendleConvertRoute,
  expectedOutputTokens: readonly Address[],
): void {
  if (route.outputs.length !== expectedOutputTokens.length) {
    return unsafe("price_floor: the route declares outputs this action does not deliver");
  }
  const remaining = expectedOutputTokens.map((token) => token.toLowerCase());
  for (const output of route.outputs) {
    const at = remaining.indexOf(output.token.toLowerCase());
    if (at === -1) {
      return unsafe("price_floor: the route declares outputs this action does not deliver");
    }
    remaining.splice(at, 1);
  }
}

/**
 * Hold ONE route's calldata to the floor its OWN quoted outputs imply.
 *
 * For every binding row of the decoded selector, and for every route output that
 * row protects, the decoded value plus {@link PENDLE_FLOOR_ALLOWANCE_RAW} must be
 * at least `floor(output × (1 − slippageBps/10000))`. Anything less is refused as
 * `price_floor`, naming the field, before a signature exists.
 *
 * Fails CLOSED on anything it cannot evaluate: an unknown selector, a missing
 * field, a route that declares no outputs at all (there is then no floor to
 * compute, and an unfloorable route must not be signed), or a TokenOutput whose
 * `tokenOut` is not the token the route promises to deliver.
 */
export function assertRouteFloorBound(
  call: DecodedRouterCall,
  route: PendleConvertRoute,
  slippageBps: number,
): void {
  const bindings = PENDLE_MIN_OUT_BINDINGS[call.method];
  if (bindings === undefined || bindings.length === 0) {
    return unsafe(`price_floor: ${call.method} has no minimum-output binding`);
  }
  for (const binding of bindings) {
    const declared = readMinOutField(call.args, binding);
    const outputs = coveredOutputs(route.outputs, binding.coversOutputs, binding.field, call.args);
    if (outputs.length === 0) {
      return unsafe(`price_floor: ${binding.field} cannot be checked — the route declares no output`);
    }
    const calldataToken = calldataOutputToken(call.args, binding);
    for (const output of outputs) {
      if (calldataToken !== null && calldataToken !== output.token.toLowerCase()) {
        return unsafe(`price_floor: ${binding.field} protects a token the route does not deliver`);
      }
      const floor = computePendleFloorRaw(output.amount, slippageBps);
      if (declared + PENDLE_FLOOR_ALLOWANCE_RAW < floor) {
        return unsafe(
          `price_floor: ${binding.field} would accept less than the floor this route's own quote implies at the requested slippage`,
        );
      }
    }
  }
}

// ── callAndReflect: the recursive bind ──────────────────────────────

/**
 * The receiver a reflect leg is allowed to pay out to.
 *
 * DOCUMENTED EXCEPTION, LEG 1 ONLY. A `callAndReflect` action runs its first leg
 * INTO the reflector contract, which then hands the proceeds to the final leg —
 * live-captured 2026-07-27, where leg 1's receiver was the reflector
 * `0x30544e00cf296b34a9ee59e5540ae2f9cccd55dd` and the final leg's was the
 * wallet. Every leg after the first must land on the wallet, so proceeds can
 * never be redirected under cover of the wrapper.
 */
export function reflectLegReceiverIsAllowed(
  legIndex: number,
  legReceiver: Address,
  wallet: Address,
  reflector: Address,
): boolean {
  if (legReceiver === wallet) return true;
  return legIndex === 0 && legReceiver === reflector;
}

/**
 * Hold a `callAndReflect` body to the same floor discipline as a single-leg
 * route, recursively.
 *
 * Every leg must decode to an ALLOWLISTED selector carrying its own binding row
 * (`decodeReflectCall` already refuses an unknown one) and must clear a floor:
 *
 *   - the FINAL leg produces what the user actually receives, so it is bound
 *     against `route.outputs` exactly like a single-leg route. Live-verified:
 *     the captured roll-over's final `minPtOut` equalled our computed floor to
 *     the atomic unit.
 *   - an EARLIER leg produces an INTERMEDIATE asset that never appears in
 *     `route.outputs` (the capture's leg 1 emitted SY at 772301525397762657,
 *     a number the response does not report anywhere). Its floor therefore
 *     cannot be re-derived from the quote, and R5a refuses to invent one: the
 *     leg must simply carry a NON-ZERO minimum, so an intermediate stripped to
 *     zero can never be signed. Pinning a real intermediate floor needs the
 *     inner-leg layouts R5d probes — named here, not silently skipped.
 */
export function assertReflectFloorBound(
  reflect: DecodedReflectCall,
  route: PendleConvertRoute,
  slippageBps: number,
): void {
  const lastIndex = reflect.legs.length - 1;
  reflect.legs.forEach((leg, index) => {
    if (index === lastIndex) {
      assertRouteFloorBound(leg, route, slippageBps);
      return;
    }
    for (const binding of PENDLE_MIN_OUT_BINDINGS[leg.method] ?? []) {
      if (readMinOutField(leg.args, binding) <= 0n) {
        return unsafe(
          `price_floor: intermediate leg ${index + 1} carries no minimum for ${binding.field}`,
        );
      }
    }
  });
}
