import { ErrorCodes, VexError } from "../../errors.js";
import type {
  LighterOrderTimeInForce,
  LighterOrderType,
} from "./order-preview.js";

export const LIGHTER_PHASE_ONE_ORDER_TYPES = [
  "limit",
  "market",
  "stop-loss",
  "stop-loss-limit",
  "take-profit",
  "take-profit-limit",
] as const;
export const LIGHTER_PHASE_ONE_TIME_IN_FORCE = [
  "good-till-time",
  "immediate-or-cancel",
  "post-only",
] as const;

const PHASE_ONE_ORDER_POLICY_REASON =
  "Unsupported Lighter order type and time-in-force combination. Vex permits limit, stop-loss-limit, and take-profit-limit orders with immediate-or-cancel, good-till-time, or post-only; and market, stop-loss, and take-profit orders with immediate-or-cancel. "
  + "TWAP and other order families remain unavailable.";

const LIGHTER_ALLOWED_CREATE_ORDER_TUPLES = new Set<string>([
  "limit:immediate-or-cancel",
  "limit:good-till-time",
  "limit:post-only",
  "market:immediate-or-cancel",
  "stop-loss:immediate-or-cancel",
  "stop-loss-limit:immediate-or-cancel",
  "stop-loss-limit:good-till-time",
  "stop-loss-limit:post-only",
  "take-profit:immediate-or-cancel",
  "take-profit-limit:immediate-or-cancel",
  "take-profit-limit:good-till-time",
  "take-profit-limit:post-only",
]);

export function lighterPhaseOneOrderPolicyFailure(
  orderType: LighterOrderType,
  timeInForce: LighterOrderTimeInForce,
): string | null {
  return LIGHTER_ALLOWED_CREATE_ORDER_TUPLES.has(`${orderType}:${timeInForce}`)
    ? null
    : PHASE_ONE_ORDER_POLICY_REASON;
}

export function assertLighterPhaseOneOrderPolicy(
  orderType: LighterOrderType,
  timeInForce: LighterOrderTimeInForce,
): void {
  const reason = lighterPhaseOneOrderPolicyFailure(orderType, timeInForce);
  if (reason === null) return;
  throw new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `${reason} No order was signed or submitted.`,
    "Create a fresh Lighter order preview with an explicitly supported order type and time in force.",
  );
}
