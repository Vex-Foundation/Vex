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
export type PendleMinOutCoverage = "all" | readonly number[];

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

function coveredOutputs(
  outputs: readonly PendleTokenAmount[],
  coverage: PendleMinOutCoverage,
  field: string,
): readonly PendleTokenAmount[] {
  if (coverage === "all") return outputs;
  return coverage.map((i) => {
    const output = outputs[i];
    if (output === undefined) return unsafe(`price_floor: ${field} covers an output the route does not declare`);
    return output;
  });
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
    const outputs = coveredOutputs(route.outputs, binding.coversOutputs, binding.field);
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
