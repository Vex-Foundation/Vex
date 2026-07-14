/**
 * Hypervexing workspace controller. Bridges agent-driven workspace-mode pushes
 * to the transient `workspaceMode` UI flag, gating first entry on the risk
 * acknowledgment.
 *
 * Ownership split:
 *  - the AGENT decides entry/exit (a main→renderer push, `subscribeWorkspaceMode`);
 *  - the STORE holds the transient flag (`workspaceMode`, never persisted);
 *  - THIS hook holds only the ack-dialog gate state, and turns a decoded action
 *    (`resolveWorkspaceModeEvent`) into the right store/dialog transition.
 *
 * Exit is always available in-mode. Main remains the authority: `exit()` asks
 * main to change the active session and waits for its pushed `normal` event.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useUiStore } from "../../../stores/uiStore.js";
import {
  useAcknowledgeHyperliquidRisk,
  useHyperliquidWorkspaceModeRead,
} from "../../../lib/api/hyperliquid.js";
import type { WorkspaceMode } from "../../../stores/uiStore.js";
import { resolveWorkspaceModeEvent, type WorkspaceModeAction } from "./workspaceModeGate.js";
import {
  requestWorkspaceExit,
  subscribeWorkspaceMode,
} from "./workspaceBridge.js";

export interface HypervexingWorkspaceController {
  readonly workspaceMode: WorkspaceMode;
  /** The first-entry risk dialog is open (agent asked to enter, not yet acked). */
  readonly ackPending: boolean;
  /** The acknowledgment write is in flight. */
  readonly ackSaving: boolean;
  /** Accept the risk: persist the ack, then activate the mode. */
  readonly confirmAck: () => void;
  /** Decline first entry: close the dialog and stay in normal mode. */
  readonly cancelAck: () => void;
  /** In-mode EXIT: leave the mode (local flip + tell main). */
  readonly exit: () => Promise<boolean>;
}

export function useHypervexingWorkspace(): HypervexingWorkspaceController {
  const workspaceMode = useUiStore((s) => s.workspaceMode);
  const setWorkspaceMode = useUiStore((s) => s.setWorkspaceMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const [ackPending, setAckPending] = useState(false);
  const acknowledge = useAcknowledgeHyperliquidRisk();
  const modeRead = useHyperliquidWorkspaceModeRead(activeSessionId);

  const applyAction = useCallback(
    (action: WorkspaceModeAction): void => {
      if (action.type === "enter") {
        setAckPending(false);
        setWorkspaceMode("hypervexing");
      } else if (action.type === "acknowledge") {
        // Gate before the morph: the dialog renders in the CURRENT theme, and
        // the mode activates only once the user accepts (confirmAck below).
        setAckPending(true);
      } else {
        setAckPending(false);
        setWorkspaceMode("normal");
      }
    },
    [setWorkspaceMode],
  );

  // A mount-read may resolve AFTER a live push for the same session; the push
  // is the fresher authority, so reconciliation applies AT MOST ONCE per
  // session and a push claims the session before a late read can override it.
  const reconciledSessionId = useRef<string | null>(null);

  useEffect(() => {
    return subscribeWorkspaceMode((event) => {
      // The mode is per-session in main's map: a background session's agent
      // (e.g. a mission) must not morph the UI the user is looking at.
      if (event.sessionId !== activeSessionId) return;
      reconciledSessionId.current = activeSessionId;
      applyAction(resolveWorkspaceModeEvent(event));
    });
  }, [applyAction, activeSessionId]);

  // Session-switch reconciliation: pushes only cover live transitions, so a
  // switch to a session already in `hypervexing` (or back to a normal one)
  // re-reads main's authoritative per-session mode and converges the UI flag.
  useEffect(() => {
    if (activeSessionId === null) {
      reconciledSessionId.current = null;
      setAckPending(false);
      setWorkspaceMode("normal");
      return;
    }
    if (reconciledSessionId.current === activeSessionId) return;
    if (modeRead.data?.ok !== true) return;
    reconciledSessionId.current = activeSessionId;
    applyAction(resolveWorkspaceModeEvent(modeRead.data.data));
  }, [activeSessionId, applyAction, modeRead.data, setWorkspaceMode]);

  const confirmAck = useCallback(() => {
    acknowledge.mutate(undefined, {
      onSuccess: (result) => {
        if (!result.ok) return;
        setAckPending(false);
        setWorkspaceMode("hypervexing");
      },
    });
  }, [acknowledge, setWorkspaceMode]);

  const cancelAck = useCallback(() => {
    setAckPending(false);
    void requestWorkspaceExit(activeSessionId);
  }, [activeSessionId]);

  // Main is the sole authority: the mode changes only when its `normal` push
  // arrives. A failed invoke leaves the workspace intact for a visible retry.
  const exit = useCallback(() => requestWorkspaceExit(activeSessionId), [activeSessionId]);

  return {
    workspaceMode,
    ackPending,
    ackSaving: acknowledge.isPending,
    confirmAck,
    cancelAck,
    exit,
  };
}
