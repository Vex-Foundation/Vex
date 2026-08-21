/**
 * THE TURN-SCOPED PREVIEW — what the transcript renders as "the turn in
 * flight", from the instant of the send to the instant the turn settles — plus
 * the latch that decides whether the centred "vexing…" scene may open.
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
 * ── THE CENTRED-SCENE LATCH ───────────────────────────────────────────────
 * A centred particle scene may occupy the chat column only while it provably
 * covers nothing. Two earlier designs got this wrong the same way — inferring
 * "the viewport is blank" from the preview's CONTENT, then from a provider
 * round count. Both were proxies. This one is transcript evidence:
 *
 *  - the send edge (`submitting` false→true) observed by THIS mounted session
 *    snapshots a BASELINE row id, and opens nothing by itself: `submitting`
 *    flips long before main appends the user row, so at that moment the
 *    scroller still shows the previous conversation;
 *  - the scene may open only once a VIEWPORT-SAFE LIVE USER ANCHOR appears — a
 *    row newer than the baseline, of the `user` variant, appended live. This is
 *    deliberately NOT a claim that the row belongs to "this send": the renderer
 *    holds no turn correlation id and must never pretend otherwise. It is the
 *    exact signal the scroll model's FORCE-SCROLL arm keys on
 *    (`useTranscriptScroll.ts`, "own words must be visible"), and both read it
 *    in the same commit, so by the time this is true the viewport has been
 *    driven to the floor with that fresh user row in view and nothing the
 *    reader was reading is being covered. (Under the retired top-anchor model
 *    the same signal drove the viewport to a top anchor instead — the
 *    guarantee is unchanged, only the resting position moved.)
 *  - it closes PERMANENTLY for the submission on either the first real engine
 *    preview OR any newer non-user row. The second clause matters because
 *    stream-preview delivery is best-effort (`engine/core/turn.ts`): a round
 *    whose previews were missed still persists its row;
 *  - a closed latch never reopens while the submission runs, whatever the store
 *    does (idle timer, abort, session cleanup all clear it);
 *  - a session change resets every ref synchronously during render, and
 *    mounting INTO an already-submitting session is never eligible.
 *
 * Fail-safe by direction: every uncertain state resolves to "no centred scene".
 */

import { useRef } from "react";
import type { StreamPreview } from "../../../stores/streamStore.js";

export interface TurnPreviewInput {
  /** The mounted session. A change resets every latch, synchronously. */
  readonly sessionId: string;
  /** The engine's round-scoped preview for this session, or null. */
  readonly preview: StreamPreview | null;
  /** `chat.submit` is pending for this session — the turn boundary. */
  readonly submitting: boolean;
  /** Newest transcript row id, or 0 when there are none. */
  readonly newestId: number;
  /** Newest row's variant (`user`, `assistant`, `tool`, …), or null. */
  readonly newestVariant: string | null;
  /** The newest row arrived LIVE — its id is outside the settled set. */
  readonly newestIsLiveAppend: boolean;
}

export interface TurnPreviewResult {
  readonly preview: StreamPreview | null;
  /** May the CENTRED scene mount? See the latch contract above. */
  readonly centredSceneEligible: boolean;
}

export function useTurnPreview(input: TurnPreviewInput): TurnPreviewResult {
  const {
    sessionId,
    preview,
    submitting,
    newestId,
    newestVariant,
    newestIsLiveAppend,
  } = input;

  const mountedSession = useRef<string | null>(null);
  // When the CURRENT turn began. Pinned once per turn so the elapsed counter
  // measures the turn the operator is waiting on, not the provider round the
  // engine happens to be in.
  const turnStartedAtMs = useRef<number | null>(null);
  const placeholder = useRef<StreamPreview | null>(null);
  /** Has this mount ever observed `submitting === false` for this session? */
  const observedIdle = useRef(false);
  /** Did the send edge happen while THIS session was mounted? */
  const observedSendEdge = useRef(false);
  const wasSubmitting = useRef(false);
  const baselineNewestId = useRef(0);
  const latchOpen = useRef(false);
  const latchClosed = useRef(false);

  // Session change → reset synchronously during render (the file's existing
  // render-time-ref idiom, not an effect): switching between two submitting
  // sessions must never inherit the other's clock or its open latch.
  if (mountedSession.current !== sessionId) {
    mountedSession.current = sessionId;
    turnStartedAtMs.current = null;
    placeholder.current = null;
    observedIdle.current = false;
    observedSendEdge.current = false;
    // Deliberately FALSE, not `submitting`: the arming block below is the ONE
    // place that decides eligibility, and pre-setting this to `true` skipped it
    // entirely for a mount that lands mid-submit — which is every fresh
    // session's first send (B1).
    wasSubmitting.current = false;
    baselineNewestId.current = 0;
    latchOpen.current = false;
    latchClosed.current = false;
  }

  if (!submitting) {
    // The turn settled: nothing may outlive it, or the next send would reopen
    // on a stale clock and a stale latch.
    turnStartedAtMs.current = null;
    placeholder.current = null;
    observedIdle.current = true;
    observedSendEdge.current = false;
    wasSubmitting.current = false;
    latchOpen.current = false;
    latchClosed.current = false;
    return { preview, centredSceneEligible: false };
  }

  if (!wasSubmitting.current) {
    wasSubmitting.current = true;
    // Mounting straight INTO a pending turn is normally not an observed send:
    // such a mount cannot know what the viewport already holds.
    //
    // ONE exception, and it is evidence rather than inference: a transcript
    // with ZERO rows and no preview holds nothing, so there is provably
    // nothing to cover. This is the first send of a FRESH session, where
    // `SessionPanel` shows the welcome hero and does not mount the transcript
    // until the turn is already in flight — without this arm, send #1 could
    // never open the scene while send #N always did (owner report, B1).
    // A mount over a POPULATED transcript stays ineligible, which is exactly
    // R3.2's guard restated at the mount edge.
    const mountedOntoEmptyTranscript = newestId === 0 && preview === null;
    observedSendEdge.current = observedIdle.current || mountedOntoEmptyTranscript;
    baselineNewestId.current = newestId;
    latchOpen.current = false;
    latchClosed.current = false;
  }

  if (observedSendEdge.current && !latchClosed.current) {
    const isNewer = newestId > baselineNewestId.current;
    if (preview !== null || (isNewer && newestVariant !== "user")) {
      latchClosed.current = true;
    } else if (isNewer && newestVariant === "user" && newestIsLiveAppend) {
      latchOpen.current = true;
    }
  }

  turnStartedAtMs.current ??= preview?.startedAtMs ?? Date.now();
  const startedAtMs = turnStartedAtMs.current;
  const centredSceneEligible =
    observedSendEdge.current && latchOpen.current && !latchClosed.current;

  if (preview !== null) {
    placeholder.current = null;
    return {
      preview:
        startedAtMs === preview.startedAtMs
          ? preview
          : { ...preview, startedAtMs },
      centredSceneEligible,
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
  return { preview: placeholder.current, centredSceneEligible };
}

/**
 * The placeholder's streamId. Deliberately NOT a uuid and never sent anywhere:
 * it exists only so the value is a total `StreamPreview`, and it can never
 * collide with an engine stream id.
 */
export const PENDING_TURN_STREAM_ID = "pending-turn";
