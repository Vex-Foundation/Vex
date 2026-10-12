/**
 * The running head's live readout of the active session's tape state - the
 * ONE word centred in the 44px head above the chat column.
 *
 * Presentation (docs/design/V10-SPREAD.md section 4): 11px mono caps at the
 * tape tracking, led by a 9px swatch whose FILL names the state (status is
 * fill, never colour): outline idle, solid live, dot screen running, target
 * awaiting, hatch paused. The state machine and its data sources below are
 * UNCHANGED - presentation only, so the precedence rules keep matching the
 * streaming strip's.
 *
 * State precedence mirrors the streaming strip's circuit-break: a pending
 * approval FREEZES the run, so AWAITING wins over LIVE; otherwise LIVE while a
 * chat submit remains active (including quiet gaps between engine streams);
 * then a mission run reads PAUSED (paused_*) or RUNNING; IDLE at rest. Blue is
 * rationed to the non-idle states.
 *
 * Owner decree - no pulsing anything: state is carried by the fill and the
 * label, never motion. IDLE reads muted, everything else reads accent.
 *
 * Renders nothing with no active session (the center panel is always the
 * session panel since the Chronos screens redesign). All data hooks accept a
 * null id and self-gate (no IPC when idle); the pending + runtime queries
 * share ApprovalsRegion's / MissionControls' keys, so this adds no extra
 * polling load.
 *
 * The derivation is `useTapeState`, exported so the gutter's spread caption
 * repeats the same word from the same reads (docs/design/V10-SPREAD.md
 * section 5): the caption is `aria-hidden` and only ever echoes this word.
 */

import type { JSX } from "react";
import { usePendingApprovals } from "../../lib/api/approvals.js";
import { useIsChatSubmitting } from "../../lib/api/chat.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import { useStreamPreview } from "../../stores/streamStore.js";
import { useUiStore } from "../../stores/uiStore.js";
import { cn } from "../../lib/utils.js";
import { readSessionActivityReadout } from "./session-activity-readout.js";

export type TapeState =
  | "awaiting"
  | "live"
  | "paused"
  | "running"
  | "sleeping"
  | "idle";

/** The five fills of the agent states (docs/design/V10-SPREAD.md section 6). */
export type TapeFill = "idle" | "done" | "ongoing" | "warning" | "draft";

/** Sleeping draws idle; every in-flight word draws its own fill. */
export const TAPE_FILL: Readonly<Record<TapeState, TapeFill>> = {
  idle: "idle",
  sleeping: "idle",
  live: "done",
  running: "ongoing",
  awaiting: "warning",
  paused: "draft",
};

/**
 * One status swatch, drawn on the pixel grid in the current text colour: the
 * fill carries the state. Sized by its caller's CSS (`.vex-tape-swatch`, 9px
 * here, 12 or 9 in the gutter). An interim drawing shared by the running head
 * and the gutter; the shared `Swatch` primitive replaces it, with the same
 * state names.
 */
export function TapeSwatch({
  fill,
  className,
}: {
  readonly fill: TapeFill;
  readonly className: string;
}): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className={className} data-s={fill} aria-hidden="true" focusable="false">
      <rect x="0.75" y="0.75" width="10.5" height="10.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {fill === "done" ? <rect x="0" y="0" width="12" height="12" fill="currentColor" /> : null}
      {fill === "ongoing" ? (
        <path d="M3 3h2v2H3zM7 3h2v2H7zM3 7h2v2H3zM7 7h2v2H7z" fill="currentColor" />
      ) : null}
      {fill === "warning" ? <rect x="4" y="4" width="4" height="4" fill="currentColor" /> : null}
      {fill === "draft" ? (
        <path d="M1.5 6.5 6.5 1.5M1.5 10.5 10.5 1.5M5.5 10.5 10.5 5.5" stroke="currentColor" strokeWidth="1.25" fill="none" />
      ) : null}
    </svg>
  );
}

export const TAPE_LABEL: Readonly<Record<TapeState, string>> = {
  awaiting: "Awaiting",
  live: "Live",
  paused: "Paused",
  running: "Running",
  sleeping: "Sleeping",
  idle: "Idle",
};

/** The tape state of one session, or null with no session. */
export function useTapeState(sessionId: string | null): TapeState | null {
  const preview = useStreamPreview(sessionId);
  const chatSubmitting = useIsChatSubmitting(sessionId);
  const pending = usePendingApprovals(sessionId);
  const runtime = useRuntimeState(sessionId);

  if (sessionId === null) return null;

  const pendingData = pending.data;
  const hasPending =
    pendingData !== undefined && pendingData.ok && pendingData.data.length > 0;
  const live =
    chatSubmitting || (preview !== null && preview.phase === "streaming");
  const run = runtime.data !== undefined && runtime.data.ok ? runtime.data.data : null;
  const hasActiveRun = run?.hasActiveRun === true;
  const paused = hasActiveRun && (run?.status?.startsWith("paused") ?? false);

  // M5: the tail of the precedence chain is no longer "no run row ⇒ Idle".
  // A full-autonomy AGENT session has no run row at all, so wake-driven work
  // reported Idle while the agent was mid-slice. The activity projection is
  // the authoritative answer for that case, read through the SAME selector the
  // composer strip reads so the two words cannot disagree. Mission precedence
  // above is untouched: a mission session's activity is `none` (the projection
  // is session-scoped), so it never reaches this arm.
  const activityReadout =
    run === null ? null : readSessionActivityReadout(run.activity);
  return hasPending
    ? "awaiting"
    : live
      ? "live"
      : paused
        ? "paused"
        : hasActiveRun
          ? "running"
          : (activityReadout?.state ?? "idle");
}

export function DeskRuleTapeState(): JSX.Element | null {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const state = useTapeState(activeSessionId);
  if (state === null) return null;
  const lit = state !== "idle";

  // `.vex-micro` is the register's mono caps stamp, at the running head's
  // 11px; the tape tracking is local to this one word because it stands alone
  // at the centre of the head with nothing beside it to set its rhythm.
  return (
    <span
      data-vex-tape-state={state}
      role="status"
      className={cn(
        "vex-micro inline-flex items-center gap-[9px] text-[11px] tracking-[var(--tracking-tape)]",
        lit ? "text-[var(--vex-accent-text)]" : "text-[var(--vex-text-2)]",
      )}
    >
      <TapeSwatch fill={TAPE_FILL[state]} className="vex-tape-swatch" />
      {TAPE_LABEL[state]}
    </span>
  );
}
