/**
 * Failure detail for the indexify handlers — REAL cause, agent-friendly.
 *
 * Same contract as the pools.fun/trench lane: `@tools/indexify/errors.ts` has
 * already scrubbed provider text and named the cause by the time a failure
 * reaches here (an Indexify 400 names its own rule — "Limit and offset must be
 * supplied together", "Insufficient balance"). This module logs the failure
 * scrubbed and hands the agent the code plus that authored hint, routing
 * through the runtime's canonical summarizer rather than a per-namespace clone.
 */

import {
  describeFailureForAgent,
  describeFailureForLog,
  summarizeProtocolError,
} from "../../runtime/errors.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";

export function indexifyFailureDetail(toolId: string, err: unknown): string {
  logger.warn("indexify.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: describeFailureForLog(err),
  });
  if (err instanceof VexError) {
    return describeFailureForAgent(err);
  }
  const raw = err instanceof Error ? err.message : String(err);
  const summary = summarizeProtocolError(new Error(raw, { cause: err }));
  return `provider error: ${summary.message}`;
}
