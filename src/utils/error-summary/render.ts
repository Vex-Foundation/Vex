/**
 * The rendering half of `../error-summary.ts`: turning a thrown value into the
 * bounded, scrubbed summary the agent, the logs and the renderer are allowed
 * to see.
 *
 * Extracted verbatim as part of a façade-preserving structural split (SPEC
 * wave 0R.1) and moved here with the rest of the pipeline to neutral ground.
 * `../error-summary.ts` remains the public entry point.
 */

import { VexError } from "../../errors.js";

import { classifyError, type ErrorCategory } from "./classify.js";
import { remediationFor } from "./remediation.js";
import { collapseAndCap, redactEveryUrl, redactUnlessCredentialFreeLink, scrub } from "./scrub.js";

export interface SafeErrorSummary {
  /**
   * Machine-stable and greppable: a thrown `VexError`'s own code, else the
   * category name. This is what a mission log keys on — a category alone cannot
   * distinguish `KYBER_PRICE_FLOOR_VIOLATED` from `PENDLE_UNSAFE_TX`.
   */
  readonly code: string;
  readonly category: ErrorCategory;
  /** The provider's own status, whenever one was carried. Never scrubbed: a bounded integer. */
  readonly httpStatus?: number;
  readonly message: string;
  /** The first-party imperative for this category, if the table has one. */
  readonly remediation?: string;
  /**
   * Present and `true` only when a thrown `VexError` marked itself retryable.
   * Surfaced to the agent as a "(retryable)" suffix so it knows a retry is sane.
   */
  readonly retryable?: boolean;
}

/**
 * Reduce any thrown value to a `{ category, message }` summary that is safe to
 * log, return to the agent, and forward to the renderer. Bounded + redacted.
 */
export function summarizeProtocolError(err: unknown): SafeErrorSummary {
  const raw = err instanceof Error ? err.message : String(err);
  const category = classifyError(raw, err);

  // A VexError carries an authored, agent-actionable `hint` (e.g. "Pass the exact
  // contract address the quote returned, then retry."). It is scrubbed on its own
  // lane and CONCATENATED BEFORE the cap — so the hint is secret-redacted,
  // internals-stripped, and length-bounded exactly like the message, never
  // appended raw after the cap (B-003). Category is classified on the message
  // alone. Non-VexError throws are byte-unchanged.
  const hint = err instanceof VexError ? err.hint?.trim() : undefined;
  const scrubbedMessage = scrub(raw, redactEveryUrl);
  const scrubbedHint = hint ? scrub(hint, redactUnlessCredentialFreeLink) : undefined;
  const combined = scrubbedHint ? `${scrubbedMessage} — ${scrubbedHint}` : scrubbedMessage;

  // Whitespace collapse + hard cap run on the JOINED text (UNCHANGED cap
  // semantics): the bound covers message and hint together, so a long hint can
  // never smuggle text past the limit.
  const bounded = collapseAndCap(combined);

  // The remedy is appended AFTER the cap, and it is the ONE thing that may be:
  // it is a fixed first-party literal, not provider text, so it can neither
  // smuggle bytes past the redactor nor make the bound unpredictable (the
  // maximum grows by exactly its own length). Inside the cap it was the part
  // that got eaten — a wrapped balance failure ended "…top up the wall…", which
  // is precisely the sentence the agent must be able to act on.
  //
  // ONLY `insufficient_funds` is folded into `message` (unchanged from before
  // W1). Every other category's remedy travels on the `remediation` FIELD and is
  // appended by `renderProtocolFailureOutput`, so `message` keeps meaning "the
  // sanitized provider cause" for the many callers that persist it as a reason,
  // a log line or an activity row. The money remedy stays inline because its
  // callers have depended on that since the 2026-08-02 decree.
  const remediation = remediationFor(category);
  const withRemedy = category === "insufficient_funds" && remediation
    ? `${bounded} — ${remediation}`
    : bounded;

  const summary: SafeErrorSummary = {
    code: err instanceof VexError ? err.code : category,
    category,
    message: withRemedy || category,
    ...(err instanceof VexError && err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    ...(remediation ? { remediation } : {}),
  };
  return err instanceof VexError && err.retryable === true
    ? { ...summary, retryable: true }
    : summary;
}

/**
 * The ONE agent-facing rendering of a failed protocol tool call (SPEC §1.5):
 *
 *   `<toolId> failed [<CODE>/<category>{, HTTP <status>}]: <cause> — <remediation>{ (retryable)}`
 *
 * The remediation is appended here rather than baked into `message`, and skipped
 * when the message already ends with it (the `insufficient_funds` lane), so the
 * agent never reads the same instruction twice.
 */
export function renderProtocolFailureOutput(toolId: string, summary: SafeErrorSummary): string {
  const status = summary.httpStatus === undefined ? "" : `, HTTP ${summary.httpStatus}`;
  const retryable = summary.retryable === true ? " (retryable)" : "";
  const remediation = summary.remediation !== undefined && !summary.message.includes(summary.remediation)
    ? ` — ${summary.remediation}`
    : "";
  return `${toolId} failed [${summary.code}/${summary.category}${status}]: ${summary.message}${remediation}${retryable}`;
}

/** How deep the `cause` chain is walked before the text is considered gathered. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The error's own message plus every DISTINCT message on its `cause` chain.
 *
 * A wrapped failure keeps the real reason one level down: `erc20.ts` throws
 * `APPROVAL_FAILED` with "Failed to reset allowance: <the node's actual
 * words>", and a viem error re-thrown with `{ cause }` keeps the node's words
 * only in the cause. A message already containing an inner one (the
 * interpolation shape above) does not repeat it.
 */
function causeChainText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error) || seen.has(current)) break;
    seen.add(current);
    const message = current.message.trim();
    if (message && !parts.some((part) => part.includes(message))) parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" ← ");
}

/**
 * The ONE model-facing rendering of a thrown failure, for every venue helper.
 *
 * A `VexError` leads with our own vocabulary — code + authored hint — because
 * that is the most actionable thing we can say. But it must not STOP there:
 * the wrapping throw sites carry the real cause inside `message` (or a
 * `cause`), so a signing failure that was really "the wallet cannot pay"
 * reached the agent as a bare `APPROVAL_FAILED` and it retried blind (owner
 * decree 2026-08-02; Codex blocker 4). The scrubbed real cause is appended
 * whenever it says more than the hint already does, which is also how the
 * `insufficient_funds` remedy reaches a WRAPPED balance failure.
 *
 * Everything appended goes through `summarizeProtocolError`, so it is
 * secret-redacted, body/URL/auth-stripped and length-capped exactly like an
 * unwrapped provider error.
 */
export function describeFailureForAgent(err: unknown): string {
  if (!(err instanceof VexError)) return summarizeProtocolError(err).message;
  const label = err.hint ? `${err.code}: ${err.hint}` : err.code;
  const detail = causeChainText(err);
  if (detail.length === 0 || detail === err.hint?.trim()) return label;
  const scrubbed = summarizeProtocolError(new Error(detail)).message;
  return scrubbed.length === 0 ? label : `${label} — ${scrubbed}`;
}

/**
 * The same failure as bounded, scrubbed LOG metadata.
 *
 * Logs are server-side, but rule 06 minimization still applies: the venues
 * previously logged `err.message` raw and the logger performs no redaction of
 * its own, so a provider body carrying a key shape landed in the log file
 * verbatim. Same scrub-core as the model-facing text (Codex blocker 4).
 */
export function describeFailureForLog(err: unknown): string {
  return summarizeProtocolError(new Error(causeChainText(err) || String(err))).message;
}
