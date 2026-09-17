/**
 * Lighter desk lane - `vex:lighterTrading:prepareDeskAction`.
 *
 * The desk's own buttons (ticket Long/Short, position Close, order Cancel)
 * send a selector, never terms to sign. Main maps the selector onto the same
 * Lighter prepare tools the AI lane calls, and the engine enqueues an
 * approval with origin `desk`. The renderer then shows the usual card; the
 * order is signed only when the user confirms it, through the ordinary
 * approve handler. No model turn is involved anywhere on this path.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  lighterDeskPrepareInputSchema,
  lighterDeskPrepareResultSchema,
  type LighterDeskAction,
  type LighterDeskPrepareResult,
} from "@shared/schemas/lighter-trading.js";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import { log } from "../logger/index.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { registerHandler } from "./register-handler.js";
import { approvalsUnexpectedError } from "./approvals/_errors.js";

/** Market close walks the book at most this far; the AI lane's usual default. */
const CLOSE_SLIPPAGE_BPS = 100;
/** Protective orders rest for a day; a market entry's IOC only needs minutes. */
const PROTECTIVE_EXPIRY_MINUTES = 1440;
const MARKET_EXPIRY_MINUTES = 30;

export type DeskPrepareCall = {
  readonly toolId:
    | "lighter.order.preview"
    | "lighter.position.protect"
    | "lighter.position.close.prepare"
    | "lighter.order.cancel.prepare";
  readonly params: Record<string, unknown>;
};

/**
 * Selector -> prepare-tool call. Mirrors what the ticket used to spell out in
 * a chat message, so the AI lane and the desk lane hand the tools the same
 * terms for the same draft.
 */
export function deskActionToPrepareCall(
  environment: LighterIntegrationEnvironment,
  action: LighterDeskAction,
): DeskPrepareCall {
  switch (action.kind) {
    case "close":
      return {
        toolId: "lighter.position.close.prepare",
        params: {
          environment,
          marketId: action.marketId,
          slippageBps: CLOSE_SLIPPAGE_BPS,
        },
      };
    case "cancel":
      return {
        toolId: "lighter.order.cancel.prepare",
        params: {
          environment,
          marketId: action.marketId,
          orderId: action.orderId,
        },
      };
    case "order": {
      const { draft } = action;
      const base = {
        environment,
        marketId: action.marketId,
        side: draft.side,
        baseAmountIn: draft.baseAmount,
      };
      switch (draft.mode) {
        case "market":
          return {
            toolId: "lighter.order.preview",
            params: {
              ...base,
              orderType: "market",
              timeInForce: "immediate-or-cancel",
              price: draft.worstPrice,
              reduceOnly: draft.reduceOnly,
              orderExpiryOffsetMinutes: MARKET_EXPIRY_MINUTES,
            },
          };
        case "limit":
          return {
            toolId: "lighter.order.preview",
            params: {
              ...base,
              orderType: "limit",
              timeInForce: draft.timeInForce,
              price: draft.limitPrice,
              reduceOnly: draft.reduceOnly,
              orderExpiryOffsetMinutes: draft.orderExpiryOffsetMinutes,
            },
          };
        case "stop-loss":
        case "take-profit":
          return {
            toolId: "lighter.order.preview",
            params: {
              ...base,
              orderType: draft.mode,
              timeInForce: "immediate-or-cancel",
              price: draft.worstPrice,
              triggerPrice: draft.triggerPrice,
              reduceOnly: true,
              orderExpiryOffsetMinutes: PROTECTIVE_EXPIRY_MINUTES,
            },
          };
        case "stop-loss-limit":
        case "take-profit-limit":
          return {
            toolId: "lighter.order.preview",
            params: {
              ...base,
              orderType: draft.mode,
              timeInForce: draft.timeInForce,
              price: draft.limitPrice,
              triggerPrice: draft.triggerPrice,
              reduceOnly: true,
              orderExpiryOffsetMinutes: draft.orderExpiryOffsetMinutes,
            },
          };
        case "oco":
          return {
            toolId: "lighter.position.protect",
            params: {
              ...base,
              stopLossTriggerPrice: draft.stopLossTriggerPrice,
              stopLossPrice: draft.stopLossPrice,
              takeProfitTriggerPrice: draft.takeProfitTriggerPrice,
              takeProfitPrice: draft.takeProfitPrice,
              orderExpiryOffsetMinutes: PROTECTIVE_EXPIRY_MINUTES,
            },
          };
      }
    }
  }
}

export function registerLighterDeskHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.lighterTrading.prepareDeskAction,
      domain: "approvals",
      inputSchema: lighterDeskPrepareInputSchema,
      outputSchema: lighterDeskPrepareResultSchema,
      handle: async (input, ctx): Promise<Result<LighterDeskPrepareResult>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;

        try {
          const { prepareDeskApproval } = await import(
            "@vex-agent/engine/core/approval-runtime.js"
          );
          const call = deskActionToPrepareCall(input.environment, input.action);
          const outcome = await prepareDeskApproval({
            sessionId: input.sessionId,
            toolId: call.toolId,
            params: call.params,
          });
          log.info(
            `[ipc:vex:lighterTrading:prepareDeskAction] ${outcome.kind} ` +
              `action=${input.action.kind} tool=${call.toolId} correlationId=${ctx.requestId}`,
          );
          return ok(outcome);
        } catch (cause) {
          log.error(
            `[ipc:vex:lighterTrading:prepareDeskAction] unexpected ` +
              `action=${input.action.kind} correlationId=${ctx.requestId}`,
            cause,
          );
          return err(approvalsUnexpectedError(ctx.requestId));
        }
      },
    }),
  ];
}
