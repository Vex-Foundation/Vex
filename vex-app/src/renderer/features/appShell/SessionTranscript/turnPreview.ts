/**
 * THE TURN-SCOPED PREVIEW — what the transcript renders as "the turn in
 * flight", from the instant of the send to the instant the turn settles.
 *
 * Two owner findings converge here, and they are the same defect seen from
 * two ends:
 *
 * 1. THE GHOST MOMENT ("moment wysłania wiadomości, nic nie ma na ekranie i
 *    user myśli że nic nie działa"). The `streamStore` preview materializes on
 *    the FIRST provider delta — a full round-trip after the send. Until then
 *    the transcript showed nothing at all, so the send read as a no-op.
 *
 * 2. THE MID-TURN JUMP ("wywołał tool i przesunęło mnie w górę konwersacji").
 *    The store preview is ROUND-scoped: it is retired when the round's
 *    assistant row persists, including the tool_call row in the MIDDLE of a
 *    turn. A null preview retires the anchor run-out spacer, which collapses
 *    the scroll range under an anchored user message, and the browser clamps
 *    scrollTop — the reader is thrown up the conversation.
 *
 * The fix for both is one idea: the surface is scoped to the TURN, not to the
 * provider round. `chat.submit`'s mutation is pending for the whole turn
 * (every provider round AND tool execution — see `useIsChatSubmitting`), so it
 * is the honest turn boundary.
 *
 * WHY A SYNTHETIC VIEW AND NOT A PENDING ENTRY IN `streamStore`: the store's
 * `streamId` correlation is load-bearing for abort safety — `getLiveStreamId`
 * decides whether an `aborted` delta belongs to the displayed stream or to a
 * superseded one, and the idle-timer/clear ownership hangs off the same id. A
 * pending entry would have no real streamId, so it would either need a fake
 * one (poisoning that correlation) or a null case threaded through every
 * consumer. The store stays a pure projection of what the ENGINE actually
 * said; "a turn is in flight and has not spoken yet" is a RENDERER fact and is
 * derived here, where it costs nothing and can lie to no one.
 */

import { useRef } from "react";
import type { StreamPreview } from "../../../stores/streamStore.js";

/**
 * The preview to render for this turn, or `null` when no turn is in flight.
 *
 * Precedence is simple and total: a REAL preview always wins, because the
 * engine speaking beats the renderer's placeholder. The placeholder covers
 * exactly two gaps — before the first delta, and between the rounds of a
 * multi-round turn — and it carries the TURN's start time, so the elapsed
 * counter runs from the send rather than restarting per round.
 *
 * Not a store, not an effect: a ref pinned on the submitting edge. The
 * placeholder identity is stable while a turn runs, so it cannot churn the
 * memoized subtrees below it.
 */
export function useTurnPreview(
  preview: StreamPreview | null,
  submitting: boolean,
): StreamPreview | null {
  // When the CURRENT turn began. Pinned once per turn so the elapsed counter
  // measures the turn the operator is waiting on, not the provider round the
  // engine happens to be in.
  const turnStartedAtMs = useRef<number | null>(null);
  const placeholder = useRef<StreamPreview | null>(null);

  if (!submitting) {
    // The turn settled: nothing may outlive it, or the next send would reopen
    // on a stale clock.
    turnStartedAtMs.current = null;
    placeholder.current = null;
    return preview;
  }

  turnStartedAtMs.current ??= preview?.startedAtMs ?? Date.now();
  const startedAtMs = turnStartedAtMs.current;

  if (preview !== null) {
    placeholder.current = null;
    return startedAtMs === preview.startedAtMs
      ? preview
      : { ...preview, startedAtMs };
  }
  if (placeholder.current === null) {
    placeholder.current = {
      streamId: PENDING_TURN_STREAM_ID,
      text: "",
      phase: "streaming",
      toolName: null,
      reasoningSegments: [],
      reasoningText: "",
      reasoningTokens: null,
      startedAtMs,
      status: "working",
      errorType: null,
    };
  }
  return placeholder.current;
}

/**
 * The placeholder's streamId. Deliberately NOT a uuid and never sent anywhere:
 * it exists only so the value is a total `StreamPreview`, and it can never
 * collide with an engine stream id.
 */
export const PENDING_TURN_STREAM_ID = "pending-turn";
