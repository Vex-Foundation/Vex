/**
 * Compaction v2 preparation IPC — the bounded read + the ONE user action.
 *
 * Split out of `../compaction.ts` (which owns the Track-2 `compact_jobs`
 * domain) because this is the second compaction track: the
 * `compaction_preparations` FSM behind the apply button. Different table,
 * different lifecycle, different reason to change.
 *
 * **The button issues exactly one compare-and-swap and never performs a
 * cutover.** `requestApply` moves the FSM `summary_ready → apply_requested`
 * and stops; the runner consumes the standing request at its next iteration
 * boundary, which is the only place that holds the lease, the lock order and
 * the money gate together. Nothing in this file may reach a cutover primitive
 * — that is the whole renderer-authority boundary.
 *
 * Two further rules this file keeps:
 *  - the CAS is NOT re-implemented here. `engine/compaction/apply` exports
 *    `requestApply` as the single surface (CAS first, lease read after), and
 *    this handler is a thin outcome mapping over it.
 *  - the handler NEVER emits on the preparation bus. Only the engine emits,
 *    and only after its transaction has committed; a main-side emit would
 *    broadcast a state main cannot guarantee is durable.
 */

import { CH } from "@shared/ipc/channels.js";
import {
  err,
  ok,
  type Result,
  type VexError,
  type VexErrorCode,
} from "@shared/ipc/result.js";
import {
  compactionApplyRequestInputSchema,
  compactionApplyRequestResultSchema,
  compactionPreparationInputSchema,
  compactionPreparationResultSchema,
  type CompactionApplyRequestResult,
  type CompactionPreparationResult,
} from "@shared/schemas/compaction-preparation.js";
// Type-only: erased at compile time, so the apply gate (and the DB client
// behind it) still enters the graph solely through the dynamic import below.
import type { RequestApplyOutcome } from "@vex-agent/engine/compaction/apply/index.js";
import { getCompactionPreparation } from "../../database/compaction-preparation-db.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

function compactionError(
  code: VexErrorCode,
  message: string,
  correlationId: string,
  opts: { readonly retryable: boolean; readonly userActionable: boolean },
): Result<never, VexError> {
  return err({
    code,
    domain: "compaction",
    message,
    retryable: opts.retryable,
    userActionable: opts.userActionable,
    redacted: true,
    correlationId,
  });
}

function registerGetPreparationHandler(): () => void {
  return registerHandler({
    channel: CH.compaction.getPreparation,
    domain: "compaction",
    inputSchema: compactionPreparationInputSchema,
    outputSchema: compactionPreparationResultSchema,
    handle: async (input, ctx): Promise<Result<CompactionPreparationResult>> => {
      const outcome = await getCompactionPreparation(
        input.sessionId,
        ctx.requestId,
      );
      if (outcome.ok) {
        // Bounded log fields only — the row's prose columns are never read,
        // so they cannot be logged either.
        log.info(
          `[ipc:vex:compaction:getPreparation] ok sessionId=${input.sessionId} ` +
            `present=${outcome.data !== null} ` +
            `status=${outcome.data?.status ?? "none"} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:compaction:getPreparation] errCode=${outcome.error.code} ` +
          `correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

/**
 * Queue a cutover for the session's live preparation.
 *
 * Every racing state (`not_ready`, `already_requested`, `gone`) is a
 * SUCCESSFUL result carrying an `outcome` — the button legitimately races the
 * runtime, and calling that an error would make a normal race look like a
 * failure. Only an unknown / foreign-scope / soft-deleted session — or one
 * that has no preparation at all, which the app-scope read cannot distinguish
 * and which the button is never offered for — is a `compaction.not_found`
 * error; that read is also what authorizes the mutation.
 */
function registerRequestApplyHandler(): () => void {
  return registerHandler({
    channel: CH.compaction.requestApply,
    domain: "compaction",
    inputSchema: compactionApplyRequestInputSchema,
    outputSchema: compactionApplyRequestResultSchema,
    handle: async (
      input,
      ctx,
    ): Promise<Result<CompactionApplyRequestResult>> => {
      const scoped = await getCompactionPreparation(
        input.sessionId,
        ctx.requestId,
      );
      if (!scoped.ok) return scoped; // internal.unexpected (compaction), redacted
      if (scoped.data === null) {
        return compactionError(
          "compaction.not_found",
          "That compaction no longer exists for this session.",
          ctx.requestId,
          { retryable: false, userActionable: true },
        );
      }

      const dbUrl = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrl.ok) {
        return compactionError(
          "internal.unexpected",
          "Unable to request compaction. Verify services are running and retry.",
          ctx.requestId,
          { retryable: true, userActionable: true },
        );
      }

      try {
        // Narrow dynamic import: the apply gate pulls the DB client, so it must
        // not enter the main graph at registration time.
        const { requestApply } = await import(
          "@vex-agent/engine/compaction/apply/index.js"
        );
        const outcome = await requestApply({
          sessionId: input.sessionId,
          source: "ui_button",
        });
        const mapped = mapRequestApplyOutcome(outcome);
        log.info(
          `[ipc:vex:compaction:requestApply] ok sessionId=${input.sessionId} ` +
            `outcome=${mapped.outcome} correlationId=${ctx.requestId}`,
        );
        return ok(mapped);
      } catch (cause) {
        log.warn(
          `[ipc:vex:compaction:requestApply] failed sessionId=${input.sessionId} ` +
            `correlationId=${ctx.requestId}`,
          cause,
        );
        return compactionError(
          "internal.unexpected",
          "Unable to request compaction. Verify services are running and retry.",
          ctx.requestId,
          { retryable: true, userActionable: true },
        );
      }
    },
  });
}

/**
 * Engine outcome → renderer outcome. The three winning/standing kinds all
 * leave the row in `apply_requested`, so the renderer refreshes its copy
 * without a second round trip; `no_preparation` becomes `gone` because from
 * the renderer's side the thing it aimed at is simply not there any more.
 */
export function mapRequestApplyOutcome(
  outcome: RequestApplyOutcome,
): CompactionApplyRequestResult {
  switch (outcome.kind) {
    case "queued":
      return { outcome: "queued", status: "apply_requested" };
    case "queued_no_live_runner":
      return { outcome: "no_live_runner", status: "apply_requested" };
    case "already_requested":
      return { outcome: "already_requested", status: "apply_requested" };
    case "not_ready":
      // `PreparationStatus` and the DTO enum are the same closed set; the
      // output schema re-validates on the way out, so a drift fails loudly.
      return { outcome: "not_ready", status: outcome.status };
    case "no_preparation":
      return { outcome: "gone" };
  }
}

/** The two compaction-v2 preparation handlers, in registration order. */
export function registerPreparationHandlers(): ReadonlyArray<() => void> {
  return [registerGetPreparationHandler(), registerRequestApplyHandler()];
}
