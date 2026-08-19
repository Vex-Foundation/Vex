import { ErrorCodes, VexError } from "../../errors.js";
import type {
  LighterOrderTimeInForce,
  LighterOrderType,
} from "./order-preview.js";

export const LIGHTER_PHASE_ONE_ORDER_TYPES = ["market"] as const;
export const LIGHTER_PHASE_ONE_TIME_IN_FORCE = ["immediate-or-cancel"] as const;

const PHASE_ONE_ORDER_POLICY_REASON =
  "Lighter Phase 1 permits market orders with immediate-or-cancel time in force only. "
  + "Resting limit, good-till-time, and post-only orders remain unavailable until approval-gated cancel and modify both complete retained real-provider canaries.";

export function lighterPhaseOneOrderPolicyFailure(
  orderType: LighterOrderType,
  timeInForce: LighterOrderTimeInForce,
): string | null {
  return orderType === "market" && timeInForce === "immediate-or-cancel"
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
    "Create a fresh IOC market-order preview with an explicit worst acceptable price.",
  );
}
