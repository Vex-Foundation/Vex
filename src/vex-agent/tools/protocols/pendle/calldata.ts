/**
 * Pendle broadcast fund-safety extractor — PUBLIC BARREL.
 *
 * Before ANY Pendle broadcast, the chosen Convert route (or claim) is validated
 * against the caller's intent. Nothing is signed unless EVERY check passes; a
 * failure throws `PENDLE_UNSAFE_TX` (our own fixed text — the upstream body
 * never leaks here).
 *
 * The implementation was split by responsibility in R5a; this file keeps the
 * public contract so every existing import continues to resolve unchanged.
 * Reach for the module that owns what you are changing:
 *
 *   ./calldata/decode.ts      — "what does this calldata actually say?"
 *                               FULL ABI decode, the limit-fill and pendleSwap
 *                               invariants, and the recursive `callAndReflect`
 *                               walk.
 *   ./calldata/bind-route.ts  — "is this the trade the caller asked for?"
 *                               Router pin, sender/value/approval binds, the
 *                               intent↔calldata comparison, route selection.
 *   ./calldata/bind-reflect.ts— the same question for a `callAndReflect` body:
 *                               the per-chain reflector pin, the per-leg
 *                               receiver/market/spend binds, and the reflect
 *                               echo cross-check.
 *   ./calldata/price-floor.ts — "at a price they authorised?" The per-selector,
 *                               per-field minimum-output binding table, the
 *                               floor arithmetic, and the `price_floor` refusal.
 *   ./calldata/bind-claim.ts  — the income-sweep claim, which has its own ABI,
 *                               its own response shape, and no route at all.
 */

// `unsafe` / `requireAddress` are deliberately NOT re-exported: they are the
// refusal vocabulary the binding modules share, not part of the contract a
// handler should reach for. Import them from `./calldata/decode.js` inside the
// feature if you are adding a binding.
export {
  decodeReflectCall,
  decodeRouterCall,
  type DecodedReflectCall,
  type DecodedRouterCall,
  type TokenTupleBind,
} from "./calldata/decode.js";

export {
  assertRouteSafe,
  selectSafeRoute,
  type PendleAction,
  type PendleTxIntent,
} from "./calldata/bind-route.js";

export {
  assertReflectRouteSafe,
  selectSafeReflectRoute,
  type PendleReflectAction,
  type PendleReflectIntent,
} from "./calldata/bind-reflect.js";

export {
  PENDLE_FLOOR_ALLOWANCE_RAW,
  PENDLE_MIN_OUT_BINDINGS,
  assertReflectFloorBound,
  assertRouteFloorBound,
  computePendleFloorRaw,
  reflectLegReceiverIsAllowed,
  type PendleMinOutBinding,
  type PendleMinOutCoverage,
  type PendleMinOutLocation,
} from "./calldata/price-floor.js";

export {
  assertClaimSafe,
  decodeClaimCall,
  type DecodedClaimCall,
  type DecodedClaimYt,
  type PendleClaimIntent,
  type PendleClaimYtBind,
} from "./calldata/bind-claim.js";
