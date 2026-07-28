/**
 * Pendle PRICE-FLOOR bind (G-19 / P0-3) — the guard that stops an unfloored
 * route reaching a signature.
 *
 * Every case here is driven by a LIVE capture (`floor-fixtures.ts`, 2026-07-27,
 * quote-only). The poisoning method is the repo's existing one: decode the real
 * calldata, mutate the decoded args, re-encode against the complete Router ABI,
 * so the poisoned body is STRUCTURALLY VALID and only the floor bind can catch
 * it.
 *
 * The pinned inequality is `decodedMinOut + PENDLE_FLOOR_ALLOWANCE_RAW >= floor`,
 * so per field:
 *   floor − 1  → ACCEPTED  (the one raw unit of allowance is consumed exactly)
 *   floor − 2  → REFUSED   (`price_floor`, naming the field)
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import {
  PENDLE_FLOOR_ALLOWANCE_RAW,
  PENDLE_MIN_OUT_BINDINGS,
  computePendleFloorRaw,
  assertRouteFloorBound,
} from "@vex-agent/tools/protocols/pendle/calldata/price-floor.js";
import { decodeRouterCall } from "@vex-agent/tools/protocols/pendle/calldata/decode.js";
import { PENDLE_ROUTER_ABI, PENDLE_SELECTORS } from "@tools/pendle/constants.js";
import type { PendleConvertRoute } from "@tools/pendle/types.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_FLOOR_FIXTURES as F, PENDLE_FLOOR_FIXTURE_SLIPPAGE_BPS as SLIP } from "./floor-fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

const BPS = 100; // every capture was quoted at 100 bps

function expectFloorRefusal(fn: () => unknown, field: string): void {
  try {
    fn();
    throw new Error(`expected a price_floor refusal naming ${field}, but the call succeeded`);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    expect(e.code).toBe(ErrorCodes.PENDLE_UNSAFE_TX);
    expect(e.message).toContain("price_floor");
    expect(e.message).toContain(field);
  }
}

/** Decode live calldata, mutate the decoded args, re-encode (still ABI-valid). */
function tamper(data: string, mutate: (args: unknown[]) => void): Hex {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex });
  const args = structuredClone(d.args) as unknown[];
  mutate(args);
  return encodeFunctionData({ abi: PENDLE_ROUTER_ABI, functionName: d.functionName, args: args as never });
}

/** Overwrite a scalar min-out arg. */
const setArg = (i: number, v: bigint) => (args: unknown[]) => { args[i] = v; };
/** Overwrite a TokenOutput tuple's minTokenOut. */
const setTupleMin = (i: number, v: bigint) => (args: unknown[]) => {
  args[i] = { ...(args[i] as Record<string, unknown>), minTokenOut: v };
};

/** One capture reduced to what the floor guard consumes. */
function capture(key: keyof typeof F) {
  const response = mutableConvertFixture(F[key]);
  const route = response.routes[0]!;
  return { response, route, call: decodeRouterCall(route.tx.data) };
}

function withData(route: PendleConvertRoute, data: Hex): PendleConvertRoute {
  return { ...route, tx: { ...route.tx, data } };
}

// Each shipped family, its min-out field, and how to poison that field.
const FAMILIES = [
  { key: "buyPt", field: "minPtOut", poison: (v: bigint) => setArg(2, v) },
  { key: "buyYt", field: "minYtOut", poison: (v: bigint) => setArg(2, v) },
  { key: "mintPy", field: "minPyOut", poison: (v: bigint) => setArg(2, v) },
  { key: "addLiquiditySingle", field: "minLpOut", poison: (v: bigint) => setArg(2, v) },
  { key: "sellPt", field: "minTokenOut", poison: (v: bigint) => setTupleMin(3, v) },
  { key: "sellYt", field: "minTokenOut", poison: (v: bigint) => setTupleMin(3, v) },
  { key: "redeemPy", field: "minTokenOut", poison: (v: bigint) => setTupleMin(3, v) },
  { key: "removeLiquiditySingle", field: "minTokenOut", poison: (v: bigint) => setTupleMin(3, v) },
] as const;

describe("the binding table covers every allowed Router selector", () => {
  it("has a row for all 9 pinned selectors and no others", () => {
    expect(Object.keys(PENDLE_MIN_OUT_BINDINGS).sort()).toEqual(Object.keys(PENDLE_SELECTORS).sort());
  });

  it("gives every selector at least one economically material min-out field", () => {
    for (const [method, rows] of Object.entries(PENDLE_MIN_OUT_BINDINGS)) {
      expect(rows.length, `${method} has no min-out binding`).toBeGreaterThan(0);
    }
  });

  it("is an ABSOLUTE one-raw-unit allowance, never a percentage", () => {
    expect(PENDLE_FLOOR_ALLOWANCE_RAW).toBe(1n);
  });
});

describe("computePendleFloorRaw — bigint, clamped, never a float", () => {
  it("computes floor(out * (10000 - bps) / 10000)", () => {
    expect(computePendleFloorRaw("1279558612922526048", 100)).toBe(1266763026793300787n);
  });

  it("clamps at 0n for a total-tolerance quote instead of going negative", () => {
    expect(computePendleFloorRaw("1000", 10_000)).toBe(0n);
  });

  it("holds exactness far above 2^53 (no float path)", () => {
    const huge = (2n ** 200n).toString();
    expect(computePendleFloorRaw(huge, 100)).toBe((2n ** 200n * 9900n) / 10_000n);
  });

  it("rejects a non-integer or out-of-range tolerance rather than coercing it", () => {
    expect(() => computePendleFloorRaw("1000", 0.5)).toThrow();
    expect(() => computePendleFloorRaw("1000", 10_001)).toThrow();
    expect(() => computePendleFloorRaw("1000", -1)).toThrow();
  });
});

describe("live captures pass the floor bind unmodified", () => {
  for (const { key } of FAMILIES) {
    it(`${key} — the provider's own min-out clears our independently computed floor`, () => {
      const { route, call } = capture(key);
      expect(() => assertRouteFloorBound(call, route, SLIP[key])).not.toThrow();
    });
  }

  it("the aggregator-engaged route is floored too (pendleSwap non-zero)", () => {
    const { route, call } = capture("buyPtAggregator");
    expect(() => assertRouteFloorBound(call, route, SLIP.buyPtAggregator)).not.toThrow();
  });

  it("both routes of a multi-route response are floored, not just the first", () => {
    const response = mutableConvertFixture(F.buyPt);
    expect(response.routes.length).toBeGreaterThan(1);
    for (const route of response.routes) {
      expect(() => assertRouteFloorBound(decodeRouterCall(route.tx.data), route, BPS)).not.toThrow();
    }
  });
});

describe("per-field poison matrix — floor-1 accepted, floor-2 refused", () => {
  for (const { key, field, poison } of FAMILIES) {
    it(`${key}.${field}: exactly floor-1 is ACCEPTED (the allowance is one raw unit)`, () => {
      const { route } = capture(key);
      const floor = computePendleFloorRaw(route.outputs[0]!.amount, BPS);
      const poisoned = withData(route, tamper(route.tx.data, poison(floor - 1n)));
      expect(() => assertRouteFloorBound(decodeRouterCall(poisoned.tx.data), poisoned, BPS)).not.toThrow();
    });

    it(`${key}.${field}: floor-2 is REFUSED as price_floor naming the field`, () => {
      const { route } = capture(key);
      const floor = computePendleFloorRaw(route.outputs[0]!.amount, BPS);
      const poisoned = withData(route, tamper(route.tx.data, poison(floor - 2n)));
      expectFloorRefusal(() => assertRouteFloorBound(decodeRouterCall(poisoned.tx.data), poisoned, BPS), field);
    });

    it(`${key}.${field}: the P0-3 attack (min-out driven to 1) is REFUSED`, () => {
      const { route } = capture(key);
      const poisoned = withData(route, tamper(route.tx.data, poison(1n)));
      expectFloorRefusal(() => assertRouteFloorBound(decodeRouterCall(poisoned.tx.data), poisoned, BPS), field);
    });

    it(`${key}.${field}: a min-out of ZERO is REFUSED`, () => {
      const { route } = capture(key);
      const poisoned = withData(route, tamper(route.tx.data, poison(0n)));
      expectFloorRefusal(() => assertRouteFloorBound(decodeRouterCall(poisoned.tx.data), poisoned, BPS), field);
    });

    it(`${key}.${field}: an ABSURDLY HIGH min-out is accepted — more protection is never a refusal`, () => {
      const { route } = capture(key);
      const poisoned = withData(route, tamper(route.tx.data, poison(2n ** 255n)));
      expect(() => assertRouteFloorBound(decodeRouterCall(poisoned.tx.data), poisoned, BPS)).not.toThrow();
    });
  }
});

describe("PY mint — ONE minPyOut field, but BOTH covered outputs bound independently", () => {
  it("the live capture reports two EQUAL outputs (PT and YT) under one min field", () => {
    const { route } = capture("mintPy");
    expect(route.outputs).toHaveLength(2);
    expect(route.outputs[0]!.amount).toBe(route.outputs[1]!.amount);
    expect(PENDLE_MIN_OUT_BINDINGS.mintPyFromToken).toHaveLength(1);
  });

  it("a raised PT leg (outputs[0]) alone pushes the floor above minPyOut → REFUSED", () => {
    const { route, call } = capture("mintPy");
    const raised: PendleConvertRoute = {
      ...route,
      outputs: [{ ...route.outputs[0]!, amount: (BigInt(route.outputs[0]!.amount) * 2n).toString() }, route.outputs[1]!],
    };
    expectFloorRefusal(() => assertRouteFloorBound(call, raised, BPS), "minPyOut");
  });

  it("a raised YT leg (outputs[1]) alone pushes the floor above minPyOut → REFUSED", () => {
    const { route, call } = capture("mintPy");
    const raised: PendleConvertRoute = {
      ...route,
      outputs: [route.outputs[0]!, { ...route.outputs[1]!, amount: (BigInt(route.outputs[1]!.amount) * 2n).toString() }],
    };
    expectFloorRefusal(() => assertRouteFloorBound(call, raised, BPS), "minPyOut");
  });
});

describe("the provider's own haircut, MEASURED — what the floor is calibrated against", () => {
  // 2026-07-27 sweep, quote-only, chain 1 wstETH market, 25/50/100/200/500 bps
  // x 1e18 and 1e19 in. Recorded so a future provider change to either row is a
  // visible test failure rather than a surprise on a funded broadcast.
  it("a single-leg swap applies EXACTLY the requested haircut (delta 0)", () => {
    // Measured identically at all five tolerances and both sizes: the provider's
    // minPtOut equalled floor(out * (1 - bps/10000)) to the atomic unit. This is
    // why one raw unit of allowance is enough, and why it need not be a
    // percentage.
    const { route } = capture("buyPt");
    const decoded = decodeRouterCall(route.tx.data);
    const declared = decoded.args[2];
    expect(declared).toBe(computePendleFloorRaw(route.outputs[0]!.amount, BPS));
  });

  it("LP add applies ~HALF the requested haircut, i.e. ABOVE our floor", () => {
    // The one action whose min-out is not a clean function of the quoted output:
    // minLpOut also absorbs the on-chain `guessPtReceivedFromSy` search. Measured
    // 12.51 / 25.04 / 50.13 / 100.51 / 253.21 bps for 25 / 50 / 100 / 200 / 500
    // requested. Above our floor is the SAFE direction — the guard passes it.
    const { route } = capture("addLiquiditySingle");
    const decoded = decodeRouterCall(route.tx.data);
    const declared = decoded.args[2] as bigint;
    const floor = computePendleFloorRaw(route.outputs[0]!.amount, BPS);
    expect(declared).toBeGreaterThan(floor);
    expect(declared - floor).toBe(2791205212855374n);
  });

  it("LP add has historically landed BELOW our floor too, and is then REFUSED", () => {
    // A 2026-07-06 capture embedded a ~50.25 bps haircut for a 50 bps request.
    // Refusing is the fail-safe direction: no funds can leak, and the remedy is a
    // higher slippageBps — NEVER a wider allowance, which rules/90 requires to
    // stay absolute so it cannot scale with trade size and hide a real loss.
    const { route } = capture("addLiquiditySingle");
    const decoded = decodeRouterCall(route.tx.data);
    const declared = decoded.args[2] as bigint;
    // Same shape as that older capture: a min-out a whisker under our floor.
    const poisoned = withData(route, tamper(route.tx.data, setArg(2, declared)));
    const tighter = 40; // a tolerance whose floor sits above this route's min-out
    expect(declared).toBeLessThan(computePendleFloorRaw(route.outputs[0]!.amount, tighter));
    expectFloorRefusal(
      () => assertRouteFloorBound(decodeRouterCall(poisoned.tx.data), poisoned, tighter),
      "minLpOut",
    );
  });
});

describe("degenerate routes fail CLOSED", () => {
  it("a route declaring NO outputs cannot be floored, so it is refused", () => {
    const { route, call } = capture("buyPt");
    const empty: PendleConvertRoute = { ...route, outputs: [] };
    expectFloorRefusal(() => assertRouteFloorBound(call, empty, BPS), "minPtOut");
  });

  it("a TokenOutput whose tokenOut is not the token the route promises is refused", () => {
    const { route } = capture("sellPt");
    const swapped: PendleConvertRoute = {
      ...route,
      outputs: [{ ...route.outputs[0]!, token: "0xdead000000000000000000000000000000000000" }],
    };
    expect(() => assertRouteFloorBound(decodeRouterCall(swapped.tx.data), swapped, BPS)).toThrow();
  });

  it("a zero-tolerance quote still binds the FULL quoted output", () => {
    const { route } = capture("buyPt");
    const full = BigInt(route.outputs[0]!.amount);
    const poisoned = withData(route, tamper(route.tx.data, setArg(2, full - 2n)));
    expectFloorRefusal(() => assertRouteFloorBound(decodeRouterCall(poisoned.tx.data), poisoned, 0), "minPtOut");
  });

  it("a 100% tolerance floors at 0n and accepts anything (the caller's own choice)", () => {
    const { route } = capture("buyPt");
    const poisoned = withData(route, tamper(route.tx.data, setArg(2, 0n)));
    expect(() => assertRouteFloorBound(decodeRouterCall(poisoned.tx.data), poisoned, 10_000)).not.toThrow();
  });
});
