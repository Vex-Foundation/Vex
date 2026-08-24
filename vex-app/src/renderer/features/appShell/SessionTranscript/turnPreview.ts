/**
 * THE TURN-SCOPED PREVIEW — what the transcript renders as "the turn in
 * flight", from the instant of the send to the instant the turn settles.
 *
 * Two owner findings converge on the preview, and they are the same defect seen
 * from two ends:
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
 *
 * THE CENTRED-SCENE LATCH IS RETIRED (round 3). The synthetic preview above is
 * what makes the pending turn visible before the first engine delta; it is now
 * rendered by `TurnIsland`'s in-flow `vexing…` pill at the tail of the message
 * column, so there is no longer a viewport-covering surface whose mount needs
 * transcript evidence to justify itself. The whole eligibility machine
 * (baseline row id, send-edge observation, open/closed latch) went with it.
 */

import { useRef } from "react";
import type { StreamPreview } from "../../../stores/streamStore.js";

export interface TurnPreviewInput {
  /** The mounted session. A change resets the turn clock, synchronously. */
  readonly sessionId: string;
  /** The engine's round-scoped preview for this session, or null. */
  readonly preview: StreamPreview | null;
  /** `chat.submit` is pending for this session — the turn boundary. */
  readonly submitting: boolean;
}

export interface TurnPreviewResult {
  readonly preview: StreamPreview | null;
}

export function useTurnPreview(input: TurnPreviewInput): TurnPreviewResult {
  const { sessionId, preview, submitting } = input;

  const mountedSession = useRef<string | null>(null);
  // When the CURRENT turn began. Pinned once per turn so the elapsed counter
  // measures the turn the operator is waiting on, not the provider round the
  // engine happens to be in.
  const turnStartedAtMs = useRef<number | null>(null);
  const placeholder = useRef<StreamPreview | null>(null);

  // Session change → reset synchronously during render (the file's existing
  // render-time-ref idiom, not an effect): switching between two submitting
  // sessions must never inherit the other's clock.
  if (mountedSession.current !== sessionId) {
    mountedSession.current = sessionId;
    turnStartedAtMs.current = null;
    placeholder.current = null;
  }

  if (!submitting) {
    // The turn settled: nothing may outlive it, or the next send would reopen
    // on a stale clock.
    turnStartedAtMs.current = null;
    placeholder.current = null;
    return { preview };
  }

  turnStartedAtMs.current ??= preview?.startedAtMs ?? Date.now();
  const startedAtMs = turnStartedAtMs.current;

  if (preview !== null) {
    placeholder.current = null;
    return {
      preview:
        startedAtMs === preview.startedAtMs
          ? preview
          : { ...preview, startedAtMs },
    };
  }
  placeholder.current ??= {
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
    errorDetail: null,
  };
  return { preview: placeholder.current };
}

/**
 * The placeholder's streamId. Deliberately NOT a uuid and never sent anywhere:
 * it exists only so the value is a total `StreamPreview`, and it can never
 * collide with an engine stream id.
 */
export const PENDING_TURN_STREAM_ID = "pending-turn";
