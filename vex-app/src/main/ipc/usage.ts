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
 * Resolve the effective global context limit the engine uses for
 * pressure bands, via the shared `@vex-lib/agent-config` source of truth
 * (no duplicated bounds/defaults here). Unset → engine default; valid →
 * the configured value; invalid `AGENT_CONTEXT_LIMIT` → `null` (the
 * engine would reject it, so we surface "unavailable" instead of faking
 * the default).
 */
function resolveContextLimit(): number | null {
  const parsed = parseAgentEnv(process.env);
  const invalid = parsed.errors.some((e) => e.key === AGENT_CONTEXT_LIMIT.key);
  return invalid ? null : parsed.value.contextLimit;
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
      const contextLimit = resolveContextLimit();
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
