/**
 * Usage IPC handlers — read-only last-turn + session totals.
 *
 * Read-only handlers backed by `usage-db.ts`. Empty sessions resolve
 * to all-zero totals + `null` last turn — never an error shape.
 */

import { CH } from "@shared/ipc/channels.js";
import type { Result } from "@shared/ipc/result.js";
import {
  contextWindowInputSchema,
  contextWindowResultSchema,
  lastTurnUsageResultSchema,
  sessionUsageTotalsDtoSchema,
  usageInputSchema,
  type ContextWindowResult,
  type LastTurnUsageResult,
  type SessionUsageTotalsDto,
} from "@shared/schemas/usage.js";
import { AGENT_CONTEXT_LIMIT, parseAgentEnv } from "@vex-lib/agent-config.js";
// Main MAY import the engine (precedent: `main/market/dexscreener-pair.ts`).
// The pressure bands have exactly ONE owner — the engine policy module — and
// are carried to the renderer through the DTO rather than re-declared there.
import {
  PRESSURE_BARRIER_FRACTION,
  PRESSURE_CRITICAL_FRACTION,
  PRESSURE_WARNING_FRACTION,
} from "@vex-agent/engine/core/context-pressure-policy.js";
import {
  getContextWindow,
  getLastTurn,
  getSessionTotals,
} from "../database/usage-db.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

/**
 * Resolve the context limit the gauge divides by — the SAME number the engine
 * bands against, not the raw operator setting.
 *
 * `AGENT_CONTEXT_LIMIT` is a throttle, not a capability claim, and its default
 * (256_000) is larger than many real model windows. The engine clamps it to
 * the provider-reported window (`resolveEffectiveContextLimit`, applied while
 * loading the inference config), so reading the env here would show the user
 * "40% of 256k" on a 128k model while the engine was already at 80% of 131_072
 * and about to compact. The gauge and the bands must divide by one number.
 *
 * Source order:
 *   1. the loaded inference config's `contextLimit` — post-clamp, the truth;
 *   2. the env value, when no provider/config is available yet (onboarding,
 *      provider removed) — better than no gauge, and it is what the engine
 *      would use if the catalog window stayed unknown;
 *   3. `null` when `AGENT_CONTEXT_LIMIT` is invalid — the engine would reject
 *      it, so the gauge says "unavailable" rather than faking the default.
 */
async function resolveContextLimit(): Promise<number | null> {
  const parsed = parseAgentEnv(process.env);
  if (parsed.errors.some((e) => e.key === AGENT_CONTEXT_LIMIT.key)) return null;

  try {
    const { resolveProvider } = await import("@vex-agent/inference/registry.js");
    const provider = await resolveProvider();
    const config = await provider?.loadConfig();
    if (config) return config.contextLimit;
  } catch (cause) {
    // A catalog fetch failure must not remove the gauge — fall through to the
    // configured value, which is exactly what the engine falls back to when
    // the model window is unknown.
    log.warn("[ipc:vex:usage:getContextWindow] effective-limit read failed", cause);
  }
  return parsed.value.contextLimit;
}

function registerGetSessionTotalsHandler(): () => void {
  return registerHandler({
    channel: CH.usage.getSessionTotals,
    domain: "usage",
    inputSchema: usageInputSchema,
    outputSchema: sessionUsageTotalsDtoSchema,
    handle: async (input, ctx): Promise<Result<SessionUsageTotalsDto>> => {
      const outcome = await getSessionTotals(input.sessionId, input.currency);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:usage:getSessionTotals] ok sessionId=${input.sessionId} ` +
            `requests=${outcome.data.requestCount} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:usage:getSessionTotals] errCode=${outcome.error.code} ` +
          `correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

function registerGetLastTurnHandler(): () => void {
  return registerHandler({
    channel: CH.usage.getLastTurn,
    domain: "usage",
    inputSchema: usageInputSchema,
    outputSchema: lastTurnUsageResultSchema,
    handle: async (input, ctx): Promise<Result<LastTurnUsageResult>> => {
      const outcome = await getLastTurn(input.sessionId, input.currency);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:usage:getLastTurn] ok sessionId=${input.sessionId} ` +
            `present=${outcome.data !== null} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:usage:getLastTurn] errCode=${outcome.error.code} ` +
          `correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

function registerGetContextWindowHandler(): () => void {
  return registerHandler({
    channel: CH.usage.getContextWindow,
    domain: "usage",
    inputSchema: contextWindowInputSchema,
    outputSchema: contextWindowResultSchema,
    handle: async (input, ctx): Promise<Result<ContextWindowResult>> => {
      const contextLimit = await resolveContextLimit();
      const read = await getContextWindow(input.sessionId, contextLimit);
      // Stamp the engine's pressure bands onto a present window, so the
      // renderer's meter markers stay tied to the thresholds that actually
      // gate compaction. A `null` window (unknown/deleted session) stays null.
      const outcome: Result<ContextWindowResult> =
        read.ok && read.data !== null
          ? {
              ok: true,
              data: {
                ...read.data,
                pressureWarningFraction: PRESSURE_WARNING_FRACTION,
                pressureBarrierFraction: PRESSURE_BARRIER_FRACTION,
                pressureCriticalFraction: PRESSURE_CRITICAL_FRACTION,
              },
            }
          : read;
      if (outcome.ok) {
        log.info(
          `[ipc:vex:usage:getContextWindow] ok sessionId=${input.sessionId} ` +
            `present=${outcome.data !== null} limit=${contextLimit ?? "invalid"} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:usage:getContextWindow] errCode=${outcome.error.code} ` +
          `correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

export function registerUsageHandlers(): ReadonlyArray<() => void> {
  return [
    registerGetSessionTotalsHandler(),
    registerGetLastTurnHandler(),
    registerGetContextWindowHandler(),
  ];
}
