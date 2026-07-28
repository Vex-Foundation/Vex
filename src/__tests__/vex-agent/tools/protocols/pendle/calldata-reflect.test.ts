/**
 * Two swap-path hardenings from G-19, both live-capture driven.
 *
 * 1. `TokenInput.pendleSwap` / `TokenOutput.pendleSwap` PINNED on the swap path
 *    (P1-9). `decodeClaimCall` has pinned the claim's `pendleSwap` since the
 *    original binding — and `calldata-claim.test.ts` poisons it with an ATTACKER
 *    address — while every swap, mint and LP method left it unbound. This
 *    mirrors that test on the swap side. LIVE-MEASURED 2026-07-27: seven
 *    aggregator-engaged chain-1 routes (three KyberSwap, four OKX) all carried
 *    `pendleSwap = PENDLE_SWAP_HELPER`, while `swapData.extRouter` varied per
 *    aggregator — so the helper is pinnable and the external router is not.
 *
 * 2. `callAndReflect` decoded RECURSIVELY. The wrapper carries whole Router
 *    calls as `bytes`, so a decoder that stops at the outer selector sees a trade
 *    it cannot read. Each leg is therefore decoded through the SAME
 *    `decodeRouterCall` allowlist, and the reflector-receiver exception is
 *    granted to LEG 1 ONLY.
 *
 * MECHANISM ONLY (R5a). No shipped action maps to `callAndReflect`, and the
 * inner selectors the live `roll-over-pt` capture carries are not in the ABI, so
 * every real reflect body is refused today — asserted below, deliberately. R5d
 * pins those layouts from its own probes.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector, type Hex } from "viem";

import {
  decodeReflectCall,
  decodeRouterCall,
} from "@vex-agent/tools/protocols/pendle/calldata/decode.js";
import {
  assertReflectFloorBound,
  reflectLegReceiverIsAllowed,
} from "@vex-agent/tools/protocols/pendle/calldata/price-floor.js";
import {
  PENDLE_REFLECT_ABI,
  PENDLE_REFLECT_SELECTOR,
  PENDLE_ROUTER_ABI,
  PENDLE_SWAP_HELPER,
} from "@tools/pendle/constants.js";
import type { PendleConvertRoute } from "@tools/pendle/types.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_FLOOR_FIXTURES as F } from "./floor-fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

const ATTACKER = getAddress("0xdEAD000000000000000000000000000000000000");
const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const REFLECTOR = getAddress("0x30544e00cf296b34a9ee59e5540ae2f9cccd55dd");
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

function tamper(data: string, mutate: (args: unknown[]) => void): Hex {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex });
  const args = structuredClone(d.args) as unknown[];
  mutate(args);
  return encodeFunctionData({ abi: PENDLE_ROUTER_ABI, functionName: d.functionName, args: args as never });
}

const setTupleField = (i: number, key: string, value: unknown) => (args: unknown[]) => {
  args[i] = { ...(args[i] as Record<string, unknown>), [key]: value };
};

const route = (key: keyof typeof F) => mutableConvertFixture(F[key]).routes[0]!;

// ── 1. pendleSwap pinned on the swap path ────────────────────────────

describe("pendleSwap is pinned on the SWAP path, not only the claim path", () => {
  it("the live aggregator route really does carry a NON-ZERO pendleSwap", () => {
    // Guards the test itself: a fixture whose pendleSwap were zero would make
    // every poison below pass for the wrong reason.
    const decoded = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: route("buyPtAggregator").tx.data as Hex });
    const input = decoded.args[4] as { pendleSwap: string };
    expect(getAddress(input.pendleSwap)).toBe(PENDLE_SWAP_HELPER);
  });

  it("accepts the pinned helper on an aggregator-engaged buy", () => {
    expect(() => decodeRouterCall(route("buyPtAggregator").tx.data)).not.toThrow();
  });

  it("accepts the ZERO address (a pure-Pendle route engages no helper)", () => {
    expect(() => decodeRouterCall(route("buyPt").tx.data)).not.toThrow();
  });

  // Every method that carries a TokenInput or TokenOutput tuple, and the arg
  // index the tuple sits at.
  const TUPLE_SITES = [
    { key: "buyPtAggregator", arg: 4, leg: "TokenInput (PT buy)" },
    { key: "buyYt", arg: 4, leg: "TokenInput (YT buy)" },
    { key: "mintPy", arg: 3, leg: "TokenInput (PY mint)" },
    { key: "addLiquiditySingle", arg: 4, leg: "TokenInput (LP add)" },
    { key: "sellPt", arg: 3, leg: "TokenOutput (PT sell)" },
    { key: "sellYt", arg: 3, leg: "TokenOutput (YT sell)" },
    { key: "redeemPy", arg: 3, leg: "TokenOutput (PY redeem)" },
    { key: "removeLiquiditySingle", arg: 3, leg: "TokenOutput (LP remove)" },
  ] as const;

  for (const { key, arg, leg } of TUPLE_SITES) {
    it(`REFUSES an ATTACKER pendleSwap on the ${leg}`, () => {
      const poisoned = tamper(route(key).tx.data, setTupleField(arg, "pendleSwap", ATTACKER));
      expectUnsafe(() => decodeRouterCall(poisoned), /pendleSwap/);
    });
  }

  it("refusal happens at DECODE, so no intent binding can wave it through", () => {
    const poisoned = tamper(route("buyPt").tx.data, setTupleField(4, "pendleSwap", ATTACKER));
    expectUnsafe(() => decodeRouterCall(poisoned), /unverified pendleSwap helper/);
  });
});

// ── 2. callAndReflect recursive decode ───────────────────────────────

/** Wrap inner calldata bodies in a `callAndReflect` the way the live capture is shaped. */
function reflectBody(reflector: string, legs: readonly Hex[]): Hex {
  const [first = "0x", second = "0x", third = "0x"] = legs;
  return encodeFunctionData({
    abi: PENDLE_REFLECT_ABI,
    functionName: "callAndReflect",
    args: [getAddress(reflector), first, second, third],
  });
}

/** Leg 1 = a PT sell paying the REFLECTOR; leg 2 = the PT buy paying the wallet. */
function twoLegReflect(overrides: { leg1?: Hex; leg2?: Hex } = {}): Hex {
  const leg1 = overrides.leg1 ?? tamper(route("sellPt").tx.data, (a) => { a[0] = REFLECTOR; });
  const leg2 = overrides.leg2 ?? (route("buyPt").tx.data as Hex);
  return reflectBody(REFLECTOR, [leg1, "0x", leg2]);
}

describe("callAndReflect is decoded recursively", () => {
  it("the pinned selector matches the live capture and the ABI", () => {
    expect(route("rollOverPt").tx.data.slice(0, 10)).toBe(PENDLE_REFLECT_SELECTOR);
    expect(toFunctionSelector("callAndReflect(address,bytes,bytes,bytes)")).toBe(PENDLE_REFLECT_SELECTOR);
  });

  it("the reflect selector is NOT decodable as a single-leg Router call", () => {
    // The reflect ABI is deliberately separate, so the swap path cannot mistake
    // a multi-leg wrapper for a trade it has bound.
    expectUnsafe(() => decodeRouterCall(route("rollOverPt").tx.data), /unknown Router method|does not decode/);
  });

  it("REFUSES the LIVE roll-over capture — its inner selectors are not allowlisted", () => {
    // Fail-closed and on purpose: R5d probes and pins 0x3346d3a3 / 0x2a50917c.
    expectUnsafe(() => decodeReflectCall(route("rollOverPt").tx.data), /does not decode as a known Router method/);
  });

  it("decodes a body whose legs ARE allowlisted, skipping the empty leg", () => {
    const decoded = decodeReflectCall(twoLegReflect());
    expect(decoded.reflector).toBe(REFLECTOR);
    expect(decoded.legs).toHaveLength(2);
    expect(decoded.legs[0]!.method).toBe("swapExactPtForToken");
    expect(decoded.legs[0]!.receiver).toBe(REFLECTOR);
    expect(decoded.legs[1]!.method).toBe("swapExactTokenForPt");
    expect(decoded.legs[1]!.receiver).toBe(WALLET);
  });

  it("REFUSES a body whose inner selector is unknown", () => {
    expectUnsafe(
      () => decodeReflectCall(twoLegReflect({ leg2: "0xdeadbeef00000000000000000000000000000000" as Hex })),
      /does not decode as a known Router method/,
    );
  });

  it("REFUSES a body whose inner leg smuggles the CLAIM selector", () => {
    const claimData = "0x0741a803" + "00".repeat(128);
    expectUnsafe(() => decodeReflectCall(twoLegReflect({ leg2: claimData as Hex })));
  });

  it("REFUSES a body with no decodable leg at all", () => {
    expectUnsafe(() => decodeReflectCall(reflectBody(REFLECTOR, [])), /no decodable leg/);
  });

  it("REFUSES an ATTACKER pendleSwap smuggled inside an inner leg", () => {
    const poisoned = tamper(route("buyPt").tx.data, setTupleField(4, "pendleSwap", ATTACKER));
    expectUnsafe(() => decodeReflectCall(twoLegReflect({ leg2: poisoned })), /pendleSwap/);
  });
});

describe("the reflector-receiver exception is leg 1 ONLY", () => {
  it("leg 1 may pay the reflector", () => {
    expect(reflectLegReceiverIsAllowed(0, REFLECTOR, WALLET, REFLECTOR)).toBe(true);
  });

  it("leg 1 may also pay the wallet directly", () => {
    expect(reflectLegReceiverIsAllowed(0, WALLET, WALLET, REFLECTOR)).toBe(true);
  });

  it("a LATER leg may NOT pay the reflector — proceeds must land on the wallet", () => {
    expect(reflectLegReceiverIsAllowed(1, REFLECTOR, WALLET, REFLECTOR)).toBe(false);
    expect(reflectLegReceiverIsAllowed(2, REFLECTOR, WALLET, REFLECTOR)).toBe(false);
  });

  it("NO leg may pay an attacker, first or last", () => {
    expect(reflectLegReceiverIsAllowed(0, ATTACKER, WALLET, REFLECTOR)).toBe(false);
    expect(reflectLegReceiverIsAllowed(1, ATTACKER, WALLET, REFLECTOR)).toBe(false);
  });
});

describe("every reflect leg is floor-bound", () => {
  /** The route the synthetic body's FINAL leg (a PT buy) settles into. */
  const finalRoute = (): PendleConvertRoute => route("buyPt");

  it("a clean two-leg body passes: final leg floored, intermediate leg non-zero", () => {
    const decoded = decodeReflectCall(twoLegReflect());
    expect(() => assertReflectFloorBound(decoded, finalRoute(), BPS)).not.toThrow();
  });

  it("REFUSES a poisoned min-out on the FINAL leg", () => {
    const poisonedFinal = tamper(route("buyPt").tx.data, (a) => { a[2] = 1n; });
    const decoded = decodeReflectCall(twoLegReflect({ leg2: poisonedFinal }));
    expectUnsafe(() => assertReflectFloorBound(decoded, finalRoute(), BPS), /price_floor.*minPtOut/);
  });

  it("REFUSES an INTERMEDIATE leg stripped to a zero minimum", () => {
    const strippedLeg1 = tamper(route("sellPt").tx.data, (a) => {
      a[0] = REFLECTOR;
      a[3] = { ...(a[3] as Record<string, unknown>), minTokenOut: 0n };
    });
    const decoded = decodeReflectCall(twoLegReflect({ leg1: strippedLeg1 }));
    expectUnsafe(() => assertReflectFloorBound(decoded, finalRoute(), BPS), /intermediate leg 1/);
  });
});
