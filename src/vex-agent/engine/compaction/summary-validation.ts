/**
 * Branch-A output acceptance — pure, no I/O.
 *
 * THE ONLY BARRIER between model text and durable prompt content. The accepted
 * value replaces `sessions.summary` at cutover, and that column is re-sent to
 * the model on every subsequent turn, so anything that survives this function
 * becomes permanent context: a prompt injection carried out of the transcript,
 * a secret the transcript scrubber missed, or a runaway generation that costs
 * tokens forever.
 *
 * ORDER MATTERS. Redaction runs BEFORE the length and emptiness checks,
 * because the bound governs the value that actually gets STORED. Measuring the
 * raw model text would bound something this repo never persists: today's
 * redactor collapses a matched secret into a short placeholder, so a raw string
 * over the limit can have a redacted form well under it — and a change in
 * either direction stays correct as long as the checks run on the post-redaction
 * text.
 *
 * A rejection here is a FAILED ATTEMPT — it burns one of the branch's three
 * attempts and schedules a backoff. It is never a ready state; contract C2 is
 * explicit that invalid output must not reach the `summary_ready` CAS.
 */

import { redact } from "@vex-agent/memory/redaction.js";
import { scanLiveState } from "@vex-agent/memory/exclusion-rules.js";

import { SUMMARY_MAX_CHARS, SUMMARY_MIN_CHARS } from "./policy.js";

export type SummaryRejectionReason =
  | "empty"
  | "too_long"
  | "live_state_dominated";

export type SummaryValidation =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly hardRedactCount: number;
      readonly maskCount: number;
    }
  | { readonly ok: false; readonly reason: SummaryRejectionReason };

export function validateSummaryOutput(raw: string): SummaryValidation {
  const redacted = redact(raw.trim());
  const summary = redacted.text.trim();

  if (summary.length < SUMMARY_MIN_CHARS) return { ok: false, reason: "empty" };
  if (summary.length > SUMMARY_MAX_CHARS) {
    // Truncating would be worse than retrying: the cut point is arbitrary and
    // the result reads as a complete summary that silently ends mid-history.
    return { ok: false, reason: "too_long" };
  }

  // The prompt forbids live state (balances, prices, gas, tx hashes, intent
  // ids) because it goes stale and misleads. A summary that is mostly live
  // state means the model ignored the contract; retrying is cheaper than
  // pinning that text into every future turn.
  if (scanLiveState(summary).rejected) {
    return { ok: false, reason: "live_state_dominated" };
  }

  return {
    ok: true,
    summary,
    hardRedactCount: redacted.hardRedactCount,
    maskCount: redacted.maskCount,
  };
}
