/**
 * Failure detail for the pools.fun handlers - REAL cause, agent-friendly.
 *
 * Owner decree (2026-08-02): a tool error surfaced to the agent carries the
 * ACTUAL cause, never a bare generic label. pools.fun makes this unusually easy
 * on the 400 path - its rejection names the parameter and lists the allowed
 * values - and `@tools/pools-fun/errors.ts` has already turned that into the
 * VexError hint by the time a failure reaches here. This module's only job is to
 * log the failure scrubbed and hand the agent the code plus that hint.
 *
 * The scrubbing is NOT owned here: it routes through `summarizeProtocolError`,
 * the runtime's canonical provider-safe summarizer, exactly as the trench
 * handlers do. A per-namespace clone of those regexes is how one lane ends up
 * knowing about JSON bodies and long hex blobs while another does not.
 */

import {
  describeFailureForAgent,
  describeFailureForLog,
  summarizeProtocolError,
} from "../../runtime/errors.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";

/**
 * The text a viem/provider error should be READ from. viem puts the readable
 * one-line cause in `shortMessage` and a docs dump in `message`.
 */
function preferredRawMessage(err: unknown): string {
  return err instanceof Error
    ? ((err as { shortMessage?: string }).shortMessage ?? err.message)
    : String(err);
}

export function poolsFailureDetail(toolId: string, err: unknown): string {
  logger.warn("pools.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: describeFailureForLog(err),
  });
  if (err instanceof VexError) {
    // Code + authored hint LEADS, then the wrapped real cause when the throw
    // site buried one in `message`/`cause`. On the 400 path that hint IS the
    // provider's own list of accepted values.
    return describeFailureForAgent(err);
  }

  const summary = summarizeProtocolError(new Error(preferredRawMessage(err), { cause: err }));
  return `provider error: ${summary.message}`;
}
