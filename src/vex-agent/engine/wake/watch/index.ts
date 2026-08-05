/**
 * Built-in `loop_defer` wake-watch evaluators — the one place that decides
 * which watch types exist in production.
 *
 * Registration is IDEMPOTENT and is triggered from both ends of the watch's
 * life, because the two ends run independently:
 *
 *   - the `loop_defer` handler calls it before VALIDATING a condition (a
 *     defer can be dispatched in a process where the wake executor never
 *     started, e.g. a script or a test);
 *   - the wake watch promoter calls it before subscribing, so the TRIGGER side
 *     can dispatch by type even if no defer has been validated yet.
 *
 * `registerWakeWatchEvaluator` fails closed on a CONFLICTING registration and
 * is a no-op for the identical evaluator object, which is why the singletons
 * below are module-level constants rather than per-call factories.
 */

import { registerWakeWatchEvaluator } from "../watch-registry.js";
import {
  BRIDGE_ORDER_STATUS_WATCH_TYPE,
  createBridgeOrderStatusEvaluator,
} from "./bridge-order-status.js";

export { BRIDGE_ORDER_STATUS_WATCH_TYPE } from "./bridge-order-status.js";

const BUILT_IN_EVALUATORS = [createBridgeOrderStatusEvaluator()] as const;

/** Every watch type a `loop_defer` call may name. Used in refusal text. */
export const SUPPORTED_WAKE_WATCH_TYPES: readonly string[] = [
  BRIDGE_ORDER_STATUS_WATCH_TYPE,
];

export function registerBuiltInWakeWatchEvaluators(): void {
  for (const evaluator of BUILT_IN_EVALUATORS) {
    registerWakeWatchEvaluator(evaluator);
  }
}
