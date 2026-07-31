/**
 * Bounded, code-keyed failure detail for the Trench Express handlers.
 *
 * The launchpad REST API is untrusted input and its error bodies can carry
 * upstream-influenced text (it leaks raw exceptions as `text/plain` on bad
 * input), so the model-facing detail is built ONLY from our own static
 * vocabulary — the `VexError` code plus its static hint. The real error goes to
 * the logger as bounded metadata for debugging. Mirrors the virtuals handler
 * posture.
 */

import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";

export function trenchFailureDetail(toolId: string, err: unknown): string {
  logger.warn("trench.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  });
  if (err instanceof VexError) {
    return err.hint ? `${err.code}: ${err.hint}` : err.code;
  }
  return "unexpected error";
}
