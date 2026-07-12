/**
 * DESK RULE tape-head — the header's live readout of the active session's tape
 * state. With the reading column left-anchored (SessionPanel), the spine, the
 * DESK RULE accent tick, and this word share one left axis: the header becomes
 * the head of the tape.
 *
 * State precedence mirrors the streaming strip's circuit-break: a pending
 * approval FREEZES the run, so AWAITING wins over LIVE; otherwise LIVE while a
 * chat submit remains active (including quiet gaps between engine streams);
 * then a mission run reads PAUSED (paused_*) or RUNNING; IDLE at rest. Blue is
 * rationed to the non-idle states.
 *
 * Landing hero-status treatment: the dot carries the `.vex-pulse-dot` ring
 * ONLY while the state is verifiably in flight (awaiting / live / running —
 * the same law as vex-sign-stroke); PAUSED holds a still warning dot, IDLE a
 * still muted one.
 *
 * Renders nothing off the session view / with no active session. All data
 * hooks accept a null id and self-gate (no IPC when idle); the pending +
 * runtime queries share ApprovalsRegion's / MissionControls' keys, so this adds
 * no extra polling load.
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
  const appShellView = useUiStore((s) => s.appShellView);
  const preview = useStreamPreview(activeSessionId);
  const chatSubmitting = useIsChatSubmitting(activeSessionId);
  const pending = usePendingApprovals(activeSessionId);
  const runtime = useRuntimeState(activeSessionId);

  if (appShellView !== "session" || activeSessionId === null) return null;

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
  // A loop may only bind to verifiable in-flight work: awaiting (frozen on a
  // signature ask), live (streaming), running (active run). PAUSED is a held
  // state — a still warning dot, no ring.
  const pulsing =
    state === "awaiting" || state === "live" || state === "running";

  return (
    <span
      data-vex-tape-state={state}
      role="status"
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.28em]",
        state === "paused"
          ? "text-warning"
          : lit
            ? "text-[var(--vex-accent-text)]"
            : "text-[var(--vex-text-3)]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          pulsing && "vex-pulse-dot",
          state === "paused"
            ? "bg-warning"
            : lit
              ? "bg-[var(--vex-accent)]"
              : "bg-[var(--vex-text-3)]",
        )}
      />
      {label}
    </span>
  );
}
