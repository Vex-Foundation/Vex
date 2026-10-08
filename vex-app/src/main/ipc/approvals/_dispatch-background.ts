/**
 * Background approve (Kairos K-2 B2) - the switch and the event.
 *
 * `APPROVAL_DISPATCH_BACKGROUND` (agent-config, default 0 = off) is read per
 * approve from the environment the engine already validated at startup
 * (`src/vex-agent/inference/config.ts`), so a bad value fails startup loudly
 * and a blank one is off. Off is today's awaited approve, byte for byte: the
 * handler does not even pass the engine its dispatch-started listener.
 *
 * The event follows `agent/activity-progress-bridge.ts`: an EXPLICIT
 * projection validated against the shared `.strict()` schema, dropped and
 * logged on drift, broadcast to every live window, and re-validated by the
 * preload subscriber. It carries the same `ApprovalActionResult` the awaited
 * reply would have carried (already the renderer contract), or the reply's
 * public error message; never an error object, a stack or a tool argument.
 */

import { EV } from "@shared/ipc/channels.js";
import type { VexError } from "@shared/ipc/result.js";
import {
  approvalDispatchEventSchema,
  type ApprovalActionResult,
} from "@shared/schemas/approvals.js";
import { parseApprovalDispatchBackgroundEnv } from "@vex-lib/agent-config.js";
import { broadcastToAllWindows } from "../../lifecycle/broadcast.js";
import { log } from "../../logger/index.js";

export function approvalDispatchBackgroundEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseApprovalDispatchBackgroundEnv(env).value;
}

type DispatchEventInput =
  | { readonly phase: "dispatching"; readonly approvalId: string }
  | { readonly phase: "settled"; readonly approvalId: string; readonly result: ApprovalActionResult }
  | { readonly phase: "failed"; readonly approvalId: string; readonly error: VexError };

/** Validate, then broadcast. A renderer that is gone must not reach the dispatch. */
export function emitApprovalDispatchEvent(input: DispatchEventInput): void {
  const occurredAt = new Date().toISOString();
  const candidate = input.phase === "dispatching"
    ? { phase: input.phase, approvalId: input.approvalId, occurredAt }
    : input.phase === "settled"
      ? { phase: input.phase, approvalId: input.approvalId, occurredAt, result: input.result }
      : { phase: input.phase, approvalId: input.approvalId, occurredAt, message: input.error.message };
  const parsed = approvalDispatchEventSchema.safeParse(candidate);
  if (!parsed.success) {
    log.warn("[ipc:vex:approvals:dispatch] dropped invalid payload", {
      phase: input.phase,
      issues: parsed.error.issues.length,
    });
    return;
  }
  try {
    broadcastToAllWindows(EV.approvals.dispatch, parsed.data);
  } catch (cause) {
    log.warn("[ipc:vex:approvals:dispatch] broadcast failed", cause);
  }
}
