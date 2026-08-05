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
 * vanishes with the preview, and is never written anywhere. Reasoning AND
 * answer text arrive token-by-token and go through ONE coalescing path (owner
 * decree 2026-08-03) — a single flush window per session, never a second
 * mechanism per delta kind; see `applyDelta`.
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

/**
 * Delta coalescing window — one store write per window for EVERY streamed
 * delta kind, not one per token.
 *
 * One frame (~16ms), not the old 80ms reasoning window: the flush cost is now
 * bounded by the LIVE message alone (memoized markdown + memoized transcript
 * rows), so the cadence can sit at the display's own rate and the stream reads
 * as printing rather than trickling. A plain timer, not rAF, so the mechanism
 * is identical under jsdom, a hidden window, and a live renderer.
 */
export const STREAM_FLUSH_MS = 16;

export interface StreamPreview {
  /** Per-turn stream id; a new id resets the preview. */
  readonly streamId: string;
  /** Accumulated assistant text (markdown), bounded by max output tokens. */
  readonly text: string;
  readonly phase: StreamPhase;
  /** Last tool name seen on this stream (shown only while text is empty). */
  readonly toolName: string | null;
  /**
   * SETTLED reasoning segments for this TURN, oldest first (owner decree
   * 2026-07-30). A turn thinks, calls a tool, then thinks again — and the
   * second burst is a new thought, not a continuation. A `tool_call` delta
   * (or a round boundary) closes the active segment into this list, where the
   * UI renders it as a collapsed expandable stamp. Each entry is already
   * capped at `REASONING_TEXT_CAP`; the list is bounded by the engine's
   * per-turn tool-iteration limit.
   */
  readonly reasoningSegments: readonly string[];
  /**
   * The ACTIVE reasoning segment — the one still streaming, rendered inline.
   * `""` means no segment is open; the next `reasoning` delta opens a new one.
   * Ephemeral, capped at `REASONING_TEXT_CAP`.
   */
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
  /**
   * A ROUND ended but the TURN did not: the prose and tool calls this round
   * produced have just been persisted as a canonical transcript row, so the
   * preview must stop rendering its own copy — while staying alive, because
   * the turn continues into the next provider round. Settles the active
   * reasoning segment and keeps everything turn-scoped (segments, the turn
   * clock). No-op when the session has no preview.
   */
  readonly settleRound: (sessionId: string) => void;
  readonly clear: (sessionId: string) => void;
}

/** Fresh preview for a newly-seen turn. */
function startPreview(streamId: string): StreamPreview {
  return {
    streamId,
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningSegments: [],
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: Date.now(),
    status: "working",
    errorType: null,
  };
}

/**
 * Close the ACTIVE reasoning segment into the settled list. An empty active
 * buffer settles nothing — an expandable stamp that opens onto no text is a
 * worse lie than an absent one.
 */
function settleActiveSegment(base: StreamPreview): StreamPreview {
  if (base.reasoningText.length === 0) return base;
  return {
    ...base,
    reasoningSegments: [...base.reasoningSegments, base.reasoningText],
    reasoningText: "",
  };
}

/**
 * Begin the next ROUND of the SAME turn: the answer buffer, the tool name and
 * the error slot are round-scoped and reset; the reasoning segments and the
 * turn clock are TURN-scoped and survive.
 */
function startRound(prev: StreamPreview, streamId: string): StreamPreview {
  const settled = settleActiveSegment(prev);
  return {
    ...settled,
    streamId,
    text: "",
    phase: "streaming",
    toolName: null,
    status: "working",
    errorType: null,
  };
}

/**
 * The preview a delta applies to.
 *
 * DELIBERATE CHANGE (owner decree 2026-07-30, segmented reasoning): a new
 * streamId no longer SUPERSEDES the preview with a blank one. The engine
 * opens a fresh provider stream for every round of a multi-round turn, so
 * "new streamId" means "next round", not "next turn" — wiping here is what
 * made the second half of a turn's thinking vanish the moment a tool ran, and
 * what restarted the elapsed counter mid-turn. Turn boundaries are marked by
 * `clear`, which the live-sync hook owns; anything still standing when a new
 * streamId arrives therefore belongs to the same turn.
 */
function resolveBase(
  prev: StreamPreview | undefined,
  streamId: string,
): StreamPreview {
  if (prev === undefined) return startPreview(streamId);
  return prev.streamId === streamId ? prev : startRound(prev, streamId);
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
    case "tool_call": {
      // The tool call CLOSES the thought that led to it: whatever the model
      // reasoned up to this point is a finished segment, and any reasoning
      // that follows the tool's result is a new one.
      const settled = settleActiveSegment(base);
      return {
        ...settled,
        toolName: event.delta.toolCallName ?? base.toolName ?? "tool",
        status: deriveStatus(settled.status, settled.text.length, "tool_call"),
      };
    }
    case "reasoning":
      // Pure per-delta append keeps the reducer total + unit-testable; the
      // store path coalesces the deltas instead (see `applyDelta`).
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
 * THE ONE COALESCING PATH (owner decree 2026-08-03). Every streamed delta —
 * reasoning and answer text alike — queues here and lands in the store as ONE
 * setState per `STREAM_FLUSH_MS` window. There is no second, kind-specific
 * mechanism: a per-token setState re-rendered the transcript at provider token
 * rate, and having reasoning batched while text was not is what made the two
 * halves of a turn behave like different products.
 *
 * The queue holds the EVENTS, not a merged string, so the flush replays them
 * through the same `reducePreview` in arrival order — interleaved reasoning
 * and text can never reorder. Keyed by sessionId (one live stream per
 * session); the recorded streamId guards a flush against a superseding stream.
 * Module-level on purpose: timers are not React state and must outlive
 * individual component renders, but never the preview itself — `clear` cancels
 * them.
 */
interface PendingDeltas {
  readonly streamId: string;
  readonly events: StreamDeltaEvent[];
  readonly timer: ReturnType<typeof setTimeout>;
}

const pendingBySession = new Map<string, PendingDeltas>();

/**
 * The kinds that arrive token-by-token and are therefore worth waiting for.
 * Every other kind (`tool_call`, `usage`, `done`, `error`, `aborted`) is a
 * turn milestone: it queues behind whatever is buffered — so ordering still
 * survives — and then flushes the queue SYNCHRONOUSLY, because a finalize, an
 * abort or a tool call must be visible in the frame it happened.
 */
const COALESCED_KINDS: ReadonlySet<StreamDeltaEvent["delta"]["kind"]> = new Set([
  "text",
  "reasoning",
]);

function cancelPendingDeltas(sessionId: string): void {
  const pending = pendingBySession.get(sessionId);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  pendingBySession.delete(sessionId);
}

/** Replay the queued deltas into the store in a single state write. */
function flushPendingDeltas(sessionId: string): void {
  const pending = pendingBySession.get(sessionId);
  if (pending === undefined) return;
  cancelPendingDeltas(sessionId);
  useStreamStore.setState((state) => {
    let preview = state.bySessionId[sessionId];
    for (const event of pending.events) {
      preview = reducePreview(preview, event);
    }
    return { bySessionId: { ...state.bySessionId, [sessionId]: preview } };
  });
}

/**
 * Queue one delta for the next flush. A queue left over from a SUPERSEDED
 * stream is dropped rather than replayed: it belongs to a stream the engine
 * has already abandoned, and the new stream's first flush resolves its own
 * base through `resolveBase` anyway.
 */
function enqueueDelta(sessionId: string, event: StreamDeltaEvent): void {
  const pending = pendingBySession.get(sessionId);
  if (pending !== undefined && pending.streamId === event.streamId) {
    pending.events.push(event);
    return;
  }
  cancelPendingDeltas(sessionId);
  pendingBySession.set(sessionId, {
    streamId: event.streamId,
    events: [event],
    timer: setTimeout(() => flushPendingDeltas(sessionId), STREAM_FLUSH_MS),
  });
}

/**
 * The streamId currently OWNING this session's preview, materialized or not.
 *
 * A stream that has only emitted coalesced deltas lives purely in the queue
 * for its first `STREAM_FLUSH_MS`, with no `bySessionId` entry yet. A consumer
 * that correlates on the materialized entry alone would read "no live stream"
 * and mistake that stream's own abort for a stale one — then the queue would
 * flush a moment later and the orphaned preview would survive to the idle
 * timer. Reading the queue here is what makes the correlation total.
 */
export function getLiveStreamId(sessionId: string): string | undefined {
  return (
    useStreamStore.getState().bySessionId[sessionId]?.streamId
    ?? pendingBySession.get(sessionId)?.streamId
  );
}

/**
 * Force the queued tail of a session's stream into the store NOW.
 *
 * For consumers that observe a turn boundary the store cannot see: the
 * transcript append that persists a round arrives on its own IPC channel, and
 * it must never overtake the deltas of the round it persists — reading the
 * preview while the tail is still queued made the round look like it had no
 * live stream at all, and the queue then materialized an orphan preview a
 * frame after the clear that was supposed to retire it.
 */
export function flushStreamDeltas(sessionId: string): void {
  flushPendingDeltas(sessionId);
}

/** Test-only: drop every pending delta queue + timer (isolation between tests). */
export function __resetPendingDeltasForTests(): void {
  for (const sessionId of [...pendingBySession.keys()]) {
    cancelPendingDeltas(sessionId);
  }
}

export const useStreamStore = create<StreamStoreState>((set) => ({
  bySessionId: {},
  applyDelta: (sessionId, event) => {
    enqueueDelta(sessionId, event);
    if (COALESCED_KINDS.has(event.delta.kind)) return;
    flushPendingDeltas(sessionId);
  },
  settleRound: (sessionId) => {
    // Queued deltas belong to the round that is closing — flush them so the
    // trace lands in THAT round's segment rather than leaking into the next.
    flushPendingDeltas(sessionId);
    set((state) => {
      const prev = state.bySessionId[sessionId];
      if (prev === undefined) return state;
      return {
        bySessionId: {
          ...state.bySessionId,
          // Same streamId: the round is closing in place, and the next round's
          // first delta will carry the new id through `resolveBase` anyway.
          [sessionId]: startRound(prev, prev.streamId),
        },
      };
    });
  },
  clear: (sessionId) => {
    // The pending queue + timer die with the preview — no orphan timers.
    cancelPendingDeltas(sessionId);
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
