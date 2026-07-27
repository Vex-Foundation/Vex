/**
 * Shared plumbing for the two Pendle READ handlers.
 *
 * Both tools report failure the same way and for the same reason: a chain that
 * could not be read is NAMED with a code-keyed reason rather than folded into a
 * zero. "This chain has no markets" and "this chain could not be read" are
 * different answers, and the old handlers gave the first for both.
 */

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
 * Model-facing failure detail — code-keyed and bounded, NEVER upstream text.
 * The provider's error body is hostile input; it is logged as metadata only.
 */
export function failureDetail(toolId: string, err: unknown): string {
  logger.warn("pendle.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  });
  if (err instanceof VexError) return err.hint ? `${err.code}: ${err.hint}` : err.code;
  return "unexpected error";
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
