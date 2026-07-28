/**
 * R5d card D1 — the nine NEW Router selectors, their price-floor binding rows,
 * and the per-chain `callAndReflect` reflector registry.
 *
 * Everything asserted here is driven by the LIVE quote-only captures in
 * `./r5d-fixtures.ts` (chain 1 + chain 143, 2026-07-28, HTTP 201 on all seven).
 * Nothing is synthesized except the deliberately POISONED variants, which are
 * produced by decoding a real capture, moving ONE field, and re-encoding — so a
 * poison test can never pass because the surrounding body was wrong.
 *
 * The floor contract these pin, per FIELD (rules/90, Money-Path Discipline):
 *   `declared + PENDLE_FLOOR_ALLOWANCE_RAW >= floor(output × (1 − bps/10000))`
 * hence `floor − 1n` is ACCEPTED (the one-unit absolute allowance) and
 * `floor − 2n` is REFUSED as `price_floor`, naming the field.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector, type Hex } from "viem";

import { decodeReflectCall, decodeRouterCall } from "@vex-agent/tools/protocols/pendle/calldata/decode.js";
import {
  assertReflectFloorBound,
  assertRouteFloorBound,
  computePendleFloorRaw,
  PENDLE_FLOOR_ALLOWANCE_RAW,
  PENDLE_MIN_OUT_BINDINGS,
} from "@vex-agent/tools/protocols/pendle/calldata/price-floor.js";
import {
  PENDLE_EXCLUDED_ADD_LIQUIDITY_DUAL_SELECTOR,
  PENDLE_REFLECT_SELECTOR,
  PENDLE_REFLECTORS,
  PENDLE_ROUTER,
  PENDLE_ROUTER_ABI,
  PENDLE_SELECTOR_TO_METHOD,
  PENDLE_SELECTORS,
  pendleReflectorFor,
  type PendleRouterMethod,
} from "@tools/pendle/constants.js";
import { PENDLE_SUPPORTED_CHAIN_IDS } from "@tools/pendle/chains.js";
import type { PendleConvertResponse, PendleConvertRoute, PendleTokenAmount } from "@tools/pendle/types.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_FLOOR_FIXTURES as R5A } from "./floor-fixtures.js";
import { PENDLE_R5D_FIXTURES as F, PENDLE_REFLECTOR_PROBES } from "./r5d-fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

const BPS = 100;
const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const CANONICAL_REFLECTOR = getAddress("0x30544e00cf296b34a9ee59e5540ae2f9cccd55dd");
const MONAD_REFLECTOR = getAddress("0x73d5dbf81a4f3bfa7b335e6a2d4638d6017a4fa8");

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
const route = (key: keyof typeof F): PendleConvertRoute => {
  const first = response(key).routes[0];
  if (first === undefined) throw new Error(`fixture ${key} has no route`);
  return first;
};

/**
 * Decode a real capture, move one field, re-encode — the poison generator.
 *
 * The spread (rather than the `as unknown[]` cast the older sibling suites use)
 * keeps this file off the test-type ratchet: a readonly ABI tuple spreads into a
 * mutable array without asserting anything about its element types.
 */
function tamper(data: string, mutate: (args: unknown[]) => void): Hex {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data: data as Hex });
  const args: unknown[] = [...structuredClone(d.args)];
  mutate(args);
  return encodeFunctionData({ abi: PENDLE_ROUTER_ABI, functionName: d.functionName, args: args as never });
}

const setArg = (i: number, value: bigint) => (args: unknown[]) => {
  args[i] = value;
};
const setMinTokenOut = (i: number, value: bigint) => (args: unknown[]) => {
  args[i] = { ...(args[i] as Record<string, unknown>), minTokenOut: value };
};

// ── 1. Selector pinning ──────────────────────────────────────────────

/**
 * Each new method's DERIVED signature, and the selector it must produce. The
 * signature is the real assertion: a wrong struct layout changes the selector,
 * so agreement between keccak(signature), the constant, and the LIVE calldata
 * head is what proves the ABI entry decodes real bodies correctly.
 */
const AP = "(uint256,uint256,uint256,uint256,uint256)";
const SWAP_DATA = "(uint8,address,bytes,bool)";
const TOKEN_IO = `(address,uint256,address,address,${SWAP_DATA})`;
const ORDER = "(uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes)";
const FILL = `(${ORDER},bytes,uint256)`;
const LOD = `(address,uint256,${FILL}[],${FILL}[],bytes)`;

const NEW_METHOD_SIGNATURES: ReadonlyArray<readonly [PendleRouterMethod, string]> = [
  ["mintSyFromToken", `mintSyFromToken(address,address,uint256,${TOKEN_IO})`],
  ["redeemSyToToken", `redeemSyToToken(address,address,uint256,${TOKEN_IO})`],
  ["removeLiquidityDualTokenAndPt", `removeLiquidityDualTokenAndPt(address,address,uint256,${TOKEN_IO},uint256)`],
  ["addLiquiditySingleTokenKeepYt", `addLiquiditySingleTokenKeepYt(address,address,uint256,uint256,${TOKEN_IO})`],
  ["removeLiquiditySinglePt", `removeLiquiditySinglePt(address,address,uint256,uint256,${AP},${LOD})`],
  ["swapExactPtForSy", `swapExactPtForSy(address,address,uint256,uint256,${LOD})`],
  ["swapExactSyForPt", `swapExactSyForPt(address,address,uint256,uint256,${AP},${LOD})`],
  ["removeLiquiditySingleSy", `removeLiquiditySingleSy(address,address,uint256,uint256,${LOD})`],
  ["addLiquiditySingleSy", `addLiquiditySingleSy(address,address,uint256,uint256,${AP},${LOD})`],
];

describe("the nine R5d selectors are pinned by signature AND by live calldata", () => {
  for (const [method, signature] of NEW_METHOD_SIGNATURES) {
    it(`${method}: keccak(signature) === the pinned constant`, () => {
      expect(toFunctionSelector(signature)).toBe(PENDLE_SELECTORS[method]);
    });

    it(`${method}: the pinned selector maps back to its method name`, () => {
      expect(PENDLE_SELECTOR_TO_METHOD[PENDLE_SELECTORS[method]]).toBe(method);
    });
  }

  /** Selector head observed on the wire, per capture. */
  const LIVE_HEADS: ReadonlyArray<readonly [keyof typeof F, PendleRouterMethod]> = [
    ["mintSy", "mintSyFromToken"],
    ["redeemSy", "redeemSyToToken"],
    ["removeLiquidityDual", "removeLiquidityDualTokenAndPt"],
    ["addLiquidityKeepYt", "addLiquiditySingleTokenKeepYt"],
    ["convertLpToPt", "removeLiquiditySinglePt"],
  ];

  for (const [key, method] of LIVE_HEADS) {
    it(`the LIVE ${key} capture's calldata head is ${method}'s selector`, () => {
      expect(route(key).tx.data.slice(0, 10)).toBe(PENDLE_SELECTORS[method]);
      expect(decodeRouterCall(route(key).tx.data).method).toBe(method);
    });
  }

  it("every capture targets the pinned Router", () => {
    for (const key of Object.keys(F) as Array<keyof typeof F>) {
      expect(getAddress(route(key).tx.to)).toBe(PENDLE_ROUTER);
    }
  });

  it("every selector value is unique — no two methods collide", () => {
    const values = Object.values(PENDLE_SELECTORS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("EVERY allowlisted method has at least one min-out binding row", () => {
    // The floor guard refuses a selector with no row, so an ABI entry added
    // without a row would be dead-on-arrival rather than unbound — this makes
    // that a build-time expectation instead of a runtime surprise.
    for (const method of Object.keys(PENDLE_SELECTORS) as PendleRouterMethod[]) {
      expect(PENDLE_MIN_OUT_BINDINGS[method]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

// ── 2. add-liquidity-dual stays EXCLUDED ─────────────────────────────

describe("add-liquidity-dual is NOT in the allowlist (owner decision Q24)", () => {
  it("its selector is absent from PENDLE_SELECTORS", () => {
    expect(Object.values(PENDLE_SELECTORS)).not.toContain(PENDLE_EXCLUDED_ADD_LIQUIDITY_DUAL_SELECTOR);
  });

  it("its selector is absent from the selector→method map", () => {
    expect(PENDLE_SELECTOR_TO_METHOD[PENDLE_EXCLUDED_ADD_LIQUIDITY_DUAL_SELECTOR]).toBeUndefined();
  });

  it("the exclusion constant really is the selector the LIVE capture carries", () => {
    // Guards the exclusion itself: if the provider's selector ever changed, this
    // fails rather than letting us "exclude" an address nobody sends.
    const dual = mutableConvertFixture(R5A.addLiquidityDual).routes[0];
    expect(dual).toBeDefined();
    expect(dual!.tx.data.slice(0, 10)).toBe(PENDLE_EXCLUDED_ADD_LIQUIDITY_DUAL_SELECTOR);
  });

  it("the LIVE add-liquidity-dual calldata is REFUSED by the decoder", () => {
    const dual = mutableConvertFixture(R5A.addLiquidityDual).routes[0]!;
    expectUnsafe(() => decodeRouterCall(dual.tx.data), /unknown Router method|does not decode/);
  });

  it("adding the DUAL remove did not smuggle the DUAL add in beside it", () => {
    expect(PENDLE_SELECTORS.removeLiquidityDualTokenAndPt).toBe("0xb00f09d7");
    expect(Object.keys(PENDLE_SELECTORS)).not.toContain("addLiquidityDualTokenAndPt");
  });
});

// ── 3. Per-chain reflector registry ──────────────────────────────────

describe("the callAndReflect reflector is pinned PER CHAIN", () => {
  it("matches the measured probes exactly, chain by chain", () => {
    for (const [chainId, measured] of Object.entries(PENDLE_REFLECTOR_PROBES)) {
      const pinned = pendleReflectorFor(Number(chainId));
      if (measured === null) {
        expect(pinned, `chain ${chainId} was not measurable and must not be pinned`).toBeUndefined();
      } else {
        expect(pinned, `chain ${chainId}`).toBe(getAddress(measured));
      }
    }
  });

  it("MONAD (143) differs from the canonical reflector — the whole reason this is a map", () => {
    expect(pendleReflectorFor(143)).toBe(MONAD_REFLECTOR);
    expect(pendleReflectorFor(143)).not.toBe(CANONICAL_REFLECTOR);
  });

  it("the six other MEASURED chains all carry the canonical reflector", () => {
    for (const chainId of [1, 56, 999, 8453, 9745, 42161]) {
      expect(pendleReflectorFor(chainId), `chain ${chainId}`).toBe(CANONICAL_REFLECTOR);
    }
  });

  it("an UNMEASURED chain returns undefined — never a defaulted address", () => {
    // Fail-closed: a reflector is a contract a leg may pay out to, so an
    // unmeasured chain must disable the reflect actions, not inherit an address.
    for (const chainId of [10, 146, 5000, 80094]) {
      expect(pendleReflectorFor(chainId), `chain ${chainId}`).toBeUndefined();
    }
  });

  it("an unsupported chain returns undefined", () => {
    expect(pendleReflectorFor(1337)).toBeUndefined();
  });

  it("every pinned chain is a chain Pendle actually supports", () => {
    for (const chainId of Object.keys(PENDLE_REFLECTORS)) {
      expect(PENDLE_SUPPORTED_CHAIN_IDS).toContain(Number(chainId));
    }
  });

  it("the chain-1 and chain-143 captures carry the reflector each is pinned to", () => {
    const one = route("transferLiquidity").contractParamInfo.contractCallParams[0];
    expect(getAddress(one as string)).toBe(pendleReflectorFor(1));
    const monad = route("transferLiquidityMonad").contractParamInfo.contractCallParams[0];
    expect(getAddress(monad as string)).toBe(pendleReflectorFor(143));
  });
});

// ── 4. Decode of each new single-leg capture ─────────────────────────

describe("each new single-leg capture decodes to the intent-relevant params", () => {
  it("mintSyFromToken binds the SY at arg 1 and the ACTUAL token spend", () => {
    const call = decodeRouterCall(route("mintSy").tx.data);
    expect(call.receiver).toBe(WALLET);
    expect(call.marketOrYt).toBe(getAddress("0xcbc72d92b2dc8187414f6734718563898740c0bc"));
    expect(call.spendWei).toBe(1000000000000000000n);
    expect(call.input?.token).toBe(getAddress("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"));
  });

  it("redeemSyToToken binds the SY burned and the delivered token", () => {
    const call = decodeRouterCall(route("redeemSy").tx.data);
    expect(call.marketOrYt).toBe(getAddress("0xcbc72d92b2dc8187414f6734718563898740c0bc"));
    expect(call.spendWei).toBe(1000000000000000000n);
    expect(call.output?.token).toBe(getAddress("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"));
  });

  it("removeLiquidityDualTokenAndPt binds the LP burned and the token leg", () => {
    const call = decodeRouterCall(route("removeLiquidityDual").tx.data);
    expect(call.spendWei).toBe(1000000000000000000n);
    expect(call.output?.token).toBe(getAddress("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"));
    expect(call.args[4]).toBe(120248058329414566n); // minPtOut, the second leg
  });

  it("addLiquiditySingleTokenKeepYt binds the token spend and BOTH minimums", () => {
    const call = decodeRouterCall(route("addLiquidityKeepYt").tx.data);
    expect(call.spendWei).toBe(1000000000000000000n);
    expect(call.input?.token).toBe(getAddress("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"));
    expect(call.args[2]).toBe(555953169577670255n); // minLpOut
    expect(call.args[3]).toBe(67527564811917779n); // minYtOut
  });

  it("removeLiquiditySinglePt reads minPtOut at arg 3, NOT arg 2", () => {
    const call = decodeRouterCall(route("convertLpToPt").tx.data);
    expect(call.spendWei).toBe(1000000000000000000n); // arg 2 is the LP burned
    expect(call.args[2]).toBe(1000000000000000000n);
    expect(call.args[3]).toBe(2262928819021954834n); // arg 3 is the min-out
  });
});

// ── 5. Every new capture clears its own floor ────────────────────────

describe("every LIVE capture passes the floor guard it is bound by", () => {
  const SINGLE_LEG: ReadonlyArray<keyof typeof F> = [
    "mintSy",
    "redeemSy",
    "removeLiquidityDual",
    "addLiquidityKeepYt",
    "convertLpToPt",
  ];

  for (const key of SINGLE_LEG) {
    it(`${key} — the provider's own calldata clears our independently computed floor`, () => {
      expect(() => assertRouteFloorBound(decodeRouterCall(route(key).tx.data), route(key), BPS)).not.toThrow();
    });
  }

  it("every capture passes production validation and declares a NON-EMPTY route set", () => {
    for (const key of Object.keys(F) as Array<keyof typeof F>) {
      const res = response(key);
      expect(res.routes.length, key).toBeGreaterThan(0);
      expect(res.routes[0]!.outputs.length, key).toBeGreaterThan(0);
      for (const output of res.routes[0]!.outputs) expect(BigInt(output.amount)).toBeGreaterThan(0n);
    }
  });
});

// ── 6. Poison matrix: one case PER FIELD ─────────────────────────────

/**
 * Every economically material min-out field of every new selector, with the
 * route output it protects and how to write a chosen value into the calldata.
 *
 * The dual rows deliberately name their leg by TOKEN, mirroring the binding
 * table — an index here would make the test agree with a bug in the table.
 */
interface FieldCase {
  readonly key: keyof typeof F;
  readonly field: string;
  /** Write `value` into this field of the decoded args. */
  readonly poison: (value: bigint) => (args: unknown[]) => void;
  /** The route output this field protects, resolved from the response. */
  readonly protects: (route: PendleConvertRoute) => PendleTokenAmount;
}

const TOKEN = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
const MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";

const only = (outputs: readonly PendleTokenAmount[], keep: (t: string) => boolean, what: string) => {
  const found = outputs.filter((o) => keep(o.token.toLowerCase()));
  if (found.length !== 1) throw new Error(`test setup: ${what} did not resolve to one output`);
  return found[0]!;
};

const FIELD_CASES: readonly FieldCase[] = [
  {
    key: "mintSy",
    field: "minSyOut",
    poison: (v) => setArg(2, v),
    protects: (r) => r.outputs[0]!,
  },
  {
    key: "redeemSy",
    field: "minTokenOut",
    poison: (v) => setMinTokenOut(3, v),
    protects: (r) => r.outputs[0]!,
  },
  {
    key: "removeLiquidityDual",
    field: "minTokenOut",
    poison: (v) => setMinTokenOut(3, v),
    protects: (r) => only(r.outputs, (t) => t === TOKEN, "dual token leg"),
  },
  {
    key: "removeLiquidityDual",
    field: "minPtOut",
    poison: (v) => setArg(4, v),
    protects: (r) => only(r.outputs, (t) => t !== TOKEN, "dual PT leg"),
  },
  {
    key: "addLiquidityKeepYt",
    field: "minLpOut",
    poison: (v) => setArg(2, v),
    protects: (r) => only(r.outputs, (t) => t === MARKET, "keep-YT LP leg"),
  },
  {
    key: "addLiquidityKeepYt",
    field: "minYtOut",
    poison: (v) => setArg(3, v),
    protects: (r) => only(r.outputs, (t) => t !== MARKET, "keep-YT YT leg"),
  },
  {
    key: "convertLpToPt",
    field: "minPtOut",
    poison: (v) => setArg(3, v),
    protects: (r) => r.outputs[0]!,
  },
];

describe("the floor is enforced PER FIELD, at one raw unit of slack", () => {
  for (const { key, field, poison, protects } of FIELD_CASES) {
    const floorOf = () => computePendleFloorRaw(protects(route(key)).amount, BPS);

    it(`${key}/${field}: floor − 1n is ACCEPTED (the absolute one-unit allowance)`, () => {
      const data = tamper(route(key).tx.data, poison(floorOf() - PENDLE_FLOOR_ALLOWANCE_RAW));
      expect(() => assertRouteFloorBound(decodeRouterCall(data), route(key), BPS)).not.toThrow();
    });

    it(`${key}/${field}: floor − 2n is REFUSED as price_floor, naming the field`, () => {
      const data = tamper(route(key).tx.data, poison(floorOf() - PENDLE_FLOOR_ALLOWANCE_RAW - 1n));
      expectUnsafe(
        () => assertRouteFloorBound(decodeRouterCall(data), route(key), BPS),
        new RegExp(`price_floor.*${field}`),
      );
    });

    it(`${key}/${field}: stripped to ZERO is REFUSED`, () => {
      const data = tamper(route(key).tx.data, poison(0n));
      expectUnsafe(() => assertRouteFloorBound(decodeRouterCall(data), route(key), BPS), /price_floor/);
    });
  }

  it("the allowance is ABSOLUTE — it does not scale with trade size", () => {
    expect(PENDLE_FLOOR_ALLOWANCE_RAW).toBe(1n);
  });

  it("poisoning ONE leg of a dual action is caught even when the OTHER is honest", () => {
    // The failure this rules out: a single-field guard that passes because the
    // untouched leg still clears its floor.
    const r = route("removeLiquidityDual");
    const ptLeg = only(r.outputs, (t) => t !== TOKEN, "dual PT leg");
    const data = tamper(r.tx.data, setArg(4, computePendleFloorRaw(ptLeg.amount, BPS) - 2n));
    expectUnsafe(() => assertRouteFloorBound(decodeRouterCall(data), r, BPS), /price_floor.*minPtOut/);
  });
});

// ── 7. Dual coverage resolves by TOKEN, not by position ──────────────

describe("a dual selector's legs are matched by TOKEN, never by output order", () => {
  it("reversing the route's declared output order changes nothing", () => {
    // MEASURED: the provider's `outputs` order is its own and does not echo the
    // request, so the guard must not depend on it. If these rows were bound by
    // index, this test would floor each field against the WRONG leg — on this
    // capture the two amounts differ ~14x, so it would silently pass a route
    // paying a fraction of the quote.
    for (const key of ["removeLiquidityDual", "addLiquidityKeepYt"] as const) {
      const forward = route(key);
      const reversed: PendleConvertRoute = { ...forward, outputs: [...forward.outputs].reverse() };
      const call = decodeRouterCall(forward.tx.data);
      expect(() => assertRouteFloorBound(call, forward, BPS), `${key} forward`).not.toThrow();
      expect(() => assertRouteFloorBound(call, reversed, BPS), `${key} reversed`).not.toThrow();
    }
  });

  it("REFUSES when the counterpart leg cannot be resolved uniquely", () => {
    // Both outputs the same token → "the other one" is not well defined, so the
    // guard fails closed instead of picking one.
    const r = route("removeLiquidityDual");
    const ambiguous: PendleConvertRoute = {
      ...r,
      outputs: [{ token: TOKEN, amount: r.outputs[0]!.amount }, { token: TOKEN, amount: r.outputs[1]!.amount }],
    };
    expectUnsafe(() => assertRouteFloorBound(decodeRouterCall(r.tx.data), ambiguous, BPS), /price_floor/);
  });

  it("REFUSES when the route does not declare the leg the calldata protects", () => {
    const r = route("removeLiquidityDual");
    const missing: PendleConvertRoute = { ...r, outputs: [only(r.outputs, (t) => t === TOKEN, "token leg")] };
    expectUnsafe(
      () => assertRouteFloorBound(decodeRouterCall(r.tx.data), missing, BPS),
      /price_floor.*minPtOut/,
    );
  });
});

// ── 8. callAndReflect, now that the inner legs are pinned ────────────

describe("the LIVE reflect captures now decode recursively", () => {
  it("roll-over-pt decodes to swapExactPtForSy → swapExactSyForPt", () => {
    const decoded = decodeReflectCall(route("rollOverPtR5d").tx.data);
    expect(decoded.reflector).toBe(CANONICAL_REFLECTOR);
    expect(decoded.legs.map((l) => l.method)).toEqual(["swapExactPtForSy", "swapExactSyForPt"]);
  });

  it("roll-over-pt's leg 1 pays the REFLECTOR and its FINAL leg pays the wallet", () => {
    const decoded = decodeReflectCall(route("rollOverPtR5d").tx.data);
    expect(decoded.legs[0]!.receiver).toBe(CANONICAL_REFLECTOR);
    expect(decoded.legs[1]!.receiver).toBe(WALLET);
  });

  it("transfer-liquidity decodes to removeLiquiditySingleSy → addLiquiditySingleSy", () => {
    const decoded = decodeReflectCall(route("transferLiquidity").tx.data);
    expect(decoded.legs.map((l) => l.method)).toEqual(["removeLiquiditySingleSy", "addLiquiditySingleSy"]);
    expect(decoded.legs[0]!.receiver).toBe(CANONICAL_REFLECTOR);
    expect(decoded.legs[1]!.receiver).toBe(WALLET);
  });

  it("a reflect over markets that do NOT share an SY uses the token-routed pair", () => {
    // The chain-143 capture: different SYs, so the legs are the two selectors
    // that were already pinned before R5d.
    const decoded = decodeReflectCall(route("transferLiquidityMonad").tx.data);
    expect(decoded.reflector).toBe(MONAD_REFLECTOR);
    expect(decoded.legs.map((l) => l.method)).toEqual([
      "removeLiquiditySingleToken",
      "addLiquiditySingleToken",
    ]);
  });

  it("the outer reflect selector is still NOT decodable as a single-leg call", () => {
    expectUnsafe(() => decodeRouterCall(route("rollOverPtR5d").tx.data), /unknown Router method|does not decode/);
    expect(route("rollOverPtR5d").tx.data.slice(0, 10)).toBe(PENDLE_REFLECT_SELECTOR);
  });

  const REFLECT_CAPTURES = ["rollOverPtR5d", "transferLiquidity", "transferLiquidityMonad"] as const;

  for (const key of REFLECT_CAPTURES) {
    it(`${key}: the live body clears the reflect floor (final leg floored, intermediate non-zero)`, () => {
      const decoded = decodeReflectCall(route(key).tx.data);
      expect(() => assertReflectFloorBound(decoded, route(key), BPS)).not.toThrow();
    });
  }
});

describe("a poisoned min-out inside a reflect leg is refused", () => {
  it("REFUSES a FINAL leg whose min-out is one unit below the allowance", () => {
    // Poison the final leg in place, then re-wrap through the real reflect ABI.
    const r = route("rollOverPtR5d");
    const decoded = decodeReflectCall(r.tx.data);
    const floor = computePendleFloorRaw(r.outputs[0]!.amount, BPS);
    const poisonedFinal = tamper(
      encodeFunctionData({
        abi: PENDLE_ROUTER_ABI,
        functionName: "swapExactSyForPt",
        args: decoded.legs[1]!.args as never,
      }),
      setArg(3, floor - PENDLE_FLOOR_ALLOWANCE_RAW - 1n),
    );
    const rebuilt = { ...decoded, legs: [decoded.legs[0]!, decodeRouterCall(poisonedFinal)] };
    expectUnsafe(() => assertReflectFloorBound(rebuilt, r, BPS), /price_floor.*minPtOut/);
  });

  it("ACCEPTS a FINAL leg exactly at floor − 1n", () => {
    const r = route("rollOverPtR5d");
    const decoded = decodeReflectCall(r.tx.data);
    const floor = computePendleFloorRaw(r.outputs[0]!.amount, BPS);
    const atAllowance = tamper(
      encodeFunctionData({
        abi: PENDLE_ROUTER_ABI,
        functionName: "swapExactSyForPt",
        args: decoded.legs[1]!.args as never,
      }),
      setArg(3, floor - PENDLE_FLOOR_ALLOWANCE_RAW),
    );
    const rebuilt = { ...decoded, legs: [decoded.legs[0]!, decodeRouterCall(atAllowance)] };
    expect(() => assertReflectFloorBound(rebuilt, r, BPS)).not.toThrow();
  });

  it("REFUSES an INTERMEDIATE leg stripped to a zero minimum", () => {
    // The intermediate SY amount appears nowhere in the quote, so it cannot be
    // floored — but it must never be zero, or the wrapper could route the whole
    // position through an unbounded first hop.
    const r = route("rollOverPtR5d");
    const decoded = decodeReflectCall(r.tx.data);
    const stripped = tamper(
      encodeFunctionData({
        abi: PENDLE_ROUTER_ABI,
        functionName: "swapExactPtForSy",
        args: decoded.legs[0]!.args as never,
      }),
      setArg(3, 0n),
    );
    const rebuilt = { ...decoded, legs: [decodeRouterCall(stripped), decoded.legs[1]!] };
    expectUnsafe(() => assertReflectFloorBound(rebuilt, r, BPS), /intermediate leg 1/);
  });

  it("REFUSES a transfer-liquidity intermediate leg stripped to zero", () => {
    const r = route("transferLiquidity");
    const decoded = decodeReflectCall(r.tx.data);
    const stripped = tamper(
      encodeFunctionData({
        abi: PENDLE_ROUTER_ABI,
        functionName: "removeLiquiditySingleSy",
        args: decoded.legs[0]!.args as never,
      }),
      setArg(3, 0n),
    );
    const rebuilt = { ...decoded, legs: [decodeRouterCall(stripped), decoded.legs[1]!] };
    expectUnsafe(() => assertReflectFloorBound(rebuilt, r, BPS), /intermediate leg 1/);
  });
});
