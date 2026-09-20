/**
 * Moves a confirmed first-time Lighter setup out of Agent chat and into the
 * native desk workflow. Session matching is checked against the latest store
 * state at event time so a delayed event can never hijack another open chat.
 */

import { useEffect } from "react";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";

export function useLighterSetupHandoff(): void {
  useEffect(() => {
    return window.vex.engine.onLighterSetupRequested((event) => {
      const ui = useUiStore.getState();
      if (event.sessionId !== ui.activeSessionId) return;

      // Select the exact environment proven by the fixed status shortcut. A
      // null market lets the desk choose its normal default for that venue.
      useLighterAnalysisStore.getState().saveDesk({
        environment: event.environment,
        marketId: null,
      });
      ui.setRuntimeMode("lighter");
      useUiStore.getState().requestLighterSetup();
    });
  }, []);
}
