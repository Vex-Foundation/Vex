/**
 * The status strip's live readout of the active session's tape state — the
 * ONE word centered in the thin strip above the chat column.
 *
 * Presentation change (session-UI redesign, owner decree 2026-07-29): the word
 * moved out of the header's LEFT zone into its CENTER zone, and the still
 * color dot beside it was dropped. The dot was a second encoding of what the
 * word and its color already said, and at the strip's centre it read as
 * debris. State is now carried by the word plus its color alone. The state
 * machine and its data sources below are UNCHANGED — this was a presentation
 * edit only, so the precedence rules keep matching the streaming strip's.
 *
 * State precedence mirrors the streaming strip's circuit-break: a pending
 * approval FREEZES the run, so AWAITING wins over LIVE; otherwise LIVE while a
 * chat submit remains active (including quiet gaps between engine streams);
 * then a mission run reads PAUSED (paused_*) or RUNNING; IDLE at rest. Blue is
 * rationed to the non-idle states.
 *
 * Owner decree — no pulsing anything: state is carried by color + the label
 * text alone, never motion. PAUSED reads warning, IDLE muted, everything else
 * in flight reads accent.
 *
 * Renders nothing with no active session (the center panel is always the
 * session panel since the Chronos screens redesign). All data hooks accept a
 * null id and self-gate (no IPC when idle); the pending + runtime queries
 * share ApprovalsRegion's / MissionControls' keys, so this adds no extra
 * polling load.
 */

import type { JSX } from "react";
import { usePendingApprovals } from "../../lib/api/approvals.js";
import { useIsChatSubmitting } from "../../lib/api/chat.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import { useStreamPreview } from "../../stores/streamStore.js";
import { useUiStore } from "../../stores/uiStore.js";
import { cn } from "../../lib/utils.js";

export function DeskRuleTapeState(): JSX.Element | null {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const preview = useStreamPreview(activeSessionId);
  const chatSubmitting = useIsChatSubmitting(activeSessionId);
  const pending = usePendingApprovals(activeSessionId);
  const runtime = useRuntimeState(activeSessionId);

  if (activeSessionId === null) return null;

  const pendingData = pending.data;
  const hasPending =
    pendingData !== undefined && pendingData.ok && pendingData.data.length > 0;
  const live =
    chatSubmitting || (preview !== null && preview.phase === "streaming");
  const run = runtime.data !== undefined && runtime.data.ok ? runtime.data.data : null;
  const hasActiveRun = run?.hasActiveRun === true;
  const paused = hasActiveRun && (run?.status?.startsWith("paused") ?? false);

  const state = hasPending
    ? "awaiting"
    : live
      ? "live"
      : paused
        ? "paused"
        : hasActiveRun
          ? "running"
          : "idle";
  const label =
    state === "awaiting"
      ? "Awaiting"
      : state === "live"
        ? "Live"
        : state === "paused"
          ? "Paused"
          : state === "running"
            ? "Running"
            : "Idle";
  const lit = state !== "idle";

  // `.vex-micro` is the register's small-caps stamp; the
  // wider tracking override is local to this one word because it stands alone
  // at the centre of the strip with nothing beside it to set its rhythm.
  return (
    <span
      data-vex-tape-state={state}
      role="status"
      className={cn(
        "vex-micro tracking-[0.24em]",
        state === "paused"
          ? "text-warning"
          : lit
            ? "text-[var(--vex-accent-text)]"
            : "text-[var(--vex-text-3)]",
      )}
    >
      {label}
    </span>
  );
}
