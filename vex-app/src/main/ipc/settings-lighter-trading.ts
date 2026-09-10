/**
 * `vex.settings.*` handlers for the Lighter trading setup: the agent's capital
 * share, and the user's own leverage change.
 *
 * THIN ON PURPOSE. Every handler validates its input at the boundary, delegates
 * to the owner in `main/lighter/`, and maps failures to a sanitized `Result`.
 * No policy, no provider knowledge and no state machine lives here; those
 * belong to `leverage-preparation.ts` and `leverage-execution.ts`.
 *
 * A sibling module rather than more lines in `settings.ts`: that file is
 * already 623 lines with its own unrelated reasons to change (preferences,
 * telemetry consent, Superboard keys, credential cleanup), and this is the
 * pattern `settings-chain-endpoints.ts` established.
 *
 * The wallet address comes from the renderer's per-wallet card, as the Points
 * card does, and is VERIFIED against the install's own resolved Lighter
 * accounts by the owner below. It is never replaced by the primary wallet: this
 * section is per wallet, and silently applying leverage to a different wallet
 * than the one the person is looking at would be the worst possible outcome.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  applyLighterLeverageResultSchema,
  confirmLighterLeverageInputSchema,
  getLighterLeverageOverviewInputSchema,
  getLighterTradingLimitsInputSchema,
  lighterLeverageOverviewSchema,
  lighterLeverageProposalSchema,
  lighterTradingLimitsSchema,
  prepareLighterLeverageInputSchema,
  reconcileLighterLeverageInputSchema,
  setLighterTradingLimitsInputSchema,
  type ApplyLighterLeverageResult,
  type LighterLeverageOverview,
  type LighterLeverageProposal,
  type LighterTradingLimits,
} from "@shared/schemas/lighter-trading-limits.js";
import { ErrorCodes, VexError as EngineError } from "../../../../src/errors.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { log } from "../logger/index.js";
import { cancelledError, isAbortError } from "./cancel-helpers.js";
import { registerHandler } from "./register-handler.js";

export function registerLighterTradingSettingsHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.settings.getLighterTradingLimits,
      domain: "settings",
      inputSchema: getLighterTradingLimitsInputSchema,
      outputSchema: lighterTradingLimitsSchema,
      handle: async (input, ctx): Promise<Result<LighterTradingLimits>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { readLighterTradingLimits } = await import(
            "@vex-agent/db/repos/lighter-trading-limits.js"
          );
          const row = await readLighterTradingLimits(input.environment, input.walletAddress);
          // No row is a real answer, not an absence: no ceiling is configured,
          // and the first write must therefore carry `expectedRevision: null`.
          return ok(
            row === null
              ? {
                  environment: input.environment,
                  walletAddress: input.walletAddress,
                  agentCapitalSharePercent: null,
                  revision: null,
                }
              : {
                  environment: row.environment,
                  walletAddress: input.walletAddress,
                  agentCapitalSharePercent: row.agentCapitalSharePercent,
                  revision: row.revision,
                },
          );
        } catch (cause) {
          return err(failure("getLighterTradingLimits", cause, ctx.requestId));
        }
      },
    }),

    registerHandler({
      channel: CH.settings.setLighterTradingLimits,
      domain: "settings",
      inputSchema: setLighterTradingLimitsInputSchema,
      outputSchema: lighterTradingLimitsSchema,
      handle: async (input, ctx): Promise<Result<LighterTradingLimits>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { writeLighterTradingLimits } = await import(
            "@vex-agent/db/repos/lighter-trading-limits.js"
          );
          const row = await writeLighterTradingLimits(input);
          return ok({
            environment: row.environment,
            walletAddress: input.walletAddress,
            agentCapitalSharePercent: row.agentCapitalSharePercent,
            revision: row.revision,
          });
        } catch (cause) {
          return err(failure("setLighterTradingLimits", cause, ctx.requestId));
        }
      },
    }),

    registerHandler({
      channel: CH.settings.getLighterLeverageOverview,
      domain: "settings",
      inputSchema: getLighterLeverageOverviewInputSchema,
      outputSchema: lighterLeverageOverviewSchema,
      handle: async (input, ctx): Promise<Result<LighterLeverageOverview>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { getLighterLeverageOverview } = await import(
            "../lighter/leverage-preparation.js"
          );
          return ok(await getLighterLeverageOverview(input));
        } catch (cause) {
          if (isAbortError(cause)) return err(cancelledError("settings", ctx.requestId));
          return err(failure("getLighterLeverageOverview", cause, ctx.requestId));
        }
      },
    }),

    registerHandler({
      channel: CH.settings.prepareLighterLeverage,
      domain: "settings",
      inputSchema: prepareLighterLeverageInputSchema,
      outputSchema: lighterLeverageProposalSchema,
      handle: async (input, ctx): Promise<Result<LighterLeverageProposal>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { prepareLighterLeverage } = await import("../lighter/leverage-preparation.js");
          return ok(await prepareLighterLeverage(input));
        } catch (cause) {
          return err(failure("prepareLighterLeverage", cause, ctx.requestId));
        }
      },
    }),

    registerHandler({
      channel: CH.settings.confirmLighterLeverage,
      domain: "settings",
      inputSchema: confirmLighterLeverageInputSchema,
      outputSchema: applyLighterLeverageResultSchema,
      handle: async (input, ctx): Promise<Result<ApplyLighterLeverageResult>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { confirmLighterLeverage } = await import("../lighter/leverage-execution.js");
          // The renderer's cancellation IS this signal: it reaches the
          // executor's authority checks, which refuse BEFORE the reservation
          // and BEFORE submission. It can never cancel a transaction already
          // sent; that is what reconcile is for.
          return ok(await confirmLighterLeverage(input, ctx.signal));
        } catch (cause) {
          return err(failure("confirmLighterLeverage", cause, ctx.requestId));
        }
      },
    }),

    registerHandler({
      channel: CH.settings.reconcileLighterLeverage,
      domain: "settings",
      inputSchema: reconcileLighterLeverageInputSchema,
      outputSchema: applyLighterLeverageResultSchema,
      handle: async (input, ctx): Promise<Result<ApplyLighterLeverageResult>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { reconcileLighterLeverage } = await import("../lighter/leverage-execution.js");
          return ok(await reconcileLighterLeverage(input));
        } catch (cause) {
          return err(failure("reconcileLighterLeverage", cause, ctx.requestId));
        }
      },
    }),
  ];
}

/**
 * Vex's OWN refusal text reaches the user; anything else becomes a stable
 * redacted message with a correlation id. The log line is structural only: a
 * cause here has touched provider responses and vault-derived material, and
 * neither belongs in a log.
 */
function failure(operation: string, cause: unknown, correlationId: string): VexError {
  if (cause instanceof EngineError && cause.code === ErrorCodes.LIGHTER_LEVERAGE_REFUSED) {
    log.warn(`[ipc:vex:settings:${operation}] refused correlationId=${correlationId}`);
    return {
      code: "validation.invalid_input",
      domain: "settings",
      message: cause.hint ? `${cause.message} ${cause.hint}` : cause.message,
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId,
    };
  }
  if (
    cause instanceof EngineError
    && cause.code === ErrorCodes.LIGHTER_SETTINGS_REVISION_CONFLICT
  ) {
    log.warn(`[ipc:vex:settings:${operation}] revision conflict correlationId=${correlationId}`);
    // A dedicated code, not `validation.invalid_input`: the renderer routes on
    // it to offer a reload instead of a retry that would clobber the winner.
    return {
      code: "settings.lighter_revision_conflict",
      domain: "settings",
      message: cause.hint ? `${cause.message} ${cause.hint}` : cause.message,
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId,
    };
  }
  log.warn(`[ipc:vex:settings:${operation}] failed correlationId=${correlationId}`);
  // "Nothing was changed" is a CLAIM ABOUT LIGHTER, and on the two operations
  // that can sign and submit it is a claim this handler cannot make: an
  // unexpected failure there may follow a transaction that already executed.
  // Those operations return their own honest outcome for every case they can
  // classify, so anything reaching here is unknown, and the message says so.
  const mayHaveSubmitted =
    operation === "confirmLighterLeverage" || operation === "reconcileLighterLeverage";
  return {
    code: "internal.unexpected",
    domain: "settings",
    message: mayHaveSubmitted
      ? "Vex could not determine what happened to this leverage change. Do not assume it was"
        + " applied or refused; reopen Settings and use Reconcile to check its outcome."
      : "Vex could not complete this Lighter trading setup action. Nothing was changed; try again.",
    retryable: mayHaveSubmitted ? false : true,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}
