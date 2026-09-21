import type { LighterFunnelStep } from "@shared/schemas/telemetry.js";
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";

/**
 * Count one privacy-safe Lighter journey transition, from desk entry through
 * setup, approval, provider acceptance and the terminal order outcome. Fire
 * and forget; main checks Sentry consent and drops the step for anyone who
 * never opted in. Telemetry never blocks the desk.
 */
export function recordFunnelStep(step: LighterFunnelStep, environment: LighterTradingEnvironment): void {
  void window.vex?.telemetry?.funnelStep({ step, environment }).catch(() => undefined);
}
