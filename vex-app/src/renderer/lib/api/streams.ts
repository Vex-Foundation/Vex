/**
 * Stream-preview live sync (Stage 9-3).
 *
 * Subscribes the active session to the engine stream spine and drives the
 * ephemeral `streamStore`:
 *  - `onStreamDelta` → accumulate the preview (text/tool/reasoning/usage/
 *    phase/status — reasoning is batched inside the store, see `applyDelta`);
 *  - `onTranscriptAppend` (assistant role) → the streamed text is now
 *    persisted, so retire the preview's copy of it. We AWAIT the transcript
 *    query refetch first (TanStack v5 `invalidateQueries` resolves after
 *    active refetches) so the canonical row is in cache before the preview
 *    changes — no swap gap.
 *
 * ROUND vs TURN (owner report 2026-07-30 — the mid-turn scroll jump). A turn
 * is one or MANY provider rounds: the engine loops round → tool batch → round
 * until a round answers without calling a tool, and EVERY round persists its
 * own assistant row. Treating each of those appends as the end of the turn was
 * wrong in three visible ways: the reasoning segments of the turn's first half
 * were destroyed, the elapsed clock restarted, and the transcript's anchor
 * run-out spacer was retired mid-turn — which collapses the scroll range under
 * an anchored user message and makes the browser clamp scrollTop, throwing the
 * reader up the conversation.
 *
 * So the append is classified instead of blindly clearing:
 *  - the round emitted a `tool_call` (`toolName !== null`) → it is a MID-TURN
 *    round: `settleRound` drops the now-persisted prose and closes the active
 *    reasoning segment, and the preview lives on into the next round;
 *  - no tool call → this round IS the answer, the turn is over, clear as before.
 *
 * The classifier is the stream's own history, which is exactly the engine's
 * loop condition, so the two cannot disagree.
 *
 * Orphan safety, in order of how fast each path reacts:
 *  - an ERROR delta clears immediately (an errored stream never persists a
 *    message, so nothing else ever would);
 *  - an ABORTED delta clears immediately — this is the Stop path. A turn the
 *    user stops before any persistable assistant content produces no append
 *    and no error delta, so a half-written reasoning or tool preview used to
 *    sit frozen on screen for the whole idle timeout after the user had
 *    explicitly stopped it.
 *
 *    It must be this delta and NOT a control-state transition. `leaseActive:
 *    false` was tried and reverted: every ordinary completion emits it too
 *    (each turn releases its lease in a `finally`), so it raced the
 *    assistant-row refetch and blanked the preview on the SUCCESS path —
 *    worse than the gap it closed. The aborted delta rides the stream chain
 *    itself at `lastSequence + 1` with the same `streamId`, and is never
 *    emitted for a boundary abort where no inference ran, so it means exactly
 *    "this stream ended without producing a message" and nothing else;
 *  - the idle timer catches everything else (a dropped connection, a lost
 *    event). It is the dropped-event safety net and is never removed.
 *
 * Every timer + subscription is owned here and torn down on clear / session
 * change / unmount. Pure side effect; mount once per active session
 * (`SessionPanel`).
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getLiveStreamId, useStreamStore } from "../../stores/streamStore.js";
import { useIsChatSubmitting } from "./chat.js";
import { messagesKeys } from "./queryKeys.js";

/** Clear an in-flight preview this long after the last delta (orphan net). */
export const STREAM_PREVIEW_IDLE_MS = 60_000;

export function useStreamPreviewSync(sessionId: string | null): void {
  const queryClient = useQueryClient();
  const applyDelta = useStreamStore((s) => s.applyDelta);
  const settleRound = useStreamStore((s) => s.settleRound);
  const clear = useStreamStore((s) => s.clear);
  const submitting = useIsChatSubmitting(sessionId);

  // TURN-SETTLED BACKSTOP. Keeping a mid-turn preview alive (above) means a
  // turn that ends right after a tool call — approval rejected or expired, the
  // iteration cap, an engine stop — emits no final assistant append, so
  // nothing short of the 60 s idle net would retire it. `chat.submit`'s
  // mutation is pending for the WHOLE turn (every round AND tool execution),
  // so its settle IS the end of the turn.
  //
  // Only the true→false TRANSITION clears. A steady `false` must never touch a
  // preview: mission and wake turns never open a chat mutation at all, and
  // blanking them on their first delta is precisely the regression that killed
  // the earlier `leaseActive` attempt documented above.
  const wasSubmitting = useRef(false);
  useEffect(() => {
    const settled = wasSubmitting.current && !submitting;
    wasSubmitting.current = submitting;
    if (!settled || sessionId === null) return;
    clear(sessionId);
  }, [submitting, sessionId, clear]);

  useEffect(() => {
    if (sessionId === null || sessionId.length === 0) return;

    let alive = true;
    let idleTimer: number | undefined;

    const disarmIdle = (): void => {
      if (idleTimer !== undefined) {
        window.clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const clearAll = (): void => {
      disarmIdle();
      clear(sessionId);
    };

    const offDelta = window.vex.engine.onStreamDelta((event) => {
      if (event.sessionId !== sessionId) return;
      // A DELAYED abort must not touch the stream that replaced it. The check
      // has to happen BEFORE `applyDelta`, not just before the clear: the
      // reducer resolves its base by `streamId`, so applying a foreign
      // stream's delta would itself replace the live preview with a fresh one
      // for the dead stream — the clear that followed would then be deleting
      // the wrong thing for the second time.
      //
      // A mismatched abort is a complete no-op: nothing applied, nothing
      // cleared, and the surviving preview keeps the idle timer it already
      // has armed. `getLiveStreamId` also reads the reasoning batching buffer,
      // so a reasoning-only stream aborted inside its 80 ms window is
      // correctly recognised as the LIVE stream rather than a stale one —
      // `clear` then cancels the buffer, so it never materializes.
      if (
        event.delta.kind === "aborted"
        && getLiveStreamId(sessionId) !== event.streamId
      ) {
        return;
      }
      applyDelta(sessionId, event);
      disarmIdle();
      // The two terminal-without-a-message kinds. Neither will ever be
      // followed by an assistant append, so nothing else would clear them —
      // they used to sit there frozen mid-sentence for the full 60 s idle
      // timer while the user had no idea anything had happened.
      //
      // `error`: the failure has its own persistent surface
      // (`SessionErrorBanner`, fed by the `EV.engine.error` push channel),
      // which says what actually went wrong. The banner owns that display;
      // clearing here is unconditional and does not wait for it.
      //
      // `aborted`: the user pressed Stop. Nothing to say beyond removing the
      // corpse of the turn — the delta is a bare discriminant by design, no
      // reason string, no provider text. Correlated to the displayed stream by
      // the guard above.
      if (event.delta.kind === "error" || event.delta.kind === "aborted") {
        clearAll();
        return;
      }
      idleTimer = window.setTimeout(() => {
        if (alive) clearAll();
      }, STREAM_PREVIEW_IDLE_MS);
    });

    const offAppend = window.vex.engine.onTranscriptAppend((event) => {
      if (event.sessionId !== sessionId || event.role !== "assistant") return;
      // The append carries no streamId. Capture the preview that is live NOW —
      // the just-finished stream, since IPC delivers this append before the
      // next stream's first delta. Wait for the persisted row to land in cache,
      // then clear ONLY if that SAME stream is still showing: a newer stream
      // that started during the await must be preserved (it clears on its own
      // append).
      const target = useStreamStore.getState().bySessionId[sessionId];
      if (target === undefined) return;
      const targetStreamId = target.streamId;
      // Classified BEFORE the await, off the round this append belongs to: a
      // round that called a tool is mid-turn, and the turn continues.
      const midTurn = target.toolName !== null;
      void (async () => {
        await queryClient.invalidateQueries({
          queryKey: messagesKeys.forSession(sessionId),
        });
        if (!alive) return;
        if (
          useStreamStore.getState().bySessionId[sessionId]?.streamId !==
          targetStreamId
        ) {
          return;
        }
        if (midTurn) {
          // The round's prose is canonical now; the TURN's state (segments,
          // clock) and the transcript's anchor run-out survive with it.
          settleRound(sessionId);
          return;
        }
        clearAll();
      })();
    });

    return () => {
      alive = false;
      offDelta();
      offAppend();
      clearAll();
    };
  }, [sessionId, queryClient, applyDelta, settleRound, clear]);
}
