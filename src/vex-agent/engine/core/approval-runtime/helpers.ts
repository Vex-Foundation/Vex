/**
 * Approval runtime — shared helpers (logging, redaction, hashing).
 *
 * Codex puzzle-5 phase-3 review point 6 — logger output is strictly
 * structural; raw tool/protocol/wallet error messages never reach logs.
 * Transcript redaction is the only place a short summary may appear.
 */

import { createHash } from "node:crypto";

import type { Permission } from "../../types.js";

/**
 * Ordinal rank for the 2-level `Permission` lattice. Higher rank = MORE
 * permissive (`full` > `restricted`). Used by the approve-time drift gate to
 * decide whether the live session permission became strictly more restrictive
 * than the snapshot captured at enqueue.
 */
const PERMISSION_RANK: Readonly<Record<Permission, number>> = {
  restricted: 0,
  full: 1,
};

/**
 * True when `live` is strictly MORE restrictive than `atEnqueue` — i.e. an
 * action authorized under a looser policy at enqueue would no longer be
 * permitted to auto-dispatch under the current policy. This is the only
 * direction the approve path fails closed on; unchanged or looser live
 * permission keeps the existing approve+dispatch path byte-identical.
 */
export function isPermissionMoreRestrictive(
  live: Permission,
  atEnqueue: Permission,
): boolean {
  return PERMISSION_RANK[live] < PERMISSION_RANK[atEnqueue];
}

export const TOOL_RESULT_REJECTED_DEFAULT_REASON = "No reason provided";
export const TOOL_RESULT_EXPIRED_REASON = "expired_ttl";
export const TOOL_RESULT_EXPIRED_MESSAGE =
  "Tool call auto-rejected: approval expired before user action.";

/**
 * B-001 — approve-time live-policy re-enforcement. When the live session
 * permission has drifted MORE restrictive than the permission snapshot
 * captured at enqueue, the approve fails closed BEFORE any dispatch: the
 * queue+intent are flipped to `rejected` in the same locked tx (no approved
 * decision, no dispatch, no approved tool-result). These constants name that
 * outcome so the auto-rejection tool-result + audit reason stay structural.
 */
export const TOOL_RESULT_POLICY_DRIFT_REASON = "policy_drift_blocked";
export const TOOL_RESULT_POLICY_DRIFT_MESSAGE =
  "Tool call auto-rejected: session permission became more restrictive " +
  "after this approval was requested. Re-issue the action under the current " +
  "permission policy.";

export const LEASE_TTL_MS = 5 * 60_000;
export const SWEEP_BATCH_LIMIT = 50;

/**
 * Audit kind for a dispatcher that came back after the reconciler had already
 * declared its dispatch `indeterminate`. Named so the log and the IPC error
 * carry "you lost ownership", not "the tool failed" — the tool's real outcome
 * is precisely what nobody can prove on this path.
 */
export const RESULT_SUPERSEDED_ERROR_KIND = "approval_result_superseded";

/**
 * Engine cue appended when a resolved approval wakes the agent. Short, neutral
 * and non-instructional beyond "continue": the tool result itself is in the
 * transcript, and the model must reason from that, not from a summary we wrote
 * for it. Neutral wording also lets one cue serve the approve, reject, expire
 * and policy-drift paths without ever implying the action succeeded.
 *
 * IT NO LONGER CLAIMS ADJACENCY, and says so explicitly. The old text asserted
 * that the result was "the preceding tool message", which is false on the
 * ordinary deferred path: every decision commits its tool result BEFORE it
 * claims the session lease (`post-tx/reject.ts`, `post-tx/dispatch-approved.ts`),
 * so a busy lease defers the wake and any number of transcript rows can land in
 * between. The model was being told something untrue about its own transcript,
 * on the one path where it has to reason about whether a real action happened.
 *
 * No `tool_call_id` is interpolated as a "stable reference". It would be one,
 * but it is model-authored text landing inside an `[Engine: ...]` banner — the
 * exact shape `sanitizeRejectReason` below exists to defuse — and the wire
 * format already binds every tool result to its call by that id, so the model
 * can locate the row without the engine quoting it back.
 *
 * Deliberately NOT `addOperatorCue` — that banner means "the user interrupted
 * you", which is the opposite of what happened here.
 */
export const APPROVAL_RESOLVED_CUE =
  "[Engine: approval_resolved — the pending approval was resolved. Its result " +
  "is recorded in this conversation as the tool result for the tool call that " +
  "was awaiting approval; other messages may have been recorded after it. " +
  "Continue.]";

/**
 * Cue variant for the ONE case where the engine can prove the action happened:
 * the approval was decided `approved` AND its execution status is durably
 * `succeeded`. Only then may the cue say the transaction executed.
 *
 * Every other arm — `rejected`, expired, policy-drift, `failed`, and above all
 * `indeterminate` — keeps `APPROVAL_RESOLVED_CUE`, which claims nothing about
 * execution. That split is the whole point (rules/90: never claim more than
 * the evidence supports). Telling the model "it executed" on an indeterminate
 * dispatch would be inventing a money-path result nobody observed; telling it
 * nothing on a proven success made it re-ask the user whether the transaction
 * had gone through, which is the complaint this variant answers.
 *
 * "Do not repeat it" is stated explicitly because the failure mode of a
 * success the model does not recognise is a duplicate on-chain action.
 *
 * The verification pointer is hedged with "if available": tool availability is
 * per-session, and naming a tool the session cannot call would be another
 * small untruth in a banner whose entire value is that it does not contain
 * any.
 */
export const APPROVAL_RESOLVED_EXECUTED_CUE =
  "[Engine: approval_resolved — the pending approval was APPROVED and the " +
  "action executed successfully. Its result is recorded in this conversation " +
  "as the tool result for the tool call that was awaiting approval; other " +
  "messages may have been recorded after it. The transaction has already " +
  "happened — do not repeat it. You can verify the resulting on-chain / " +
  "portfolio state with the `AgentScan` tool if it is available to you. " +
  "Continue.]";

/**
 * How old a `dispatching` stamp must be before the reconciler will even
 * CONSIDER calling it abandoned. Set above `LEASE_TTL_MS` so a runner that is
 * merely slow (but still heartbeating) is never in scope.
 *
 * This threshold is necessary but NOT sufficient: the reconciler additionally
 * requires that no unexpired runner lease exists. Age alone can never prove
 * staleness, because a heartbeated lease legitimately outlives any fixed age —
 * and converting a healthy in-flight money-path dispatch into "unknown" would
 * be a false alarm on the one path where honesty matters most.
 */
export const STALE_DISPATCH_THRESHOLD_MS = 10 * 60_000;

/**
 * Tool-result content for an approved dispatch whose outcome cannot be proven.
 *
 * The process died between the `dispatching` mark and the result commit, so we
 * know the tool MAY have run and we know we must never run it again. The agent
 * is told exactly that — not "it failed" (which invites a retry that could
 * double-spend) and not "it succeeded" (which invents a result we never saw).
 */
export const TOOL_RESULT_INDETERMINATE_MESSAGE =
  "Approved tool call outcome unknown: the runtime stopped after dispatch and " +
  "before the result was recorded. The action was NOT retried and will not be " +
  "retried automatically. Verify the on-chain / provider state before taking " +
  "any further action on it.";

/** Upper bound on the user-authored reject reason (also enforced in Zod). */
export const REJECT_REASON_MAX_LENGTH = 500;

/**
 * Normalise a user-authored reject reason before it becomes model-visible
 * transcript text.
 *
 * The reason is untrusted input that lands in a document the agent re-reads
 * every turn, so it is length-bound and stripped of control characters —
 * newlines included. Without that, a reason could forge extra lines that read
 * like engine banners (`[Engine: ...]`) and try to pass themselves off as
 * runtime instructions rather than as something a human typed.
 */
export function sanitizeRejectReason(raw: string): string {
  const collapsed = raw.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  return collapsed.slice(0, REJECT_REASON_MAX_LENGTH);
}

export function shortSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function summarizeErrorForLog(cause: unknown): {
  errorKind: string;
  errorHash: string;
} {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    errorKind:
      cause instanceof Error ? cause.constructor.name : typeof cause,
    errorHash: shortSha256(message),
  };
}

/**
 * Build a structural-only tool-result content for a dispatch failure.
 *
 * Codex puzzle-5 phase-3 review point 3 — tool/protocol/wallet errors can
 * contain API keys, bearer tokens, DB URLs, private keys, seed fragments,
 * and arbitrary request payloads. Persisting any of that into the
 * transcript (which the agent re-reads on every turn) is a leak vector.
 *
 * The agent only needs to know "the dispatch failed" + a stable identifier
 * to correlate with the structural log line — `errorHash` is the cross-log
 * correlation key. Raw / redacted message text is intentionally absent.
 */
export function buildDispatchFailedToolResultContent(
  errorKind: string,
  errorHash: string,
): string {
  return `Tool dispatch failed: ${errorKind}. Error hash: ${errorHash}.`;
}

export function buildPolicyDriftToolResultContent(): string {
  return TOOL_RESULT_POLICY_DRIFT_MESSAGE;
}

export function buildRejectedToolResultContent(reason: string | null): string {
  const effective =
    reason && reason.length > 0 ? reason : TOOL_RESULT_REJECTED_DEFAULT_REASON;
  return `Tool call rejected by user.\nReason: ${effective}`;
}

export function toIsoNow(): string {
  return new Date().toISOString();
}

export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toIsoOrNull(
  value: Date | string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

interface ToolCallShape {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
}

/**
 * Extract tool name + args from the JSONB-stored `approval_queue.tool_call`.
 * Supports both `{command, args}` (canonical enqueue shape) and the legacy
 * `{name, arguments}` shape — same approach as the original
 * `approveAndResume` extraction.
 */
export function extractToolCall(
  rawToolCall: Record<string, unknown>,
  fallbackToolCallId: string,
): ToolCallShape {
  const name = (rawToolCall.command ?? rawToolCall.name) as string | undefined;
  const args = (rawToolCall.args ?? rawToolCall.arguments ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      "Approval tool_call missing command/name — cannot dispatch",
    );
  }
  return { toolName: name, toolArgs: args, toolCallId: fallbackToolCallId };
}
