/**
 * IPC handler registration helper per skill §6.
 *
 * Every handler:
 *  - validates senderFrame.url against trusted origins
 *  - parses input via Zod schema (request envelope)
 *  - validates outgoing data via Zod outputSchema (defense-in-depth — catches
 *    handler bugs that produce wrong-shape Result<T>)
 *  - validates outgoing error shape (defense-in-depth — catches handlers that
 *    return malformed `{ ok: false, error }` instead of using `err(...)` factory)
 *  - returns Result<T, VexError> (never throws raw)
 *  - logs internal errors with correlationId (structural diagnosis only —
 *    raw error objects are NEVER logged because they may contain secrets
 *    leaked from a handler that returned an unredacted shape)
 *  - auto-registers cleanup with globalCleanup so app quit removes the handler
 *
 * The unregister function returned to callers is idempotent: removing the
 * handler from ipcMain twice is safe, and the globalCleanup hook is detached
 * once invoked so it never double-runs.
 */

import { randomUUID } from "node:crypto";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { requestEnvelopeSchema } from "@shared/ipc/envelope.js";
import {
  err,
  type Result,
  type VexDomain,
} from "@shared/ipc/result.js";
import { globalCleanup } from "../lifecycle/cleanup-registry.js";
import { log } from "../logger/index.js";
import { cancelledError, isAbortError } from "./cancel-helpers.js";
import {
  cancelRegistry,
  getCancelController,
  __resetCancelRegistryForTests,
} from "./cancellation.js";
import {
  contractViolation,
  isValidVexErrorShape,
  summarizeUnknown,
} from "./error-normalize.js";
import { assertTrustedSender } from "./sender-validation.js";

export { getCancelController, __resetCancelRegistryForTests };

export interface HandlerContext {
  readonly requestId: string;
  readonly event: IpcMainInvokeEvent;
  /**
   * AbortSignal that fires when the renderer issues `vex:cancel` for
   * this request's correlationId, or when the main process is tearing
   * the handler down (future hook — not wired yet). Always defined:
   * a handler that does not care can ignore the field. Handlers that
   * own long-running work (subprocess spawn, network fetch, polling
   * loop) should plumb this signal down into the primitive that
   * supports `AbortSignal`. When the signal aborts, throwing/letting
   * the handler return normally is fine — `registerHandler` normalises
   * AbortError-shaped failures into the `internal.cancelled` Result
   * without ever surfacing the raw error to logs.
   */
  readonly signal: AbortSignal;
}

export interface HandlerArgs<I, O> {
  readonly channel: string;
  readonly domain: VexDomain;
  readonly inputSchema: z.ZodType<I>;
  /**
   * Optional Zod schema for the success-path data payload.
   * When provided, every `ok({...}).data` is validated before send.
   * Skip only for empty-shape responses or when schema would echo input verbatim.
   */
  readonly outputSchema?: z.ZodType<O>;
  readonly handle: (input: I, ctx: HandlerContext) => Promise<Result<O>>;
}

export function registerHandler<I, O>(args: HandlerArgs<I, O>): () => void {
  const envelope = requestEnvelopeSchema(args.inputSchema);

  const fn = async (event: IpcMainInvokeEvent, raw: unknown): Promise<Result<O>> => {
    // Generate a fallback UUID FIRST so even an unparseable envelope still
    // produces a correlatable error response (and log entry).
    let requestId = randomUUID();
    try {
      assertTrustedSender(event);
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) {
        return err({
          code: "validation.invalid_input",
          domain: args.domain,
          message: "Invalid request payload.",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: requestId,
        });
      }
      requestId = parsed.data.requestId;
      const controller = new AbortController();
      cancelRegistry.set(requestId, controller);
      let result: Result<O>;
      try {
        result = await args.handle(parsed.data.payload, {
          requestId,
          event,
          signal: controller.signal,
        });
      } finally {
        // Always drop the controller so a late `vex:cancel` for a
        // completed request returns `{cancelled: false}` instead of
        // racing against the next request that re-uses the id (won't
        // happen with UUIDs in practice but the invariant is cheap).
        cancelRegistry.delete(requestId);
      }
      // If the handler returned via the abort path — either explicitly
      // returned `err(cancelledError(...))` or threw an AbortError that
      // we'll catch below — normalise here so the `internal.cancelled`
      // code is always what the renderer sees on user cancel. Handlers
      // that returned a normal Result.error with a different code are
      // not rewritten; only literal aborts collapse to cancelled.
      if (controller.signal.aborted && result.ok === false) {
        if (result.error.code !== "internal.cancelled") {
          // Replace with the canonical cancelled shape. Logging is
          // info-level — user cancellation is not an error to surface
          // through error-rate dashboards.
          log.info(
            `[ipc:${args.channel}] correlationId=${requestId} normalised handler error code=${result.error.code} -> internal.cancelled (signal aborted)`,
          );
          result = err(cancelledError(args.domain, requestId));
        }
      }

      if (result.ok) {
        // Output validation (defense-in-depth)
        if (args.outputSchema) {
          const outValidation = args.outputSchema.safeParse(result.data);
          if (!outValidation.success) {
            log.error(
              `[ipc:${args.channel}] correlationId=${requestId} handler produced invalid output shape`,
              outValidation.error.format(),
            );
            return err(contractViolation(args.domain, requestId));
          }
        }
        return result;
      }

      // Error path normalization (defense-in-depth): if the handler returned
      // a malformed error shape, never forward it — wrap. Crucially, we log
      // ONLY structural diagnosis (type + keys), never the raw object, since
      // a malformed shape might contain unredacted secrets a leaked through
      // an ad-hoc literal.
      if (!isValidVexErrorShape(result.error)) {
        const summary = summarizeUnknown(result.error);
        log.error(
          `[ipc:${args.channel}] correlationId=${requestId} handler returned invalid error shape type=${summary.type} keys=${summary.keys.join(",")}${summary.truncated ? " truncated=true" : ""}`,
        );
        return err(contractViolation(args.domain, requestId));
      }

      // Valid error shape — ensure correlationId matches the request even if
      // the handler attached a different one (e.g. a stale id from a helper)
      // or omitted it entirely (the validator allows that path). A mismatch
      // is a handler bug worth logging (structurally) but not user-visible.
      if (result.error.correlationId !== requestId) {
        if (typeof result.error.correlationId === "string") {
          log.warn(
            `[ipc:${args.channel}] correlationId=${requestId} handler attached mismatched correlationId=${result.error.correlationId}`,
          );
        }
        return err({ ...result.error, correlationId: requestId });
      }
      return result;
    } catch (error: unknown) {
      // User-initiated cancel: handler's spawn/fetch/wait threw an
      // AbortError because `ctx.signal` aborted. Normalise to
      // `internal.cancelled` and log at info, not error — this is the
      // success outcome of the cancel button, not an internal failure
      // we want telemetry firing on.
      if (isAbortError(error)) {
        log.info(
          `[ipc:${args.channel}] correlationId=${requestId} handler aborted (user cancel)`,
        );
        return err(cancelledError(args.domain, requestId));
      }
      const isUntrusted =
        error instanceof Error && error.message.startsWith("Untrusted IPC sender");
      // Structural-only log: never pass the raw `error` to the logger because
      // a handler-thrown object may carry secrets the redactor can't fingerprint.
      const summary = summarizeUnknown(error);
      log.error(
        `[ipc:${args.channel}] correlationId=${requestId} handler threw type=${summary.type} keys=${summary.keys.join(",")}${summary.truncated ? " truncated=true" : ""}${isUntrusted ? " untrusted=true" : ""}`,
      );

      return err({
        code: isUntrusted ? "validation.invalid_sender" : "internal.contract_violation",
        domain: args.domain,
        message: isUntrusted
          ? "Request rejected: untrusted sender."
          : "Internal error.",
        retryable: false,
        userActionable: false,
        redacted: true,
        correlationId: requestId,
      });
    }
  };

  ipcMain.handle(args.channel, fn);

  let unregistered = false;
  const removeFromCleanup = globalCleanup.add(() => {
    if (unregistered) return;
    unregistered = true;
    ipcMain.removeHandler(args.channel);
  }, `ipc:${args.channel}`);

  return () => {
    if (unregistered) return;
    unregistered = true;
    ipcMain.removeHandler(args.channel);
    // Detach from globalCleanup so app quit doesn't try to remove a
    // handler that's already gone.
    void removeFromCleanup();
  };
}
