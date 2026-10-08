// ── Read timeout (Kairos Phase 5, T-3) ──────────────────────────
//
// A wall-clock cap on ONE audited parallel-safe read
// (`../parallel-safe-reads.ts`). Everything else - approval, wallet, signing,
// broadcast, local writes, and every tool not on the allowlist - is NEVER
// wrapped: a call that may already have moved funds must always settle.
//
// On expiry the caller gets a typed `tool_timeout` failure at once. The read
// is told to stop through a signal derived from the turn's Stop signal (a
// handler that honours it ends early; one that does not finishes in the
// background and its late answer is discarded). It is a read, so abandoning
// it changes nothing.
//
// The derived signal is what the handler sees. The dispatcher's own Stop
// classification keeps reading the ORIGINAL context signal, so an operator
// Stop during a wrapped read is still reported as the Stop, never as a
// timeout.

import type { ToolCallRequest, ToolResult } from "../types.js";
import type { InternalToolContext } from "../internal/types.js";
import type { ParallelSafeRead } from "../parallel-safe-reads.js";
import type { AgentToolReadBounds } from "../read-dispatch-bounds.js";

export type ToolRoute = (
  call: ToolCallRequest,
  context: InternalToolContext,
) => Promise<ToolResult>;

/** The read timeout for an allowlisted read, in ms; `0` means unbounded. */
export function readTimeoutMsFor(
  entry: Pick<ParallelSafeRead, "timeoutClass">,
  bounds: AgentToolReadBounds,
): number {
  return entry.timeoutClass === "extended"
    ? bounds.extendedReadTimeoutMs
    : bounds.readTimeoutMs;
}

export function toolTimeoutOutput(toolName: string, timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 100) / 10;
  return (
    `${toolName} did not answer within ${seconds} s and was abandoned (tool_timeout). ` +
    "It is a read, so nothing changed. Retry it once if you still need it, " +
    "or continue with what you already have."
  );
}

export async function routeWithReadTimeout(
  route: ToolRoute,
  call: ToolCallRequest,
  context: InternalToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  const controller = new AbortController();
  const parent = context.abortSignal;
  const forwardStop = (): void => controller.abort(parent?.reason);
  if (parent?.aborted === true) {
    controller.abort(parent.reason);
  } else {
    parent?.addEventListener("abort", forwardStop, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), timeoutMs);
  });
  const running = route(call, { ...context, abortSignal: controller.signal });

  try {
    const winner = await Promise.race([running, expired]);
    if (winner !== "expired") return winner;
    // Settle the abandoned read quietly: its late result or error has no
    // reader, and an unhandled rejection must not escape.
    running.catch(() => undefined);
    controller.abort(new DOMException("read timeout", "TimeoutError"));
    return {
      success: false,
      output: toolTimeoutOutput(call.name, timeoutMs),
      failure: { kind: "tool_timeout", timeoutMs },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener("abort", forwardStop);
  }
}
