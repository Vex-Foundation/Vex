/**
 * Pendle Convert ROUTE binding — is this calldata the trade the caller asked
 * for, at a price they authorised?
 *
 * Extracted from `../calldata.ts` (R5a). Decoding lives in `./decode.ts`, the
 * price floor in `./price-floor.ts`, and the income-sweep claim in
 * `./bind-claim.ts`; this module owns only the intent↔route comparison.
 *
 * Checks (fail → ZERO approve, ZERO send):
 *   1. Router pin       : tx.to === PENDLE_ROUTER (checksummed).
 *   2. Sender bind      : tx.from absent OR equals the session wallet.
 *   3. Value bind       : tx.value present+non-zero ONLY for native input; the
 *                         value must equal the input amount. Non-native → absent/0.
 *   4. Approvals bind   : requiredApprovals EXACTLY match the expected set and
 *                         contain NOTHING else — buy/sell AND py-mint: the single
 *                         input token at the input amount (native → empty);
 *                         redeem AND py-redeem: the {YT, PT} pair (Convert asks
 *                         both), each at the input amount. SY wrap/unwrap take
 *                         the single-input rule too: mint approves the payment
 *                         token, redeem approves the SY. Spender is IMPLICIT =
 *                         the pinned Router.
 *   5. Calldata bind    : FULL `decodeFunctionData` against the complete Router
 *                         ABI and assert EVERY intent-relevant param — the
 *                         method is valid for the action, the decoded receiver
 *                         is the session wallet, the decoded market/YT is the
 *                         quoted one, and the ACTUAL spend inside the dynamic
 *                         tuples binds. The echoed contractParamInfo is
 *                         cross-checked against the DECODED values so a spoofed
 *                         echo is caught too.
 *   6. PRICE FLOOR      : the route's own embedded minimum-output must clear the
 *                         floor its own quoted outputs imply at the caller's
 *                         slippage (R5a — see `./price-floor.ts`). Checked LAST,
 *                         so a tampered route is reported as tampering rather
 *                         than as a price problem.
 */

import { getAddress, type Address } from "viem";

import { VexError } from "../../../../../errors.js";
import { PENDLE_NATIVE_TOKEN, PENDLE_ROUTER, type PendleRouterMethod } from "@tools/pendle/constants.js";
import type { PendleConvertResponse, PendleConvertRoute } from "@tools/pendle/types.js";

import { decodeRouterCall, requireAddress, unsafe } from "./decode.js";
import { assertRouteFloorBound } from "./price-floor.js";

export type PendleAction =
  | "buy"
  | "sell"
  | "yt-buy"
  | "yt-sell"
  | "redeem"
  // PY mint (token → PT+YT) and PRE-EXPIRY PY redeem (PT+YT → token). Distinct
  // from the matured-PT `redeem` (PT only, redeemPyToToken OR redeemPyToSy):
  // py-redeem is redeemPyToToken ONLY and burns an EQUAL PT+YT pair (approves
  // both), while py-mint acquires the pair (approves only the input token).
  | "py-mint"
  | "py-redeem"
  // LP single-token add (token → LP) and remove (LP → token). Both bind arg1 ==
  // the MARKET (which IS the LP token). Add approves the INPUT token and carries
  // a TokenInput (like a buy); remove approves the LP/MARKET token and carries a
  // TokenOutput (like a sell), with the LP amount as the actual spend.
  | "lp-add"
  | "lp-remove"
  // The DUAL liquidity pair, R5d. Both are plain single-leg routes with TWO
  // declared outputs: `lp-remove-dual` burns LP into (token, PT) and
  // `lp-add-keep-yt` deposits a token into (LP, YT). They are SEPARATE actions
  // from `lp-add`/`lp-remove` rather than extra methods on them: the keep-YT add
  // reports the SAME Convert action string as a plain add (`"add-liquidity"`),
  // so the METHOD row below is the only thing that stops a plain-add route from
  // satisfying a keep-YT intent, and each carries its own two-field price floor.
  | "lp-remove-dual"
  | "lp-add-keep-yt"
  // SY wrap (token → SY) and unwrap (SY → token), R5d. Unlike every action
  // above, these belong to NO market: an SY has no maturity, no PT and no YT,
  // so arg 1 is the SY CONTRACT and is bound against `expectedSy`.
  | "sy-mint"
  | "sy-redeem"
  // LP → PT in one shot, R5d. Live-probed 2026-07-28 as a PLAIN single-leg
  // `removeLiquiditySinglePt` — NOT a `callAndReflect` action, despite sharing a
  // family with the two below — so it is bound right here like any other
  // single-leg route, with `minPtOut` at arg 3.
  | "lp-to-pt"
  // The two `callAndReflect` actions, R5d. Their calldata is a multi-leg wrapper
  // that `decodeRouterCall` cannot read, so they are bound by
  // `./bind-reflect.ts`, NOT here. They appear in this union only so a single
  // `PendleAction` names every write action; see ACTION_METHODS.
  | "pt-rollover"
  | "lp-transfer";

export interface PendleTxIntent {
  action: PendleAction;
  /** Session wallet — the ONLY allowed receiver + sender. */
  wallet: Address;
  /** Input token (native sentinel for native ETH input). */
  inputToken: Address;
  /** Input amount in wei (matches Convert `inputs[0].amount`). */
  inputAmountWei: bigint;
  isNative: boolean;
  /**
   * The tolerance this trade was QUOTED at, in whole basis points — the same
   * value sent to Convert as `slippage`, and the basis of the price floor.
   *
   * REQUIRED, deliberately. Making it optional would let a caller construct an
   * intent that silently skips the floor, which is the defect R5a exists to
   * close; the compiler now forces every broadcast path to declare the tolerance
   * it is holding the route to. Already policy-checked upstream by
   * `handlers/shared.ts`'s `resolvePendleSlippage` (rejected, never clamped).
   */
  slippageBps: number;
  /** Buy/sell: the PT's canonical market. Asserted against the decoded market. */
  expectedMarket?: Address;
  /** Redeem: the PT's canonical YT. Asserted against the decoded YT. */
  expectedYt?: Address;
  /** PT contract — part of the redeem approval set. */
  ptAddress?: Address;
  /** Sell/redeem: the quoted output token — asserted against TokenOutput.tokenOut. */
  expectedOutputToken?: Address;
  /** SY wrap/unwrap: the SY contract the caller named. Asserted against arg 1. */
  expectedSy?: Address;
}

/** Method(s) a given action may legitimately carry. */
const ACTION_METHODS: Record<PendleAction, readonly PendleRouterMethod[]> = {
  buy: ["swapExactTokenForPt"],
  sell: ["swapExactPtForToken"],
  // YT buy/sell reuse the PT swap-route validation with their own methods
  // (IPActionSwapYTV3 — identical ApproxParams/TokenInput/TokenOutput layout).
  "yt-buy": ["swapExactTokenForYt"],
  "yt-sell": ["swapExactYtForToken"],
  redeem: ["redeemPyToToken", "redeemPyToSy"],
  // PY mint is mintPyFromToken ONLY; pre-expiry PY redeem is redeemPyToToken ONLY
  // (never the SY fallback — that is the matured-PT `redeem` path).
  "py-mint": ["mintPyFromToken"],
  "py-redeem": ["redeemPyToToken"],
  // LP single-token add/remove each carry their OWN method (never a swap).
  "lp-add": ["addLiquiditySingleToken"],
  "lp-remove": ["removeLiquiditySingleToken"],
  // The dual pair each carry their OWN method. A plain `addLiquiditySingleToken`
  // can therefore never satisfy a keep-YT intent even though Convert labels both
  // routes `"add-liquidity"`, and a single-token remove can never satisfy a dual
  // remove.
  "lp-remove-dual": ["removeLiquidityDualTokenAndPt"],
  "lp-add-keep-yt": ["addLiquiditySingleTokenKeepYt"],
  // SY wrap/unwrap each carry their OWN method — never a swap, never a mint-py.
  "sy-mint": ["mintSyFromToken"],
  "sy-redeem": ["redeemSyToToken"],
  // LP → PT carries its OWN single-leg method.
  "lp-to-pt": ["removeLiquiditySinglePt"],
  // EMPTY BY DESIGN, not by omission. `pt-rollover` and `lp-transfer` are
  // `callAndReflect` bodies; `callAndReflect` is not a PendleRouterMethod and can
  // never decode here. An empty row means NO single-leg method is valid for these
  // actions, so routing one through `assertRouteSafe` refuses instead of binding
  // it loosely. `./bind-reflect.ts` owns them.
  "pt-rollover": [],
  "lp-transfer": [],
};

// ── Approval-set binding ────────────────────────────────────────────

function assertApprovals(intent: PendleTxIntent, response: PendleConvertResponse): void {
  const approvals = response.requiredApprovals;
  const amount = intent.inputAmountWei.toString();

  // Matured redeem AND pre-expiry py-redeem burn the PT+YT pair, so Convert asks
  // for allowances on BOTH — the set must be EXACTLY {YT, PT}, each at the input
  // amount, and nothing else.
  if (intent.action === "redeem" || intent.action === "py-redeem") {
    const yt = intent.expectedYt ? getAddress(intent.expectedYt) : null;
    const pt = intent.ptAddress ? getAddress(intent.ptAddress) : null;
    if (!yt || !pt) return unsafe("redeem approval check missing PT/YT");
    const allowed = new Set([yt, pt]);
    const seen = new Set<string>();
    for (const a of approvals) {
      const token = requireAddress(a.token, "approval token");
      if (!allowed.has(token)) return unsafe("an approval targets an unexpected token");
      if (seen.has(token)) return unsafe("duplicate approval token");
      if (a.amount !== amount) return unsafe("an approval amount does not match the input");
      seen.add(token);
    }
    return;
  }

  // Buy/sell AND py-mint: native input needs no approval; otherwise EXACTLY one,
  // for the input token, at the input amount, and nothing else.
  if (intent.isNative) {
    if (approvals.length !== 0) return unsafe("native input must not require any token approval");
    return;
  }
  if (approvals.length !== 1) return unsafe("expected exactly one token approval");
  const only = approvals[0]!;
  if (requireAddress(only.token, "approval token") !== getAddress(intent.inputToken)) {
    return unsafe("the approval targets a token other than the input");
  }
  if (only.amount !== amount) return unsafe("the approval amount does not match the input");
}

// ── Route validation ────────────────────────────────────────────────

/**
 * Validate ONE Convert route against the intent. Returns the route when safe;
 * throws `PENDLE_UNSAFE_TX` otherwise. `response` carries the requiredApprovals
 * (approvals are response-level, not per-route).
 */
export function assertRouteSafe(
  intent: PendleTxIntent,
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

  // 3. Value bind. A missing/empty value (some responses omit it) is zero native.
  const rawValue = route.tx.value;
  const value = typeof rawValue === "string" && rawValue !== "" ? BigInt(rawValue) : 0n;
  if (intent.isNative) {
    if (value !== intent.inputAmountWei) return unsafe("native value does not match the input amount");
  } else if (value !== 0n) {
    return unsafe("a non-native trade must not send native value");
  }

  // 4. Approvals bind (response-level).
  assertApprovals(intent, response);

  // 5. Calldata bind — FULL decode; every intent-relevant param asserted.
  const call = decodeRouterCall(route.tx.data);
  if (!ACTION_METHODS[intent.action].includes(call.method)) {
    return unsafe(`transaction method ${call.method} is not valid for a ${intent.action}`);
  }
  if (call.receiver !== getAddress(intent.wallet)) {
    return unsafe("transaction receiver is not the session wallet");
  }
  // Redeem, py-redeem AND py-mint all carry the YT at arg 1 (mint/redeem operate
  // on the market's YT, not the market/LP address); the swaps AND the LP add/remove
  // carry the market at arg 1, bound against intent.expectedMarket.
  const bindsYt =
    intent.action === "redeem" || intent.action === "py-redeem" || intent.action === "py-mint";
  const bindsSy = intent.action === "sy-mint" || intent.action === "sy-redeem";
  const expectedTarget = bindsSy
    ? intent.expectedSy
    : bindsYt
      ? intent.expectedYt
      : intent.expectedMarket;
  if (expectedTarget && call.marketOrYt !== getAddress(expectedTarget)) {
    return unsafe(
      bindsSy
        ? "transaction SY does not match the one requested"
        : bindsYt
          ? "transaction YT does not match the position"
          : "transaction market does not match the quote",
    );
  }

  // The ACTUAL spend inside the calldata must equal the intent amount — an
  // inflated netTokenIn/exactPtIn/netPyIn can never reach a signature.
  if (call.spendWei !== intent.inputAmountWei) {
    return unsafe("transaction spend amount does not match the quoted input");
  }
  // Buy (PT or YT), py-mint AND lp-add: the tuple's spend token must be the intent
  // input (zero addr for native). swapExactTokenForPt, swapExactTokenForYt,
  // mintPyFromToken and addLiquiditySingleToken all carry TokenInput.
  if (
    call.method === "swapExactTokenForPt" ||
    call.method === "swapExactTokenForYt" ||
    call.method === "mintPyFromToken" ||
    call.method === "addLiquiditySingleToken" ||
    call.method === "addLiquiditySingleTokenKeepYt" ||
    call.method === "mintSyFromToken"
  ) {
    const expectedIn = intent.isNative ? PENDLE_NATIVE_TOKEN : getAddress(intent.inputToken);
    if (!call.input || call.input.token !== expectedIn) {
      return unsafe("transaction input token does not match the quoted input");
    }
  }
  // Sell / redeemPyToToken / lp-remove / sy-redeem: the tuple's output token must
  // be the quoted output (removeLiquiditySingleToken and redeemSyToToken also
  // carry a TokenOutput).
  if (call.output && intent.expectedOutputToken) {
    if (call.output.token !== getAddress(intent.expectedOutputToken)) {
      return unsafe("transaction output token does not match the quote");
    }
  }

  // Cross-check the echoed contractParamInfo against the DECODED values so a
  // spoofed echo cannot mislead downstream logging/UX.
  const params = route.contractParamInfo.contractCallParams;
  const echoReceiver = typeof params[0] === "string" ? params[0] : "";
  const echoTarget = typeof params[1] === "string" ? params[1] : "";
  if (echoReceiver !== "" && requireAddress(echoReceiver, "echoed receiver") !== call.receiver) {
    return unsafe("echoed receiver disagrees with the calldata");
  }
  if (echoTarget !== "" && requireAddress(echoTarget, "echoed market/YT") !== call.marketOrYt) {
    return unsafe("echoed market/YT disagrees with the calldata");
  }

  // 6. Price floor — LAST, so a tampered route is reported as tampering. No
  //    route reaches a signature unbound: the intent's `slippageBps` is
  //    required, so there is no path through here without a floor.
  assertRouteFloorBound(call, route, intent.slippageBps);

  return route;
}

/**
 * Pick the SAFEST usable route from a Convert response for the intent: the first
 * route (best-ranked by Pendle) that passes every fund-safety check. Throws
 * `PENDLE_UNSAFE_TX` when none is safe (never falls back to an unchecked route).
 */
export function selectSafeRoute(
  intent: PendleTxIntent,
  response: PendleConvertResponse,
): PendleConvertRoute {
  let lastErr: unknown;
  for (const route of response.routes) {
    try {
      return assertRouteSafe(intent, response, route);
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr instanceof VexError) throw lastErr;
  return unsafe("no route passed the fund-safety checks");
}
