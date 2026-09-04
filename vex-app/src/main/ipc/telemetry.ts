/**
 * vex.telemetry.reportRendererError - the renderer's crash-evidence sink.
 *
 * TWO consumers, and the split is the point (B0.2):
 *
 *   1. THE LOCAL LOG, ALWAYS. Every accepted report writes one structured,
 *      redacted line through the main logger, whatever the telemetry consent
 *      says. Consent governs what leaves the machine; it must not govern
 *      whether the owner's own machine keeps evidence of its own crash. Before
 *      this, a renderer that blanked out on a machine with telemetry off left
 *      NOTHING anywhere - the report crossed IPC and was dropped on the floor.
 *   2. SENTRY, ONLY WITH CONSENT. Unchanged: no consent → no forward, and the
 *      SDK module stays unloaded (see `telemetry/sentry-lifecycle.ts`).
 *
 * `recorded` in the reply keeps its original meaning - "Sentry took it" - so
 * no renderer caller changes behaviour. The local log is unconditional and
 * therefore not something a caller can learn anything from.
 *
 * The payload's bounds live in `@shared/schemas/telemetry`, which BOTH this
 * handler and the preload validator import, and every bound reports itself
 * (frame count, byte counts, truncation flags) rather than silently cutting.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  telemetryReportInputSchema,
  telemetryReportOutputSchema,
} from "@shared/schemas/telemetry.js";
import type { TelemetryStackDigest } from "@shared/types/bridge/common.js";
import { log } from "../logger/index.js";
import { preferencesStore } from "../preferences/store.js";
import { captureRendererError } from "../telemetry/sentry-lifecycle.js";
import { registerHandler } from "./register-handler.js";

/**
 * Render the stack digest as one line per frame, prefixed with the bound it
 * was produced under. A digest that lost frames says so IN THE LOG - the
 * reader never has to wonder whether a three-frame stack is a shallow throw or
 * a shortened one.
 */
function formatStack(stack: TelemetryStackDigest): string {
  const header =
    `frames=${String(stack.frames.length)}/${String(stack.frameCount)} ` +
    `bytes=${String(stack.byteCount)} truncated=${String(stack.truncated)}`;
  const lines = stack.frames.map((frame) => {
    const where =
      frame.file === null
        ? "<unknown>"
        : `${frame.file}:${String(frame.line ?? 0)}:${String(frame.column ?? 0)}`;
    return `    at ${frame.fn ?? "<anonymous>"} (${where})`;
  });
  return [header, ...lines].join("\n");
}

export function registerTelemetryHandler(): () => void {
  return registerHandler({
    channel: CH.telemetry.reportRendererError,
    domain: "telemetry",
    inputSchema: telemetryReportInputSchema,
    outputSchema: telemetryReportOutputSchema,
    handle: async (input): Promise<Result<{ recorded: boolean }>> => {
      // The logger's redactor runs over every argument, so a message or a
      // component stack that happens to carry a secret-shaped token is
      // scrubbed before any transport (console or file) sees it.
      log.error(
        "[renderer-error]",
        {
          kind: input.kind,
          correlationId: input.correlationId ?? null,
          errorName: input.errorName ?? null,
          message: input.message,
          messageBytes: input.messageBytes ?? null,
          messageTruncated: input.messageTruncated ?? false,
          componentStackBytes: input.componentStackBytes ?? null,
          componentStackTruncated: input.componentStackTruncated ?? false,
        },
        input.stack ? `\n${formatStack(input.stack)}` : "\nstack=<none>",
        input.componentStack
          ? `\ncomponentStack:${input.componentStack}`
          : "\ncomponentStack=<none>",
      );

      const prefs = await preferencesStore.load();
      if (!prefs.telemetry.enabled) {
        return ok({ recorded: false });
      }
      const recorded = await captureRendererError({
        kind: input.kind,
        message: input.message,
        componentStack: input.componentStack ?? null,
        correlationId: input.correlationId ?? null,
        errorName: input.errorName ?? null,
        stack: input.stack ?? null,
      });
      return ok({ recorded });
    },
  });
}
