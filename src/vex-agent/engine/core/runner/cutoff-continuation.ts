/**
 * Cut-off answer continuation (Kairos R-9) - what the turn loop does with a
 * text answer the output limit cut short.
 *
 * A round that ends on `finish_reason: "length"` with answer text and no tool
 * call is productive (it has text), so before this existed the fragment was
 * saved as if it were the whole answer and the user read a reply that stopped
 * mid-sentence with nothing saying so.
 *
 * Instead, once per cut-off answer:
 *
 * 1. The fragment is held back, not persisted.
 * 2. ONE continuation call is issued. Its envelope carries the fragment as the
 *    last assistant message and a one-shot turn-state note asking the model to
 *    continue exactly where it stopped. Neither is written to the transcript
 *    or to the live tape: they exist for that one request only. Effort is NOT
 *    lowered - the model is mid-answer, not stalled.
 * 3. Fragment + continuation are saved as ONE assistant row (which also takes
 *    a board staged earlier in the turn).
 * 4. If the continuation is cut off too, ends without a clear completion
 *    signal (no finish reason, or anything but `stop`), or produces nothing
 *    usable (blank, reasoning only, stopped by an inference bound), what
 *    exists is saved with a visible trailing marker, so a truncated answer is
 *    never presented as a complete one.
 *
 * Never applied to a round with tool calls: a tool-call round cut off by the
 * output limit is an incomplete batch and is refused whole elsewhere
 * (`unproductive-rounds.ts`). If the continuation itself answers with tool
 * calls, the fragment is saved on its own row (with the marker) and the tool
 * round proceeds through the normal classification and dispatch path.
 *
 * `CUTOFF_CONTINUATION_ENABLED = false` restores the previous behaviour
 * exactly: the fragment is saved as-is.
 */

import type { Message } from "@vex-agent/db/repos/messages.js";
import type { InferenceStallKind } from "@vex-agent/inference/stream-consumer.js";

/** Switch for the whole mechanism. `false` = save the cut-off fragment as-is. */
export const CUTOFF_CONTINUATION_ENABLED = true;

/** The one-shot turn-state note sent with the continuation call. */
export const CUTOFF_CONTINUATION_NOTE =
  "# Previous Answer Cut Off\n" +
  "Your previous answer was cut off at the output limit. Continue exactly " +
  "where it stopped, without repeating anything.";

/** Visible marker appended to an answer that is still incomplete when saved. */
export const CUTOFF_ANSWER_SUFFIX = "\n\n_(Answer cut off at the output limit.)_";

/** A held-back cut-off answer waiting for its continuation. */
export interface CutOffAnswer {
  readonly content: string;
  readonly reasoning: string | null;
}

/** The fields of a completed round this module reads. Structural, like `InferenceRoundFields`. */
export interface CutoffRoundFields {
  readonly content: string | null;
  readonly toolCalls: readonly unknown[] | null;
  readonly reasoning: string | null;
  readonly finishReason: string | null;
  readonly malformedToolCallCount: number;
  readonly timedOut: InferenceStallKind | null;
}

function hasToolCalls(round: CutoffRoundFields): boolean {
  return (round.toolCalls?.length ?? 0) > 0 || round.malformedToolCallCount > 0;
}

function hasText(content: string | null): content is string {
  return content !== null && content.trim().length > 0;
}

/**
 * The cut-off answer this round is, or null when it is not one: the output
 * limit ended it, it carries answer text, it has no tool call (valid or
 * dropped), and no inference bound stopped it.
 */
export function detectCutOffAnswer(round: CutoffRoundFields): CutOffAnswer | null {
  if (round.finishReason !== "length") return null;
  if (round.timedOut !== null) return null;
  if (hasToolCalls(round)) return null;
  if (!hasText(round.content)) return null;
  return { content: round.content, reasoning: round.reasoning };
}

/**
 * The messages the continuation request is built from: the live tape plus the
 * fragment as the last assistant message. A copy - the live tape itself is
 * never touched, so the fragment cannot leak into a later request.
 */
export function continuationMessages(liveMessages: readonly Message[], partial: CutOffAnswer): Message[] {
  return [
    ...liveMessages,
    { role: "assistant", content: partial.content, timestamp: new Date().toISOString() },
  ];
}

/**
 * The one finish reason that proves a text continuation finished. The only
 * provider (OpenRouter) normalises every upstream to `tool_calls` | `stop` |
 * `length` | `content_filter` | `error` (an open enum); of those only `stop`
 * says the model ended its answer on its own. Anything else - including no
 * finish reason at all, which is what a stream that simply stopped arriving
 * leaves behind - is not proof of a complete answer.
 */
const COMPLETED_FINISH_REASON = "stop";

/** How the continuation ended. Sanitised enum, safe to log. */
export type CutoffContinuationOutcome =
  | "completed"
  | "still_cut_off"
  /** Text arrived but the round ended with no finish reason or an unrecognised one. */
  | "ambiguous_end"
  | "unproductive"
  | "timed_out"
  | "tool_round";

export type CutoffResolution =
  /** Save `content` as the answer row: complete or marked. */
  | {
      readonly kind: "answer";
      readonly outcome: Exclude<CutoffContinuationOutcome, "tool_round">;
      readonly content: string;
      readonly reasoning: string | null;
    }
  /**
   * The continuation called tools: save the marked fragment as its own row,
   * then handle the round like any other tool round.
   */
  | {
      readonly kind: "tool_round";
      readonly outcome: "tool_round";
      readonly content: string;
      readonly reasoning: string | null;
    };

/** How far back into the partial a restarted line is looked for. */
const RESTART_SEARCH_WINDOW_CHARS = 4_000;
/** Shortest restarted line or repeated tail treated as an overlap, not a coincidence. */
const MIN_OVERLAP_CHARS = 12;

/**
 * Join a cut-off answer and its continuation without duplicating text.
 *
 * Models asked to "continue exactly where it stopped" do not always do so:
 * some restart the section they were in. Three shapes are handled, checked in
 * this order:
 * - the continuation's first line already appears as a line near the end of
 *   the partial (a restarted section): the partial is cut at that line and the
 *   continuation replaces its tail;
 * - the continuation opens by repeating the partial's last characters: the
 *   repeat is dropped;
 * - the continuation opens a markdown block (heading, list item, quote) right
 *   after unfinished text: it starts on a new paragraph.
 * Anything else is a mid-sentence continuation and is joined as-is.
 */
export function joinContinuation(partial: string, continuation: string): string {
  const firstLine = continuation.trimStart().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length >= MIN_OVERLAP_CHARS) {
    const windowStart = Math.max(0, partial.length - RESTART_SEARCH_WINDOW_CHARS);
    const lineStart = partial.lastIndexOf(`\n${firstLine}`);
    const at = lineStart >= windowStart ? lineStart + 1 : partial.startsWith(firstLine) ? 0 : -1;
    // Only a true restart: the partial's whole tail from that line must be
    // repeated at the start of the continuation, so nothing unique is dropped.
    const restarted = continuation.trimStart();
    if (at >= 0 && restarted.startsWith(partial.slice(at).trimEnd())) {
      return partial.slice(0, at) + restarted;
    }
  }

  const maxOverlap = Math.min(partial.length, continuation.length);
  for (let k = maxOverlap; k >= MIN_OVERLAP_CHARS; k--) {
    if (partial.endsWith(continuation.slice(0, k))) return partial + continuation.slice(k);
  }

  const opensBlock = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/.test(continuation);
  if (opensBlock && !/\n\s*$/.test(partial)) {
    return `${partial.replace(/\s+$/, "")}\n\n${continuation.trimStart()}`;
  }
  return partial + continuation;
}

function joinReasoning(first: string | null, second: string | null): string | null {
  const parts = [first, second].filter((r): r is string => r !== null && r.trim().length > 0);
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** Decide what to save once the continuation round has come back (not aborted). */
export function resolveCutoffContinuation(
  partial: CutOffAnswer,
  continuation: CutoffRoundFields,
): CutoffResolution {
  const marked = partial.content + CUTOFF_ANSWER_SUFFIX;
  if (continuation.timedOut !== null) {
    // A bound stopped it: its text is an unfinished fragment of a fragment and
    // is never persisted, exactly as for any timed-out round.
    return { kind: "answer", outcome: "timed_out", content: marked, reasoning: partial.reasoning };
  }
  if (hasToolCalls(continuation)) {
    return { kind: "tool_round", outcome: "tool_round", content: marked, reasoning: partial.reasoning };
  }
  if (!hasText(continuation.content)) {
    return { kind: "answer", outcome: "unproductive", content: marked, reasoning: partial.reasoning };
  }
  const joined = joinContinuation(partial.content, continuation.content);
  const reasoning = joinReasoning(partial.reasoning, continuation.reasoning);
  if (continuation.finishReason === "length") {
    return { kind: "answer", outcome: "still_cut_off", content: joined + CUTOFF_ANSWER_SUFFIX, reasoning };
  }
  if (continuation.finishReason !== COMPLETED_FINISH_REASON) {
    // No clear completion: keep what arrived, but never present it as whole.
    return { kind: "answer", outcome: "ambiguous_end", content: joined + CUTOFF_ANSWER_SUFFIX, reasoning };
  }
  return { kind: "answer", outcome: "completed", content: joined, reasoning };
}

/** The row saved when the turn stops while the continuation is outstanding or in flight. */
export function stoppedCutoffContent(partial: CutOffAnswer, streamed: string | null): string {
  return streamed === null ? partial.content : joinContinuation(partial.content, streamed);
}

/** Reasoning for a stopped continuation row. */
export function stoppedCutoffReasoning(partial: CutOffAnswer, streamed: string | null): string | null {
  return joinReasoning(partial.reasoning, streamed);
}
