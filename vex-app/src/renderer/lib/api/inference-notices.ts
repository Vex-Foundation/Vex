/**
 * App-wide retention of inference notices (`EV.engine.inferenceNotice`).
 * Mounted ONCE at the shell beside `useEngineErrorRetentionSync`, so a notice
 * for a session that is not on screen is still there when the user opens it.
 */

import { useEffect } from "react";
import { useInferenceNoticeStore } from "../../stores/inferenceNoticeStore.js";

export function useInferenceNoticeRetentionSync(): void {
  const record = useInferenceNoticeStore((s) => s.record);
  useEffect(() => {
    const subscribeTo = window.vex.engine.onInferenceNotice;
    // A preload that predates the channel has no method: nothing to retain.
    if (typeof subscribeTo !== "function") return;
    return subscribeTo((event) => {
      record(event);
    });
  }, [record]);
}
