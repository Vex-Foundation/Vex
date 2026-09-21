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
import { getPendingForSession } from "@vex-agent/db/repos/lighter-setup-interactions.js";
import { log } from "../logger/index.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { getSessionById } from "../database/sessions-db.js";
import { registerHandler } from "./register-handler.js";
import { approvalsUnexpectedError } from "./approvals/_errors.js";

/** Market close walks the book at most this far; the AI lane's usual default. */
const CLOSE_SLIPPAGE_BPS = 100;
/** Protective orders rest for a day; a market entry's IOC only needs minutes. */
const PROTECTIVE_EXPIRY_MINUTES = 1440;
const MARKET_EXPIRY_MINUTES = 30;

/**
 * The account-setup chain the agent shell can also drive. A Lighter setup
 * handoff parks an agent-shell session on the same modal the desk shows
 * (`AgentLighterSetupHost`), and that session has no workspace, so the
 * workspace check alone would refuse the three onboarding steps it exists to
 * run. Nothing else crosses: an order, a close or a cancel still needs a desk
 * session.
 */
const ONBOARDING_ACTION_KINDS: ReadonlySet<LighterDeskAction["kind"]> = new Set([
  "onboarding_deposit",
  "onboarding_key",
  "onboarding_fee",
]);

export type DeskPrepareCall = {
  readonly toolId:
    | "lighter.order.preview"
    | "lighter.position.protect"
    | "lighter.position.close.prepare"
    | "lighter.order.cancel.prepare"
    | "lighter.deposit.prepare"
    | "lighter.key.register.prepare"
    | "lighter.fees.approve.prepare";
  readonly params: Record<string, unknown>;
};

/**
 * A rapid second click must join the first prepare, not create a second
 * approval card that could later be approved into a duplicate order. This is
 * deliberately an in-process, in-flight key: a later deliberate submission
 * still creates a fresh approval and re-reads the live market.
 */
const deskPrepareFlights = new Map<string, Promise<LighterDeskPrepareResult>>();

function deskPrepareKey(input: {
  readonly sessionId: string;
  readonly environment: LighterIntegrationEnvironment;
  readonly action: LighterDeskAction;
}): string {
  const { action } = input;
  switch (action.kind) {
    case "close":
      return `${input.sessionId}|${input.environment}|close|${action.marketId}`;
    case "cancel":
      return `${input.sessionId}|${input.environment}|cancel|${action.marketId}|${action.orderId}`;
    case "onboarding_deposit":
      return `${input.sessionId}|${input.environment}|onboarding_deposit|${action.amountIn}`;
    case "onboarding_key":
      return `${input.sessionId}|${input.environment}|onboarding_key`;
    case "onboarding_fee":
      return `${input.sessionId}|${input.environment}|onboarding_fee`;
    case "order":
      // Every draft field is a scalar after the strict schema parse. Sorting
      // makes equivalent IPC objects share a key even when their property
      // insertion order differed before they reached main.
      return JSON.stringify([
        input.sessionId,
        input.environment,
        "order",
        action.marketId,
        Object.entries(action.draft).sort(([left], [right]) => left.localeCompare(right)),
      ]);
  }
}

function prepareDeskOnce(
  input: {
    readonly sessionId: string;
    readonly environment: LighterIntegrationEnvironment;
    readonly action: LighterDeskAction;
  },
): Promise<LighterDeskPrepareResult> {
  const key = deskPrepareKey(input);
  const existing = deskPrepareFlights.get(key);
  if (existing !== undefined) return existing;

  const call = deskActionToPrepareCall(input.environment, input.action);
  const flight = import("@vex-agent/engine/core/approval-runtime.js")
    .then(({ prepareDeskApproval }) => prepareDeskApproval({
      sessionId: input.sessionId,
      toolId: call.toolId,
      params: call.params,
    }));
  deskPrepareFlights.set(key, flight);
  const clear = (): void => {
    if (deskPrepareFlights.get(key) === flight) deskPrepareFlights.delete(key);
  };
  void flight.then(clear, clear);
  return flight;
}

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
    case "onboarding_deposit":
      return {
        toolId: "lighter.deposit.prepare",
        params: { environment, amountIn: action.amountIn },
      };
    case "onboarding_key":
      return { toolId: "lighter.key.register.prepare", params: { environment } };
    case "onboarding_fee":
      return { toolId: "lighter.fees.approve.prepare", params: { environment } };
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

const WRONG_SESSION: LighterDeskPrepareResult = {
  kind: "refused",
  reason: "This action is only available from a Lighter desk session.",
};

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

        const session = await getSessionById(input.sessionId);
        if (!session.ok) return session;
        if (session.data === null) return ok(WRONG_SESSION);
        // A desk session may prepare anything on the list, and reaches the
        // in-flight join below without a further await - a second click must
        // still find the first flight. Any other session gets the extra read.
        if (session.data.workspace !== "lighter") {
          if (!ONBOARDING_ACTION_KINDS.has(input.action.kind)) return ok(WRONG_SESSION);
          const pending = await getPendingForSession(input.sessionId);
          if (pending === null || pending.environment !== input.environment) {
            return ok(WRONG_SESSION);
          }
        }

        try {
          const call = deskActionToPrepareCall(input.environment, input.action);
          const outcome = await prepareDeskOnce(input);
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
