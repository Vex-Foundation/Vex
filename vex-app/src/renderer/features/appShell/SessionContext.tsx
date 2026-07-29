/**
 * Selected-session register line (S3 — the desk rule).
 *
 * One slim hairline-ruled line above the transcript: session title plus the
 * EXCEPTION stamp only (silence-by-default — `restricted` permission deviates
 * from the defaults; agent/full earn no chrome). Mission identity moved to the
 * MISSION RAIL's Mission badge, so the old `mission` mode stamp was removed.
 * Loading/error/not-found states are boxless lines on the same rule height.
 *
 * Stage 4: the runtime bar (model/usage/context/compaction) moved OUT of this
 * header — it now lives solely in the BOOK panel's RUNTIME & COST block, so the
 * desk rule stays a single quiet title line.
 *
 * WP-K adds a quiet Markdown export control. Clicking it opens
 * `SessionExportDialog` (the privacy-contract confirmation) rather than
 * exporting immediately; the mutation only fires after that confirmation.
 */

import { useEffect, useState, type JSX, type ReactNode } from "react";
import {
  CheckmarkCircle02Icon,
  Download01Icon,
  VexIcon,
} from "../../components/icons/index.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { DotmHex3 } from "../../components/ui/dotm-hex-3.js";
import { useExportSessionMarkdown } from "../../lib/api/sessions.js";
import { SessionExportDialog } from "./SessionExportDialog.js";
import { Stamp } from "./SessionRows/Stamp.js";
import { getSessionTitle } from "./sessionListModel.js";

export interface SessionContextProps {
  readonly activeSession: SessionListItem | null;
  readonly activeSessionId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  /**
   * Optional content-agnostic slot rendered at the trailing (right) edge of the
   * active-session title row. Content-agnostic on purpose: the header stays
   * unaware of what it hosts, so a caller can attach context without this
   * shared component gaining a second reason to change. Absent by default →
   * the shell row is unchanged.
   */
  readonly trailing?: ReactNode;
}

export function SessionContext({
  activeSession,
  activeSessionId,
  loading,
  error,
  trailing,
}: SessionContextProps): JSX.Element | null {
  const exportMutation = useExportSessionMarkdown();
  const [exportStatus, setExportStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);

  useEffect(() => {
    if (exportStatus === "idle") return;
    const timeout = window.setTimeout(() => setExportStatus("idle"), 2_500);
    return () => window.clearTimeout(timeout);
  }, [exportStatus]);

  function confirmExport(): void {
    if (activeSession === null) return;
    setExportStatus("idle");
    exportMutation.mutate(
      { id: activeSession.id },
      {
        onSuccess: (result) => {
          setExportConfirmOpen(false);
          if (result.ok && result.data.outcome === "saved") {
            setExportStatus("saved");
          } else if (!result.ok) {
            setExportStatus("error");
          }
          // `result.ok && outcome === "cancelled"` (native dialog dismissed)
          // stays idle and silent per the export's cancellation contract.
        },
        onError: () => {
          setExportConfirmOpen(false);
          setExportStatus("error");
        },
      },
    );
  }

  if (loading) {
    return (
      <div className="flex h-9 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--vex-text-3)]">
        <DotmHex3
          size={14}
          dotSize={2}
          color="var(--vex-accent)"
          ariaLabel="Loading session"
        />
        Loading session
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex h-9 items-center text-xs text-destructive">
        {error}
      </div>
    );
  }

  if (activeSessionId !== null && activeSession === null) {
    return (
      <div className="flex h-9 items-center text-sm text-[var(--vex-text-2)]">
        Session not found
      </div>
    );
  }

  if (activeSession !== null) {
    const title = getSessionTitle(activeSession);
    return (
      <div
        data-vex-area="session-header"
        role="group"
        aria-label={`Session: ${title}`}
        className="flex h-9 items-center gap-3 border-b border-[var(--vex-line)]"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {title}
        </span>
        {activeSession.permission !== "full" ? (
          <Stamp tone="warn">restricted</Stamp>
        ) : null}
        {/* Mission identity now reads from the MISSION RAIL's Mission badge —
            the small header "mission" stamp was removed to avoid double-
            signalling. The `restricted` exception stamp stays. */}
        {/* Trailing slot — right-edge context host (see prop doc). The title
            keeps `flex-1 min-w-0 truncate` so it yields space to the slot and
            still truncates; a slot whose content renders null adds no box, so
            the row reserves no ghost space when empty. The export control
            below stays the rightmost element of the row. */}
        {trailing}
        <span
          aria-live="polite"
          className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]"
        >
          {exportStatus === "saved"
            ? "Exported"
            : exportStatus === "error"
              ? "Export failed"
              : ""}
        </span>
        <button
          type="button"
          aria-label="Export session as Markdown"
          title="Export session as Markdown"
          disabled={exportMutation.isPending}
          onClick={() => setExportConfirmOpen(true)}
          className="grid size-7 shrink-0 place-items-center rounded-sm text-[var(--vex-text-3)] transition-colors hover:bg-[var(--vex-surface-2)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--vex-accent)] disabled:cursor-wait disabled:opacity-50"
        >
          <VexIcon
            icon={exportStatus === "saved" ? CheckmarkCircle02Icon : Download01Icon}
            size={15}
            aria-hidden
            className={exportMutation.isPending ? "animate-pulse" : undefined}
          />
        </button>
        <SessionExportDialog
          session={exportConfirmOpen ? activeSession : null}
          pending={exportMutation.isPending}
          onCancel={() => setExportConfirmOpen(false)}
          onConfirm={confirmExport}
        />
      </div>
    );
  }

  // Unreachable by contract: SessionPanel mounts this header only when a
  // session id is selected (the null-id welcome stage early-returns before
  // rendering it), so activeSessionId === null never lands here.
  return null;
}
