/**
 * Stall recovery - what the turn loop does INSTEAD of replaying a round that
 * produced nothing.
 *
 * An unproductive round (`incomplete_tool_batch`, `reasoning_exhausted`,
 * `blank`, `stream_timeout`; see `unproductive-rounds.ts`) persists nothing, so the next round
 * would otherwise see the identical input and is likely to fail the identical
 * way. Once per stall streak the next inference call is a RECOVERY call that
 * differs from the failed one in two bounded ways:
 *
 * 1. A one-shot note in the TURN-STATE layer telling the model how its last
 *    attempt ended and to act now. It rides in the trailing system block for
 *    that one request only; it is never written to the transcript.
 * 2. For that one call only, reasoning effort drops to "low", so a model that
 *    spent its whole output budget thinking has room left to act. This is
 *    guarded: it applies only once the CURRENT request (everything after the
 *    latest user message) has shown itself to be read-only work - at least
 *    one tool call since that message, every one of them a pure read - and
 *    never while an approval is pending. A fresh request with no call yet
 *    may be a fund-moving one, whatever tools earlier requests used, and
 *    deserves full deliberation. When the guard refuses, the note is still
 *    sent.
 *
 * If the recovery call is also unproductive the streak simply keeps counting
 * toward `MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS`; there is no second recovery in
 * the same streak. A productive round ends the streak, so a later stall may
 * recover again.
 *
 * `STALL_RECOVERY_ENABLED = false` restores the previous behaviour exactly:
 * no note, no effort change, no extra reads.
 */

import type { InferenceConfig, ReasoningEffort } from "@vex-agent/inference/types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { PromptStackOptions } from "../../prompts/index.js";
import { getToolDef } from "@vex-agent/tools/registry.js";
import type { InferenceRoundClassification, UnproductiveRoundKind } from "./unproductive-rounds.js";

/** Switch for the whole mechanism. `false` = no note, no effort change. */
export const STALL_RECOVERY_ENABLED = true;

/** The effort a recovery call is lowered to when the guard allows it. */
export const STALL_RECOVERY_EFFORT: ReasoningEffort = "low";

/**
 * Explicit order over the effort levels, lowest first. Written out rather than
 * derived from the union so a new level is a compile error here, not a silent
 * guess.
 */
const EFFORT_RANK: Readonly<Record<ReasoningEffort, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const NOTE_HEADING = "# Last Attempt Produced No Action";

const NOTE_BODY: Readonly<Record<UnproductiveRoundKind, string>> = {
  reasoning_exhausted:
    "Your last attempt ran out of output room while reasoning and produced no action. Act now: call the next tool with complete arguments, or give your answer.",
  incomplete_tool_batch:
    "Your last tool call arguments were cut off or malformed, so none of those calls ran. Re-issue only the calls you still need, with complete, valid arguments.",
  blank: "Your last reply was empty. Continue: call the next tool or give your answer.",
  stream_timeout:
    "Your last attempt took too long without producing an action and was stopped. Act now: call the next tool with complete arguments, or give your answer.",
};

/** The one-shot turn-state note for a recovery call after `kind`. */
export function buildStallRecoveryNote(kind: UnproductiveRoundKind): string {
  return `${NOTE_HEADING}\n${NOTE_BODY[kind]}`;
}

/**
 * Tracks the one recovery a stall streak is allowed.
 *
 * `observe` is fed every classified round; `pending` says whether the next
 * call should recover (and from what); `consume` is called only when that
 * call is actually issued, so a request the byte ceiling refused does not use
 * the streak's recovery up.
 */
export interface StallRecoveryTracker {
  observe(round: InferenceRoundClassification): void;
  pending(): UnproductiveRoundKind | null;
  consume(): void;
  /**
   * True once the streak's recovery call was issued and the round it produced
   * was unproductive too. The turn ends there: the only thing left to send is
   * the original request again, which is the identical replay recovery exists
   * to prevent.
   */
  recoveryFailed(): boolean;
}

export function createStallRecoveryTracker(enabled: boolean): StallRecoveryTracker {
  let armed: UnproductiveRoundKind | null = null;
  let usedInStreak = false;
  let failed = false;
  return {
    observe(round) {
      if (round.kind === "productive") {
        armed = null;
        usedInStreak = false;
        failed = false;
        return;
      }
      if (usedInStreak) {
        failed = true;
        return;
      }
      if (!enabled) return;
      armed = round.kind;
    },
    pending: () => armed,
    recoveryFailed: () => failed,
    consume() {
      if (armed === null) return;
      armed = null;
      usedInStreak = true;
    },
  };
}

/** Why a recovery call kept its effort. Sanitised enum, safe to log. */
export type EffortGuardReason =
  | "effort_unsupported"
  | "effort_provider_default"
  | "effort_not_above_low"
  | "no_current_request_evidence"
  | "non_read_tool_call"
  | "pending_approval"
  | "pending_approval_unreadable";

export type RecoveryEffortDecision =
  | { readonly lowered: true; readonly from: ReasoningEffort; readonly to: ReasoningEffort }
  | { readonly lowered: false; readonly reason: EffortGuardReason };

/**
 * Tool names of every assistant tool call made for the CURRENT request: the
 * calls after the latest `user` row on the live tape. Operator messages and
 * mid-run operator instructions are persisted as `user` rows; engine-injected
 * notices and cues are `system` rows and tool results are `tool` rows, so
 * neither starts a new request. With no `user` row on the tape at all (a
 * compacted or engine-started run), the whole tape is the current request.
 * Empty when the current request has not called anything yet.
 */
function currentRequestToolNames(messages: readonly Message[]): string[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }
  const names: string[] = [];
  for (const message of messages.slice(start)) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) names.push(call.command);
  }
  return names;
}

/** A pure read: registered, classified `read`, and not flagged mutating. Unknown names are not. */
function isReadOnlyTool(name: string): boolean {
  const def = getToolDef(name);
  return def !== undefined && def.actionKind === "read" && !def.mutating;
}

/**
 * Decide whether a recovery call may lower effort. Cheap in-memory checks run
 * first so the one DB read (pending approvals) happens only when everything
 * else already allows lowering. Any doubt keeps the configured effort: an
 * unreadable approval state counts as pending.
 */
export async function decideRecoveryEffort(input: {
  readonly config: InferenceConfig;
  readonly liveMessages: readonly Message[];
  /** Approvals this loop already parked in memory. */
  readonly inLoopPendingApprovals: number;
  readonly hasPendingApproval: () => Promise<boolean>;
}): Promise<RecoveryEffortDecision> {
  const current = input.config.reasoningEffort;
  if (!input.config.supportsReasoningEffort) return { lowered: false, reason: "effort_unsupported" };
  // No explicit effort = the provider's own default, whose level is unknown.
  if (current === undefined) return { lowered: false, reason: "effort_provider_default" };
  if (EFFORT_RANK[current] <= EFFORT_RANK[STALL_RECOVERY_EFFORT]) {
    return { lowered: false, reason: "effort_not_above_low" };
  }
  const currentCalls = currentRequestToolNames(input.liveMessages);
  // No call yet for this request = no evidence it is read-only work; earlier
  // requests' history says nothing about what this one will do.
  if (currentCalls.length === 0) return { lowered: false, reason: "no_current_request_evidence" };
  if (!currentCalls.every(isReadOnlyTool)) {
    return { lowered: false, reason: "non_read_tool_call" };
  }
  if (input.inLoopPendingApprovals > 0) return { lowered: false, reason: "pending_approval" };
  try {
    if (await input.hasPendingApproval()) return { lowered: false, reason: "pending_approval" };
  } catch {
    return { lowered: false, reason: "pending_approval_unreadable" };
  }
  return { lowered: true, from: current, to: STALL_RECOVERY_EFFORT };
}

/** The request a recovery call is issued with, and why it looks the way it does. */
export interface StallRecoveryCall {
  readonly from: UnproductiveRoundKind;
  readonly config: InferenceConfig;
  readonly promptOptions: PromptStackOptions;
  readonly effort: RecoveryEffortDecision;
}

/**
 * Build the recovery call from this iteration's config and prompt options.
 * Both are copied, never mutated, so the lowered effort and the note exist for
 * this one request only.
 */
export async function prepareStallRecoveryCall(input: {
  readonly from: UnproductiveRoundKind;
  readonly config: InferenceConfig;
  readonly promptOptions: PromptStackOptions;
  readonly liveMessages: readonly Message[];
  readonly inLoopPendingApprovals: number;
  readonly hasPendingApproval: () => Promise<boolean>;
}): Promise<StallRecoveryCall> {
  const effort = await decideRecoveryEffort(input);
  return {
    from: input.from,
    config: effort.lowered ? { ...input.config, reasoningEffort: effort.to } : input.config,
    promptOptions: { ...input.promptOptions, stallRecoveryNote: buildStallRecoveryNote(input.from) },
    effort,
  };
}

/** Sanitised fields for `engine.turn.stall_recovery`: enums only. */
export function stallRecoveryLogFields(call: StallRecoveryCall): {
  previousClassification: UnproductiveRoundKind;
  effortLowered: boolean;
  effortFrom: ReasoningEffort | null;
  effortTo: ReasoningEffort | null;
  guardReason: EffortGuardReason | null;
} {
  return {
    previousClassification: call.from,
    effortLowered: call.effort.lowered,
    effortFrom: call.effort.lowered ? call.effort.from : (call.config.reasoningEffort ?? null),
    effortTo: call.effort.lowered ? call.effort.to : (call.config.reasoningEffort ?? null),
    guardReason: call.effort.lowered ? null : call.effort.reason,
  };
}
