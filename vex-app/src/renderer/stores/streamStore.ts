/**
 * Ephemeral stream-preview store (Stage 9-3, extended by S4 working strip).
 *
 * Holds the in-flight token-by-token preview for the active turn, keyed by
 * session. This is NOT the canonical transcript — it is a transient visual
 * preview that is discarded the moment the persisted message DTO arrives
 * (see `useStreamPreviewSync`). Per `vex-renderer-frontend`:
 *  - it is UI-only Zustand state, never persisted (agent traces must not be
 *    written to disk);
 *  - it never mirrors the Query Cache source of truth — the persisted
 *    messages live in TanStack Query, this holds only the un-persisted tail.
 *
 * S4 surfaces the reasoning deltas in the working strip (`StreamingBubble`),
 * still under the same honest-ephemerality rule: the trace lives ONLY here,
 * vanishes with the preview, and is never written anywhere. Reasoning arrives
 * token-by-token, so it is batched (one state write per ~80ms window) instead
 * of thrashing React per token; see `applyDelta`.
 *
 * A single response is bounded by the engine's max output tokens, so `text`
 * does not grow without bound; `reasoningText` is explicitly capped.
 */

import { create } from "zustand";
import type { StreamDeltaEvent } from "@shared/schemas/stream.js";

export type StreamPhase = "streaming" | "done" | "error";

/**
 * What the turn is doing right now — DERIVED from delta kinds, never a new
 * wire phase. The rule (see `deriveStatus`): a non-empty `text` buffer pins
 * "writing"; otherwise the last reasoning/tool_call delta wins ("thinking" /
 * "calling"); every other delta kind keeps the previous status; a fresh
 * preview starts as "working".
 */
export type StreamWorkingStatus = "working" | "thinking" | "calling" | "writing";

/** Keep only the newest reasoning chars: bounds memory + expanded-trace DOM on very long traces. */
export const REASONING_TEXT_CAP = 16_384;

/** Reasoning batch window — one store write per window, not per token. */
export const REASONING_FLUSH_MS = 80;

export interface StreamPreview {
  /** Per-turn stream id; a new id resets the preview. */
  readonly streamId: string;
  /** Accumulated assistant text (markdown), bounded by max output tokens. */
  readonly text: string;
  readonly phase: StreamPhase;
  /** Last tool name seen on this stream (shown only while text is empty). */
  readonly toolName: string | null;
  /** Live reasoning trace — ephemeral, capped at `REASONING_TEXT_CAP`. */
  readonly reasoningText: string;
  /** Reasoning token count from the latest usage delta (null until seen). */
  readonly reasoningTokens: number | null;
  /** Wall-clock ms when this preview was created — drives the elapsed counter. */
  readonly startedAtMs: number;
  /** Derived working status — see `StreamWorkingStatus` for the rule. */
  readonly status: StreamWorkingStatus;
  /**
   * OpenRouter's canonical `ApiErrorType` from the error delta that ended this
   * stream, or `null`. An OPEN enum carried verbatim — the bubble maps it
   * through `classifyEngineFailure` (total default) and never switches on it.
   * Kept so an errored preview can say WHY instead of only "Stream error";
   * the delta's `message` is a safe generic by design and says nothing.
   */
  readonly errorType: string | null;
}

interface StreamStoreState {
  readonly bySessionId: Readonly<Record<string, StreamPreview | undefined>>;
  readonly applyDelta: (sessionId: string, event: StreamDeltaEvent) => void;
  readonly clear: (sessionId: string) => void;
}

/** Fresh preview for a newly-seen streamId. */
function startPreview(streamId: string): StreamPreview {
  return {
    streamId,
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: Date.now(),
    status: "working",
    errorType: null,
  };
}

/** Existing preview for this stream, or a fresh one (a new stream supersedes). */
function resolveBase(
  prev: StreamPreview | undefined,
  streamId: string,
): StreamPreview {
  return prev !== undefined && prev.streamId === streamId
    ? prev
    : startPreview(streamId);
}

/**
 * The status-derivation rule, in one place: a non-empty answer buffer pins
 * "writing" (a late reasoning burst must not flip the strip back once the
 * answer is visibly streaming); otherwise the last reasoning/tool_call delta
 * wins; usage/done/error and empty text deltas keep the previous status.
 */
function deriveStatus(
  prev: StreamWorkingStatus,
  textLength: number,
  kind: StreamDeltaEvent["delta"]["kind"],
): StreamWorkingStatus {
  if (textLength > 0) return "writing";
  if (kind === "reasoning") return "thinking";
  if (kind === "tool_call") return "calling";
  return prev;
}

/** Append a reasoning chunk, trimming to the newest `REASONING_TEXT_CAP` chars. */
function appendReasoning(base: StreamPreview, chunk: string): StreamPreview {
  const joined = base.reasoningText + chunk;
  return {
    ...base,
    // slice(-cap) keeps the LAST cap chars — the oldest trace is trimmed first.
    reasoningText:
      joined.length > REASONING_TEXT_CAP
        ? joined.slice(-REASONING_TEXT_CAP)
        : joined,
    status: deriveStatus(base.status, base.text.length, "reasoning"),
  };
}

/** Pure reducer: previous preview + delta → next preview. Exported for tests. */
export function reducePreview(
  prev: StreamPreview | undefined,
  event: StreamDeltaEvent,
): StreamPreview {
  // A delta from a new stream supersedes any earlier preview for the session.
  const base = resolveBase(prev, event.streamId);

  switch (event.delta.kind) {
    case "text": {
      const text = base.text + event.delta.text;
      return {
        ...base,
        phase: "streaming",
        text,
        status: deriveStatus(base.status, text.length, "text"),
      };
    }
    case "tool_call":
      return {
        ...base,
        toolName: event.delta.toolCallName ?? base.toolName ?? "tool",
        status: deriveStatus(base.status, base.text.length, "tool_call"),
      };
    case "reasoning":
      // Pure per-delta append keeps the reducer total + unit-testable; the
      // store path batches reasoning instead (see `applyDelta`).
      return appendReasoning(base, event.delta.text);
    case "usage":
      // Surfaces as the strip's "Reasoned · N tokens" summary. A usage delta
      // without the optional field keeps the last seen value.
      return {
        ...base,
        reasoningTokens: event.delta.usage.reasoningTokens ?? base.reasoningTokens,
      };
    case "done":
      return { ...base, phase: "done" };
    case "error":
      return { ...base, phase: "error", errorType: event.delta.errorType ?? null };
    case "aborted":
      // The preview is retired by the live-sync hook, which owns the clear and
      // the streamId correlation. The reducer only records that the stream is
      // no longer running, so nothing renders as still-streaming in the window
      // between the abort and the clear.
      return { ...base, phase: "done" };
  }
}

/**
 * Reasoning batching: deltas accumulate here and flush into the store in ONE
 * setState per `REASONING_FLUSH_MS` window — a per-token setState would
 * re-render the transcript at provider token rate. Keyed by sessionId (one
 * live stream per session); the recorded streamId guards a flush against a
 * superseding stream. Module-level on purpose: timers are not React state and
 * must outlive individual component renders, but never the preview itself —
 * `clear` cancels them.
 */
interface PendingReasoning {
  readonly streamId: string;
  text: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

const pendingReasoningBySession = new Map<string, PendingReasoning>();

function cancelPendingReasoning(sessionId: string): void {
  const pending = pendingReasoningBySession.get(sessionId);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  pendingReasoningBySession.delete(sessionId);
}

/** Apply the buffered reasoning text to the store in a single state write. */
function flushPendingReasoning(sessionId: string): void {
  const pending = pendingReasoningBySession.get(sessionId);
  if (pending === undefined) return;
  cancelPendingReasoning(sessionId);
  useStreamStore.setState((state) => ({
    bySessionId: {
      ...state.bySessionId,
      [sessionId]: appendReasoning(
        resolveBase(state.bySessionId[sessionId], pending.streamId),
        pending.text,
      ),
    },
  }));
}

/**
 * The streamId currently OWNING this session's preview, materialized or not.
 *
 * A reasoning-only stream lives purely in the batching buffer for its first
 * `REASONING_FLUSH_MS`, with no `bySessionId` entry yet. A consumer that
 * correlates on the materialized entry alone would read "no live stream" and
 * mistake that stream's own abort for a stale one — then the buffer would
 * flush a moment later and the orphaned preview would survive to the idle
 * timer. Reading the buffer here is what makes the correlation total.
 */
export function getLiveStreamId(sessionId: string): string | undefined {
  return (
    useStreamStore.getState().bySessionId[sessionId]?.streamId
    ?? pendingReasoningBySession.get(sessionId)?.streamId
  );
}

/** Test-only: drop every pending reasoning buffer + timer (isolation between tests). */
export function __resetPendingReasoningForTests(): void {
  for (const sessionId of [...pendingReasoningBySession.keys()]) {
    cancelPendingReasoning(sessionId);
  }
}

export const useStreamStore = create<StreamStoreState>((set) => ({
  bySessionId: {},
  applyDelta: (sessionId, event) => {
    if (event.delta.kind === "reasoning") {
      const pending = pendingReasoningBySession.get(sessionId);
      if (pending !== undefined && pending.streamId === event.streamId) {
        pending.text += event.delta.text;
        return; // a flush is already scheduled for this window
      }
      // A buffer from a superseded stream is stale — drop it; the new
      // stream's first flush resets the preview via resolveBase anyway.
      cancelPendingReasoning(sessionId);
      pendingReasoningBySession.set(sessionId, {
        streamId: event.streamId,
        text: event.delta.text,
        timer: setTimeout(() => flushPendingReasoning(sessionId), REASONING_FLUSH_MS),
      });
      return;
    }
    // Any non-reasoning delta forces the buffered trace into state FIRST so
    // delta ordering survives batching (e.g. the trace a tool call follows is
    // visible before status flips to "calling").
    flushPendingReasoning(sessionId);
    set((state) => ({
      bySessionId: {
        ...state.bySessionId,
        [sessionId]: reducePreview(state.bySessionId[sessionId], event),
      },
    }));
  },
  clear: (sessionId) => {
    // The pending buffer + timer die with the preview — no orphan timers.
    cancelPendingReasoning(sessionId);
    set((state) => {
      if (state.bySessionId[sessionId] === undefined) return state;
      const next = { ...state.bySessionId };
      delete next[sessionId];
      return { bySessionId: next };
    });
  },
}));

/** Read-only selector for the active session's preview (null when none). */
export function useStreamPreview(sessionId: string | null): StreamPreview | null {
  return useStreamStore((s) =>
    sessionId === null ? null : s.bySessionId[sessionId] ?? null,
  );
}
