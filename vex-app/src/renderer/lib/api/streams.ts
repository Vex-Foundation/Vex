/**
 * Stream-preview live sync (Stage 9-3).
 *
 * Subscribes the active session to the engine stream spine and drives the
 * ephemeral `streamStore`:
 *  - `onStreamDelta` → accumulate the preview (text/tool/reasoning/usage/
 *    phase/status — reasoning is batched inside the store, see `applyDelta`);
 *  - `onTranscriptAppend` (assistant role) → the streamed text is now
 *    persisted, so clear the preview. We AWAIT the transcript query refetch
 *    first (TanStack v5 `invalidateQueries` resolves after active refetches)
 *    so the canonical row is in cache before the preview disappears — no
 *    swap gap.
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

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getLiveStreamId, useStreamStore } from "../../stores/streamStore.js";
import { messagesKeys } from "./queryKeys.js";

/** Clear an in-flight preview this long after the last delta (orphan net). */
export const STREAM_PREVIEW_IDLE_MS = 60_000;

export function useStreamPreviewSync(sessionId: string | null): void {
  const queryClient = useQueryClient();
  const applyDelta = useStreamStore((s) => s.applyDelta);
  const clear = useStreamStore((s) => s.clear);

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
      const targetStreamId =
        useStreamStore.getState().bySessionId[sessionId]?.streamId;
      if (targetStreamId === undefined) return;
      void (async () => {
        await queryClient.invalidateQueries({
          queryKey: messagesKeys.forSession(sessionId),
        });
        if (!alive) return;
        if (
          useStreamStore.getState().bySessionId[sessionId]?.streamId ===
          targetStreamId
        ) {
          clearAll();
        }
      })();
    });

    return () => {
      alive = false;
      offDelta();
      offAppend();
      clearAll();
    };
  }, [sessionId, queryClient, applyDelta, clear]);
}
