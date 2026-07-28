/**
 * Pendle `callAndReflect` ROUTE binding — the multi-leg sibling of
 * `./bind-route.ts`.
 *
 * Two actions, and only two, reach this module (measured 2026-07-28, R5d):
 * `pt-rollover` (roll-over-pt) and `lp-transfer` (transfer-liquidity). Their
 * calldata is a `callAndReflect` wrapper carrying whole Router calls as `bytes`,
 * so the single-leg binder in `./bind-route.ts` cannot read them at all — its
 * `decodeRouterCall` refuses the outer selector by design. `convert-lp-to-pt`
 * does NOT come here: it live-probed as a plain single-leg
 * `removeLiquiditySinglePt` and is bound by `assertRouteSafe` like any other
 * single-leg action.
 *
 * The checks mirror `assertRouteSafe` one-for-one, adjusted where a reflect body
 * genuinely differs (fail → ZERO approve, ZERO send):
 *
 *   1. Router pin       : tx.to === PENDLE_ROUTER, exactly as a single-leg route.
 *   2. Sender bind      : tx.from absent OR equals the session wallet.
 *   3. Value bind       : ZERO, always. Both reflect actions spend an ERC20
 *                         position token (a PT or an LP), never native ETH, so
 *                         there is no native branch to take — and no field a
 *                         caller could set to open one.
 *   4. Approvals bind   : EXACTLY one approval, for the input position token, at
 *                         the input amount, and nothing else. Spender is
 *                         IMPLICIT = the pinned Router.
 *   5. Reflector pin    : the decoded reflector must be the one MEASURED for this
 *                         chain (`pendleReflectorFor`). The reflector is the one
 *                         contract a leg may pay out to instead of the wallet, so
 *                         an unmeasured chain refuses rather than assuming the
 *                         address the other chains happen to share.
 *   6. Calldata bind    : every leg FULL-decoded through the same Router
 *                         allowlist, then per leg — the receiver
 *                         (`reflectLegReceiverIsAllowed`: leg 1 reflector-or-wallet,
 *                         every later leg wallet-only), the market, and, for
 *                         leg 1 only, the ACTUAL spend against the quoted input.
 *                         Later legs spend an INTERMEDIATE amount the quote never
 *                         reports, so there is nothing to bind them to.
 *   7. Echo cross-check : `contractCallParams` on a reflect body echoes
 *                         `[reflector, selfCall1, selfCall2, reflectCall]` — the
 *                         REFLECTOR at index 0 and raw leg calldata after it, not
 *                         the `[receiver, market]` pair a single-leg route echoes.
 *                         Index 0 is bound against the pinned reflector, and each
 *                         non-empty echoed leg is decoded through the SAME
 *                         Router allowlist and compared with the leg decoded out
 *                         of `tx.data`, so a spoofed echo cannot
 *                         mislead downstream logging/UX.
 *   8. PRICE FLOOR      : LAST, so a tampered route is reported as tampering
 *                         rather than as a price problem. Every leg must own a
 *                         minimum-output binding row, then
 *                         `assertReflectFloorBound` holds the FINAL leg to the
 *                         quote's floor and every earlier leg to a non-zero
 *                         minimum.
 */

import { getAddress, type Address } from "viem";

import { VexError } from "../../../../../errors.js";
import { PENDLE_ROUTER, pendleReflectorFor } from "@tools/pendle/constants.js";
import type { PendleConvertResponse, PendleConvertRoute } from "@tools/pendle/types.js";

import {
  decodeReflectCall,
  decodeRouterCall,
  requireAddress,
  unsafe,
  type DecodedRouterCall,
} from "./decode.js";
import {
  PENDLE_MIN_OUT_BINDINGS,
  assertReflectFloorBound,
  reflectLegReceiverIsAllowed,
} from "./price-floor.js";

/**
 * The actions whose calldata is a `callAndReflect` wrapper. MEASURED, not
 * assumed: `convert-lp-to-pt` was probed alongside these two and came back as a
 * plain single-leg `removeLiquiditySinglePt`, so it is deliberately absent.
 */
export type PendleReflectAction = "pt-rollover" | "lp-transfer";

export interface PendleReflectIntent {
  action: PendleReflectAction;
  /**
   * The chain the quote was built on. REQUIRED: the reflector is per-chain, and
   * the leg-1 receiver exception cannot be granted without knowing which
   * contract earns it.
   */
  chainId: number;
  /** Session wallet — the ONLY allowed sender, and the only receiver after leg 1. */
  wallet: Address;
  /** The position token being spent: the source PT (rollover) or the source LP/market (transfer). */
  inputToken: Address;
  /** Input amount in wei (matches Convert `inputs[0].amount`), bound against leg 1's spend. */
  inputAmountWei: bigint;
  /**
   * The tolerance this trade was QUOTED at, in whole basis points. REQUIRED for
   * the same reason as on `PendleTxIntent`: an optional floor is a floor
   * that can be skipped.
   */
  slippageBps: number;
  /**
   * The market each leg must carry at arg 1, IN EXECUTION ORDER — for both
   * actions that is `[sourceMarket, destinationMarket]`. The decoded leg count
   * must equal this list's length, so a body that grows an extra leg is refused
   * rather than partially bound.
   */
  expectedLegMarkets: readonly Address[];
}

// ── Approval-set binding ────────────────────────────────────────────

function assertReflectApprovals(intent: PendleReflectIntent, response: PendleConvertResponse): void {
  const approvals = response.requiredApprovals;
  if (approvals.length !== 1) return unsafe("expected exactly one token approval");
  const only = approvals[0]!;
  if (requireAddress(only.token, "approval token") !== getAddress(intent.inputToken)) {
    return unsafe("the approval targets a token other than the input");
  }
  if (only.amount !== intent.inputAmountWei.toString()) {
    return unsafe("the approval amount does not match the input");
  }
}

// ── Echo cross-check ────────────────────────────────────────────────

/**
 * A reflect body's echoed params are `[reflector, selfCall1, selfCall2,
 * reflectCall]`. Bind index 0 against the pinned reflector and decode each
 * non-empty echoed leg, comparing it with the leg decoded out of `tx.data`.
 */
function assertReflectEcho(
  route: PendleConvertRoute,
  reflector: Address,
  legs: readonly DecodedRouterCall[],
): void {
  const params = route.contractParamInfo.contractCallParams;
  const echoReflector = typeof params[0] === "string" ? params[0] : "";
  if (echoReflector === "") return unsafe("the route echoes no reflector");
  if (requireAddress(echoReflector, "echoed reflector") !== reflector) {
    return unsafe("echoed reflector disagrees with the calldata");
  }

  const echoedLegs: DecodedRouterCall[] = [];
  for (const raw of params.slice(1)) {
    if (typeof raw !== "string") return unsafe("an echoed reflect leg is not calldata");
    if (raw === "0x" || raw === "") continue;
    echoedLegs.push(decodeRouterCall(raw));
  }
  if (echoedLegs.length !== legs.length) {
    return unsafe("the echoed reflect legs disagree with the calldata");
  }
  echoedLegs.forEach((echo, index) => {
    const leg = legs[index]!;
    if (
      echo.method !== leg.method ||
      echo.receiver !== leg.receiver ||
      echo.marketOrYt !== leg.marketOrYt ||
      echo.spendWei !== leg.spendWei
    ) {
      return unsafe(`echoed leg ${index + 1} disagrees with the calldata`);
    }
  });
}

// ── Route validation ────────────────────────────────────────────────

/**
 * Validate ONE `callAndReflect` route against the intent. Returns the route when
 * safe; throws `PENDLE_UNSAFE_TX` otherwise.
 */
export function assertReflectRouteSafe(
  intent: PendleReflectIntent,
  response: PendleConvertResponse,
  route: PendleConvertRoute,
): PendleConvertRoute {
  // 1. Router pin.
  if (requireAddress(route.tx.to, "tx.to") !== PENDLE_ROUTER) {
    return unsafe("transaction target is not the pinned Pendle Router");
  }

  // 2. Sender bind.
  if (route.tx.from !== null && route.tx.from !== "") {
    if (requireAddress(route.tx.from, "tx.from") !== getAddress(intent.wallet)) {
      return unsafe("transaction sender is not the session wallet");
    }
  }

  // 3. Value bind — a reflect action spends an ERC20 position token, never native.
  const rawValue = route.tx.value;
  const value = typeof rawValue === "string" && rawValue !== "" ? BigInt(rawValue) : 0n;
  if (value !== 0n) return unsafe("a reflect route must not send native value");

  // 4. Approvals bind (response-level).
  assertReflectApprovals(intent, response);

  // 5. Reflector pin — fails CLOSED on a chain whose reflector we never measured.
  const pinned = pendleReflectorFor(intent.chainId);
  if (pinned === undefined) {
    return unsafe(`no reflector has been measured for chain ${intent.chainId}`);
  }
  const reflect = decodeReflectCall(route.tx.data);
  if (reflect.reflector !== pinned) {
    return unsafe("transaction reflector is not the one pinned for this chain");
  }

  // 6. Per-leg calldata bind.
  if (reflect.legs.length !== intent.expectedLegMarkets.length) {
    return unsafe("the transaction carries a different number of legs than the quote");
  }
  reflect.legs.forEach((leg, index) => {
    if (!reflectLegReceiverIsAllowed(index, leg.receiver, getAddress(intent.wallet), pinned)) {
      return unsafe(`reflect leg ${index + 1} pays out to neither the session wallet nor the reflector`);
    }
    if (leg.marketOrYt !== getAddress(intent.expectedLegMarkets[index]!)) {
      return unsafe(`reflect leg ${index + 1} market does not match the quote`);
    }
    // Only leg 1 spends the amount the caller authorised; later legs spend an
    // intermediate amount the quote never reports.
    if (index === 0 && leg.spendWei !== intent.inputAmountWei) {
      return unsafe("transaction spend amount does not match the quoted input");
    }
  });

  // 7. Echo cross-check.
  assertReflectEcho(route, pinned, reflect.legs);

  // 8. PRICE FLOOR — last. Every leg must own a binding row first: a leg whose
  //    minimum we cannot even locate is unbound, and an unbound leg is never
  //    signed.
  for (const [index, leg] of reflect.legs.entries()) {
    const bindings = PENDLE_MIN_OUT_BINDINGS[leg.method];
    if (bindings === undefined || bindings.length === 0) {
      return unsafe(`price_floor: reflect leg ${index + 1} (${leg.method}) has no minimum-output binding`);
    }
  }
  assertReflectFloorBound(reflect, route, intent.slippageBps);

  return route;
}

/**
 * Pick the SAFEST usable reflect route: the first route (best-ranked by Pendle)
 * that passes every fund-safety check. Throws `PENDLE_UNSAFE_TX` when none is
 * safe — it NEVER falls back to an unchecked route, exactly like
 * `selectSafeRoute`.
 */
export function selectSafeReflectRoute(
  intent: PendleReflectIntent,
  response: PendleConvertResponse,
): PendleConvertRoute {
  let lastErr: unknown;
  for (const route of response.routes) {
    try {
      return assertReflectRouteSafe(intent, response, route);
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr instanceof VexError) throw lastErr;
  return unsafe("no reflect route passed the fund-safety checks");
}
