/**
 * R5d card E2 — the `callAndReflect` ROUTE BINDER
 * (`calldata/bind-reflect.ts`).
 *
 * D1 measured the primitives (`decodeReflectCall`, `reflectLegReceiverIsAllowed`,
 * `assertReflectFloorBound`, `pendleReflectorFor`) and left them without a
 * production caller. This suite pins the caller: the binder that composes them
 * into the same fund-safety contract `assertRouteSafe` gives a single-leg route.
 *
 * Every green case is a LIVE capture from `./r5d-fixtures.ts` (chain 1 + chain
 * 143, quote-only, 2026-07-28). Every poison is produced by decoding a real
 * capture, moving ONE field, and re-encoding BOTH the body and its echo — so a
 * poison can never pass because the surrounding route was malformed, and each
 * case isolates exactly one invariant.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import {
  assertReflectRouteSafe,
  selectSafeReflectRoute,
  type PendleReflectIntent,
} from "@vex-agent/tools/protocols/pendle/calldata/bind-reflect.js";
import { PENDLE_REFLECT_ABI, PENDLE_ROUTER_ABI } from "@tools/pendle/constants.js";
import type { PendleConvertResponse, PendleConvertRoute } from "@tools/pendle/types.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_R5D_FIXTURES as F } from "./r5d-fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const ATTACKER = getAddress("0xdEAD000000000000000000000000000000000000");
const CANONICAL_REFLECTOR = getAddress("0x30544e00cf296b34a9ee59e5540ae2f9cccd55dd");
const MONAD_REFLECTOR = getAddress("0x73d5dbf81a4f3bfa7b335e6a2d4638d6017a4fa8");

const SOURCE_MARKET = getAddress("0x34280882267ffa6383b363e278b027be083bbe3b");
const DEST_MARKET = getAddress("0xba1cbaece600beec76dabc0a4ead31e0339cbe37");
/** The destination PT the chain-1 roll-over capture declares as its only output. */
const DEST_PT = getAddress("0xa3e7ccf0d0fa014892372c0321731a1ed977068c");
const SOURCE_PT = getAddress("0xb253eff1104802b97ac7e3ac9fdd73aece295a2c");
const MONAD_SOURCE_MARKET = getAddress("0x2142267022ecde6745de9f577e3ba4549ad23abc");
const MONAD_DEST_MARKET = getAddress("0x6f99cf00ee7290ae78a072bb6910ef72d1129fe7");

const ONE_E18 = 1_000_000_000_000_000_000n;

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

/** Decode a real inner leg, move one field, re-encode. */
function tamper(data: Hex, mutate: (args: unknown[]) => void): Hex {
  const d = decodeFunctionData({ abi: PENDLE_ROUTER_ABI, data });
  const args: unknown[] = [...structuredClone(d.args)];
  mutate(args);
  return encodeFunctionData({
    abi: PENDLE_ROUTER_ABI,
    functionName: d.functionName,
    args: args as never,
  });
}

/** The three raw leg bodies a captured reflect route echoes after the reflector. */
function legBytes(r: PendleConvertRoute): [Hex, Hex, Hex] {
  const [a, b, c] = r.contractParamInfo.contractCallParams.slice(1);
  for (const p of [a, b, c]) {
    if (typeof p !== "string") throw new Error("captured echo does not carry three leg bodies");
  }
  return [a as Hex, b as Hex, c as Hex];
}

/**
 * Rebuild a reflect route from a reflector and its three leg bodies, keeping the
 * echoed params CONSISTENT with the calldata. Poisons that target the echo alone
 * pass `echo` explicitly.
 */
function rebuild(
  base: PendleConvertRoute,
  reflector: Address,
  legs: readonly [Hex, Hex, Hex],
  echo?: readonly unknown[],
): PendleConvertRoute {
  const data = encodeFunctionData({
    abi: PENDLE_REFLECT_ABI,
    functionName: "callAndReflect",
    args: [reflector, legs[0], legs[1], legs[2]],
  });
  return {
    ...base,
    tx: { ...base.tx, data },
    contractParamInfo: {
      ...base.contractParamInfo,
      contractCallParams: [...(echo ?? [reflector, legs[0], legs[1], legs[2]])],
    },
  };
}

function withRoutes(base: PendleConvertResponse, routes: PendleConvertRoute[]): PendleConvertResponse {
  return { ...base, routes };
}

// ── Intents matching the live captures ───────────────────────────────

const rolloverIntent: PendleReflectIntent = {
  action: "pt-rollover",
  chainId: 1,
  wallet: WALLET,
  inputToken: SOURCE_PT,
  inputAmountWei: ONE_E18,
  slippageBps: 100,
  expectedLegMarkets: [SOURCE_MARKET, DEST_MARKET],
  expectedRouteOutputs: [DEST_PT],
};

const transferIntent: PendleReflectIntent = {
  action: "lp-transfer",
  chainId: 1,
  wallet: WALLET,
  inputToken: SOURCE_MARKET,
  inputAmountWei: ONE_E18,
  slippageBps: 100,
  expectedLegMarkets: [SOURCE_MARKET, DEST_MARKET],
  expectedRouteOutputs: [DEST_MARKET],
};

const monadTransferIntent: PendleReflectIntent = {
  action: "lp-transfer",
  chainId: 143,
  wallet: WALLET,
  inputToken: MONAD_SOURCE_MARKET,
  inputAmountWei: ONE_E18,
  slippageBps: 100,
  expectedLegMarkets: [MONAD_SOURCE_MARKET, MONAD_DEST_MARKET],
  expectedRouteOutputs: [MONAD_DEST_MARKET],
};

// ── 1. Green path, per action, from the live captures ────────────────

describe("the LIVE reflect captures bind clean", () => {
  it("accepts the chain-1 roll-over-pt capture", () => {
    const res = response("rollOverPtR5d");
    const only = res.routes[0]!;
    // Returns the SAME route object it validated — the caller broadcasts exactly
    // what was checked, never a copy that could have drifted.
    expect(assertReflectRouteSafe(rolloverIntent, res, only)).toBe(only);
  });

  it("accepts the chain-1 transfer-liquidity capture", () => {
    expect(() =>
      assertReflectRouteSafe(transferIntent, response("transferLiquidity"), route("transferLiquidity")),
    ).not.toThrow();
  });

  it("accepts the MONAD transfer-liquidity capture — a DIFFERENT pinned reflector", () => {
    // Guards the test itself: chain 143's reflector really is not the canonical
    // one, so this case cannot pass by accident on the shared address.
    expect(MONAD_REFLECTOR).not.toBe(CANONICAL_REFLECTOR);
    expect(() =>
      assertReflectRouteSafe(
        monadTransferIntent,
        response("transferLiquidityMonad"),
        route("transferLiquidityMonad"),
      ),
    ).not.toThrow();
  });

  it("selectSafeReflectRoute returns the capture's only route", () => {
    expect(selectSafeReflectRoute(rolloverIntent, response("rollOverPtR5d"))).toEqual(
      route("rollOverPtR5d"),
    );
  });
});

// ── 2. Poisoned matrix, one invariant per case ───────────────────────

describe("the reflector is pinned per chain", () => {
  it("REFUSES a body whose reflector is an ATTACKER contract", () => {
    const base = route("rollOverPtR5d");
    const poisoned = rebuild(base, ATTACKER, legBytes(base));
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), poisoned),
      /reflector is not the one pinned/,
    );
  });

  it("REFUSES the CANONICAL reflector on the chain that measured a different one", () => {
    const base = route("transferLiquidityMonad");
    const poisoned = rebuild(base, CANONICAL_REFLECTOR, legBytes(base));
    expectUnsafe(
      () => assertReflectRouteSafe(monadTransferIntent, response("transferLiquidityMonad"), poisoned),
      /reflector is not the one pinned/,
    );
  });

  it("REFUSES outright on a chain whose reflector was never MEASURED", () => {
    // Chain 10 had no two active markets at capture time, so PENDLE_REFLECTORS
    // omits it. An unmeasured chain must fail closed, not borrow an address.
    expectUnsafe(
      () =>
        assertReflectRouteSafe(
          { ...rolloverIntent, chainId: 10 },
          response("rollOverPtR5d"),
          route("rollOverPtR5d"),
        ),
      /no reflector has been measured for chain 10/,
    );
  });
});

describe("every inner leg goes through the Router allowlist", () => {
  it("REFUSES an inner selector that is not allowlisted", () => {
    const base = route("rollOverPtR5d");
    const [leg1, empty] = legBytes(base);
    const poisoned = rebuild(base, CANONICAL_REFLECTOR, [
      leg1,
      empty,
      ("0xabcdef01" + "00".repeat(160)) as Hex,
    ]);
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), poisoned),
      /does not decode as a known Router method/,
    );
  });
});

describe("the leg-1 reflector exception is exactly that — leg 1, reflector only", () => {
  const base = () => route("rollOverPtR5d");
  const withLegReceiver = (legIndex: 0 | 2, receiver: Address): PendleConvertRoute => {
    const b = base();
    const legs = legBytes(b);
    legs[legIndex] = tamper(legs[legIndex], (a) => {
      a[0] = receiver;
    });
    return rebuild(b, CANONICAL_REFLECTOR, legs);
  };

  it("ACCEPTS the wallet as leg 1's receiver — the exception widens, it does not require", () => {
    expect(() =>
      assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), withLegReceiver(0, WALLET)),
    ).not.toThrow();
  });

  it("REFUSES an ATTACKER as leg 1's receiver", () => {
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), withLegReceiver(0, ATTACKER)),
      /reflect leg 1 pays out to neither/,
    );
  });

  it("REFUSES the REFLECTOR as the FINAL leg's receiver — proceeds must land on the wallet", () => {
    expectUnsafe(
      () =>
        assertReflectRouteSafe(
          rolloverIntent,
          response("rollOverPtR5d"),
          withLegReceiver(2, CANONICAL_REFLECTOR),
        ),
      /reflect leg 2 pays out to neither/,
    );
  });

  it("REFUSES an ATTACKER as the FINAL leg's receiver", () => {
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), withLegReceiver(2, ATTACKER)),
      /reflect leg 2 pays out to neither/,
    );
  });
});

describe("every leg's market and leg 1's spend are bound", () => {
  it("REFUSES a leg whose market is not the quoted one", () => {
    expectUnsafe(
      () =>
        assertReflectRouteSafe(
          { ...rolloverIntent, expectedLegMarkets: [SOURCE_MARKET, ATTACKER] },
          response("rollOverPtR5d"),
          route("rollOverPtR5d"),
        ),
      /reflect leg 2 market does not match/,
    );
  });

  it("REFUSES a body carrying a different NUMBER of legs than the quote", () => {
    expectUnsafe(
      () =>
        assertReflectRouteSafe(
          { ...rolloverIntent, expectedLegMarkets: [SOURCE_MARKET] },
          response("rollOverPtR5d"),
          route("rollOverPtR5d"),
        ),
      /different number of legs/,
    );
  });

  it("REFUSES an INFLATED spend on leg 1", () => {
    const b = route("rollOverPtR5d");
    const legs = legBytes(b);
    legs[0] = tamper(legs[0], (a) => {
      a[2] = ONE_E18 * 5n;
    });
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), rebuild(b, CANONICAL_REFLECTOR, legs)),
      /spend amount does not match/,
    );
  });
});

describe("the echoed params are cross-checked against the calldata", () => {
  it("REFUSES an echoed reflector that disagrees with the body", () => {
    const b = route("rollOverPtR5d");
    const legs = legBytes(b);
    const poisoned = rebuild(b, CANONICAL_REFLECTOR, legs, [ATTACKER, legs[0], legs[1], legs[2]]);
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), poisoned),
      /echoed reflector disagrees/,
    );
  });

  it("REFUSES an echoed LEG that disagrees with the body", () => {
    const b = route("rollOverPtR5d");
    const legs = legBytes(b);
    const spoofedFinal = tamper(legs[2], (a) => {
      a[0] = ATTACKER;
    });
    const poisoned = rebuild(b, CANONICAL_REFLECTOR, legs, [
      CANONICAL_REFLECTOR,
      legs[0],
      legs[1],
      spoofedFinal,
    ]);
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), poisoned),
      /echoed leg 2 disagrees/,
    );
  });

  it("REFUSES an echo that drops a leg the body carries", () => {
    const b = route("rollOverPtR5d");
    const legs = legBytes(b);
    const poisoned = rebuild(b, CANONICAL_REFLECTOR, legs, [CANONICAL_REFLECTOR, legs[0], "0x", "0x"]);
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), poisoned),
      /echoed reflect legs disagree/,
    );
  });
});

describe("every leg is floor-bound", () => {
  it("REFUSES an INTERMEDIATE leg stripped to a zero minimum", () => {
    const b = route("rollOverPtR5d");
    const legs = legBytes(b);
    legs[0] = tamper(legs[0], (a) => {
      a[3] = 0n;
    });
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), rebuild(b, CANONICAL_REFLECTOR, legs)),
      /price_floor: intermediate leg 1/,
    );
  });

  it("REFUSES a lowered minimum on the FINAL leg", () => {
    const b = route("rollOverPtR5d");
    const legs = legBytes(b);
    legs[2] = tamper(legs[2], (a) => {
      a[3] = 1n;
    });
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), rebuild(b, CANONICAL_REFLECTOR, legs)),
      /price_floor.*minPtOut/,
    );
  });
});

describe("router pin, sender, value and approvals bind exactly as a single-leg route", () => {
  it("REFUSES a target that is not the pinned Router", () => {
    const poisoned = { ...route("rollOverPtR5d"), tx: { ...route("rollOverPtR5d").tx, to: ATTACKER } };
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), poisoned),
      /not the pinned Pendle Router/,
    );
  });

  it("REFUSES a sender that is not the session wallet", () => {
    const base = route("rollOverPtR5d");
    const poisoned = { ...base, tx: { ...base.tx, from: ATTACKER } };
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), poisoned),
      /sender is not the session wallet/,
    );
  });

  it("REFUSES any native value — a reflect action spends an ERC20 position token", () => {
    const base = route("rollOverPtR5d");
    const poisoned = { ...base, tx: { ...base.tx, value: "1" } };
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, response("rollOverPtR5d"), poisoned),
      /must not send native value/,
    );
  });

  it("REFUSES an approval for a token other than the input", () => {
    const res = response("rollOverPtR5d");
    res.requiredApprovals = [{ token: ATTACKER, amount: ONE_E18.toString() }];
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, res, route("rollOverPtR5d")),
      /approval targets a token other than the input/,
    );
  });

  it("REFUSES an approval amount above the quoted input", () => {
    const res = response("rollOverPtR5d");
    res.requiredApprovals = [{ token: SOURCE_PT, amount: (ONE_E18 * 2n).toString() }];
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, res, route("rollOverPtR5d")),
      /approval amount does not match/,
    );
  });

  it("REFUSES an EXTRA approval smuggled alongside the input's", () => {
    const res = response("rollOverPtR5d");
    res.requiredApprovals = [
      { token: SOURCE_PT, amount: ONE_E18.toString() },
      { token: ATTACKER, amount: ONE_E18.toString() },
    ];
    expectUnsafe(
      () => assertReflectRouteSafe(rolloverIntent, res, route("rollOverPtR5d")),
      /exactly one token approval/,
    );
  });
});

describe("selectSafeReflectRoute never falls back to an unchecked route", () => {
  const poisonedRoute = (): PendleConvertRoute => {
    const b = route("rollOverPtR5d");
    return rebuild(b, ATTACKER, legBytes(b));
  };

  it("throws when NO route passes", () => {
    const res = withRoutes(response("rollOverPtR5d"), [poisonedRoute()]);
    expectUnsafe(() => selectSafeReflectRoute(rolloverIntent, res), /reflector is not the one pinned/);
  });

  it("throws when the response carries no route at all", () => {
    const res = withRoutes(response("rollOverPtR5d"), []);
    expectUnsafe(() => selectSafeReflectRoute(rolloverIntent, res), /no reflect route passed/);
  });

  it("SKIPS a poisoned route and returns the safe one behind it", () => {
    const safe = route("rollOverPtR5d");
    const res = withRoutes(response("rollOverPtR5d"), [poisonedRoute(), safe]);
    expect(selectSafeReflectRoute(rolloverIntent, res)).toBe(safe);
  });
});
