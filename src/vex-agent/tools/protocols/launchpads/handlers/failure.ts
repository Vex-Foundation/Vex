/**
 * Failure detail for the `launchpads` handlers - the REAL cause, scrubbed.
 *
 * Owner decree (2026-08-02): an error surfaced to the agent carries the ACTUAL
 * cause, never a bare generic label. An agent given a generic label retries
 * blind; an agent told "the image locker could not be read" says so to the user
 * and stops.
 *
 * The redaction is NOT owned here. It routes through `summarizeProtocolError`,
 * the runtime's canonical provider-safe summarizer, exactly as the Trench and
 * pools lanes do. This module is a thin adapter, not a second copy of that
 * policy: a scrub-core fix has to protect every caller at once, which it
 * cannot do if a venue keeps its own preprocessor.
 */

import {
  describeFailureForAgent,
  describeFailureForLog,
  summarizeProtocolError,
} from "../../runtime/errors.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";

/** A short, scrubbed, agent-safe description of why `toolId` failed. */
export function launchpadsFailureDetail(toolId: string, err: unknown): string {
  logger.warn("launchpads.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    // Scrubbed before it reaches the log file: the logger performs no redaction
    // of its own, and an upload error body can carry a key-shaped token
    // (rule 07 minimization applies to our own logs too).
    error: describeFailureForLog(err),
  });
  // Code plus authored hint LEADS for our own typed errors: a code alone is not
  // diagnosable, and the hint is the remediation the user can act on.
  if (err instanceof VexError) return describeFailureForAgent(err);
  return summarizeProtocolError(err).message;
}
