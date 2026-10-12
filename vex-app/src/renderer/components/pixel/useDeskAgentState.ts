/**
 * THE AGENT STATE THE PRINT SHOWS, read from the stores the running head
 * already reads. No new IPC, no timer, no poll of its own: every query below
 * shares its key with a surface that is mounted anyway (the tape word, the
 * approvals region, the global approvals badge), so subscribing here adds no
 * load.
 *
 * With a session open, the state is exactly the tape's
 * (`features/appShell/DeskRuleTapeState.tsx`): its inputs, its precedence,
 * and Sleeping drawn as idle. An agreement test renders both over the same
 * stores and fails if they ever name different states, so the eagle and the
 * word cannot drift apart.
 *
 * On the welcome (no session open) the tape says nothing and there is no turn
 * or run to read, so the only signal is the app wide approvals inbox: a
 * pending approval anywhere holds the flock, anything else is idle.
 *
 * `turn` names what the turn island shows while the state is live (working,
 * thinking, calling, running a tool, writing); every one of those is Live on
 * the print, so it never changes the state. Callers may use it for words, not
 * for motion.
 */

import { usePendingApprovals, usePendingApprovalsAll } from "../../lib/api/approvals.js";
import { useIsChatSubmitting } from "../../lib/api/chat.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import { useStreamPreview } from "../../stores/streamStore.js";
import { useUiStore } from "../../stores/uiStore.js";
import { readSessionActivityReadout } from "../../features/appShell/session-activity-readout.js";
import {
  resolveTurnIslandView,
  type TurnIslandState,
} from "../../features/appShell/TurnIsland/islandTurnState.js";
import { deskAgentStateOf, type DeskAgentState } from "./agent-state.js";

export interface DeskAgentReadout {
  readonly state: DeskAgentState;
  /** The turn island's state while live, else null. */
  readonly turn: TurnIslandState | null;
}

export function useDeskAgentState(): DeskAgentReadout {
  const sessionId = useUiStore((s) => s.activeSessionId);
  const preview = useStreamPreview(sessionId);
  const chatSubmitting = useIsChatSubmitting(sessionId);
  const pending = usePendingApprovals(sessionId);
  const runtime = useRuntimeState(sessionId);
  const pendingAll = usePendingApprovalsAll();

  if (sessionId === null) {
    const all = pendingAll.data;
    const awaiting = all !== undefined && all.ok && all.data.length > 0;
    return { state: deskAgentStateOf({ awaiting }), turn: null };
  }

  const pendingData = pending.data;
  const awaiting =
    pendingData !== undefined && pendingData.ok && pendingData.data.length > 0;
  const live =
    chatSubmitting || (preview !== null && preview.phase === "streaming");
  const run =
    runtime.data !== undefined && runtime.data.ok ? runtime.data.data : null;
  const hasActiveRun = run?.hasActiveRun === true;
  const paused = hasActiveRun && (run?.status?.startsWith("paused") ?? false);
  // The tape's tail: with no mission run, the session's activity projection
  // decides; running reads Running, sleeping and none read idle.
  const activity = run === null ? null : readSessionActivityReadout(run.activity);
  const running = hasActiveRun || activity?.state === "running";

  const state = deskAgentStateOf({ awaiting, live, paused, running });
  const turn =
    state === "live" && preview !== null
      ? resolveTurnIslandView(preview, awaiting).state
      : null;
  return { state, turn };
}
