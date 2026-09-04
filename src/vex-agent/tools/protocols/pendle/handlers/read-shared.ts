/**
 * Shared plumbing for the two Pendle READ handlers.
 *
 * Both tools report failure the same way and for the same reason: a chain that
 * could not be read is NAMED with a code-keyed reason rather than folded into a
 * zero. "This chain has no markets" and "this chain could not be read" are
 * different answers, and the old handlers gave the first for both.
 */

import { describeFailureForAgent, describeFailureForLog } from "../../runtime/errors.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";

/** Beyond this, the provider's own `updatedAt` is old enough to change a decision. */
export const STALENESS_WARNING_MS = 24 * 60 * 60 * 1000;

/** A chain that could not be read, named with the reason. */
export interface FailedChain {
  chain: string;
  reason: string;
}

/**
 * Model-facing failure detail for the READ path - the REAL cause, scrubbed and
 * bounded (owner decree 2026-08-02). This is what lands in
 * {@link FailedChain.reason}, so "this chain could not be read" now says WHY:
 * a catalogue that would not parse and an RPC that timed out are different
 * answers, and the static vocabulary gave "unexpected error" for both.
 *
 * The provider's body is still untrusted - it is SCRUBBED by
 * `summarizeProtocolError` (the runtime's single owner of that redaction),
 * not hidden. Kept as its own small wrapper rather than importing the write
 * path's twin: this module is deliberately free of the wallet/RPC/viem imports
 * `handlers/shared.ts` pulls in, and the read handlers must stay that way.
 */
export function failureDetail(toolId: string, err: unknown): string {
  logger.warn("pendle.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: describeFailureForLog(err),
  });
  return describeFailureForAgent(err);
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
