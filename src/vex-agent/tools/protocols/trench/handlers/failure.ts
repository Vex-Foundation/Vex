/**
 * Failure detail for the Trench Express handlers — REAL cause, agent-friendly.
 *
 * Owner decree (2026-08-02): a tool error surfaced to the agent/UI carries the
 * ACTUAL cause, never a bare "unexpected error". The live test that forced
 * this: `launch_preview` failed four times in a row with "unexpected error"
 * while the log knew the truth the whole time ("total cost … exceeds the
 * balance of the account") — the agent retried blind instead of saying
 * "top up the wallet". A generic label on a diagnosable failure wastes the
 * agent's turns and the user's money.
 *
 * The old posture (static vocabulary only) existed because the launchpad REST
 * API leaks upstream-influenced text. That risk is split, not hidden: SECRETS
 * and provider internals are removed by scrubbing (mandatory), while
 * instruction-shaped prose — pseudo-role tags, imperative sentences — is NOT
 * something scrubbing removes, and never was; the Safety Contract, which
 * teaches the model that tool output is data and never instruction, is what
 * answers that half. Silence answered neither.
 *
 * The scrubbing itself is NOT owned here. It routes through
 * `summarizeProtocolError`, the runtime's canonical provider-safe summarizer
 * (see `runtime/errors.ts`): this file previously carried its own four-regex
 * clone, which knew nothing about JSON/HTML bodies, `redact()`'s secret
 * shapes, or the Bearer-ordering fixes that module has accumulated. Its one
 * guarantee the canonical path lacked — the long-hex-blob strip — was moved
 * INTO that module rather than kept here, so the consolidation adds coverage
 * and removes none.
 */

import {
  classifyError,
  describeFailureForAgent,
  describeFailureForLog,
  summarizeProtocolError,
  type ErrorCategory,
} from "../../runtime/errors.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";

/**
 * The text a viem/provider error should be READ from.
 *
 * viem puts the readable one-line cause in `shortMessage` and a multi-hundred-
 * character docs dump in `message`. Both the agent-facing summary and the
 * category classification must read the SAME words, or a launch could be
 * classified off one string and explained with another.
 */
function preferredRawMessage(err: unknown): string {
  return err instanceof Error
    ? ((err as { shortMessage?: string }).shortMessage ?? err.message)
    : String(err);
}

/**
 * The canonical category of a Trench provider failure.
 *
 * Exists so a caller can BRANCH on the cause before rendering — the launch
 * pipeline uses it to tell "the node will not estimate this call" apart from
 * "the account cannot pay for it", which viem reports through the same
 * `estimateGas` rejection and which the 2026-08-02 incident proved must never
 * be blamed on the chain.
 */
export function trenchErrorCategory(err: unknown): ErrorCategory {
  return classifyError(preferredRawMessage(err), err);
}

export function trenchFailureDetail(toolId: string, err: unknown): string {
  logger.warn("trench.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    // Scrubbed before it reaches the log file: the logger performs no redaction
    // of its own, and a launchpad error body can carry a key-shaped token
    // (rule 06 minimization applies to server-side logs too).
    error: describeFailureForLog(err),
  });
  if (err instanceof VexError) {
    // Code + authored hint LEADS, then the wrapped real cause when the throw
    // site buried one in `message`/`cause` — a code alone is not diagnosable.
    return describeFailureForAgent(err);
  }

  // viem puts the readable one-line cause in `shortMessage` and a multi-hundred-
  // character docs dump in `message`; the canonical summarizer reads `.message`,
  // so the preferred text is chosen HERE and handed over as the error to
  // summarize. The original is preserved as `cause` — nothing is swallowed.
  const summary = summarizeProtocolError(new Error(preferredRawMessage(err), { cause: err }));

  // The one failure class worth naming ahead of the provider text, because its
  // remedy is always the same and always the user's: fund the wallet. The
  // remedy sentence itself now comes from the canonical summarizer, so the
  // wording is identical at every venue; only the `insufficient_funds:` label
  // is added here, and it is the prefix this tool's callers already read.
  if (summary.category === "insufficient_funds") {
    return `insufficient_funds: ${summary.message}`;
  }
  return `provider error: ${summary.message}`;
}
