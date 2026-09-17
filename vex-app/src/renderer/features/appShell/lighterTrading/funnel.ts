import type { LighterFunnelStep } from "@shared/schemas/telemetry.js";
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";

/**
 * Count one step of the Lighter desk funnel: banner click, desk entry, a
 * desk card enqueued, a desk card approved. Fire and forget; main checks the
 * Sentry consent and drops the step for anyone who never opted in. A failed
 * report never reaches the desk, telemetry is not something it waits on; the
 * bridge is optional-chained the way `renderer-error-report` does it.
 */
export function recordFunnelStep(step: LighterFunnelStep, environment: LighterTradingEnvironment): void {
  void window.vex?.telemetry?.funnelStep({ step, environment }).catch(() => undefined);
}
