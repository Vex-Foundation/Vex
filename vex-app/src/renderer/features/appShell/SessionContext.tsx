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
 */

import { useEffect, useState, type JSX } from "react";
import {
  CheckmarkCircle02Icon,
  Download01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { DotmHex3 } from "../../components/ui/dotm-hex-3.js";
import { useExportSessionMarkdown } from "../../lib/api/sessions.js";
import { Stamp } from "./SessionRows/Stamp.js";
import { getSessionTitle } from "./sessionListModel.js";

export interface SessionContextProps {
  readonly activeSession: SessionListItem | null;
  readonly activeSessionId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function SessionContext({
  activeSession,
  activeSessionId,
  loading,
  error,
}: SessionContextProps): JSX.Element | null {
  const exportMutation = useExportSessionMarkdown();
  const [exportStatus, setExportStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );

  useEffect(() => {
    if (exportStatus === "idle") return;
    const timeout = window.setTimeout(() => setExportStatus("idle"), 2_500);
    return () => window.clearTimeout(timeout);
  }, [exportStatus]);

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
          onClick={() => {
            setExportStatus("idle");
            exportMutation.mutate(
              { id: activeSession.id },
              {
                onSuccess: (result) => {
                  if (result.ok && result.data.outcome === "saved") {
                    setExportStatus("saved");
                  } else if (!result.ok) {
                    setExportStatus("error");
                  }
                },
                onError: () => setExportStatus("error"),
              },
            );
          }}
          className="grid size-7 shrink-0 place-items-center rounded-sm text-[var(--vex-text-3)] transition-colors hover:bg-[var(--vex-surface-2)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--vex-accent)] disabled:cursor-wait disabled:opacity-50"
        >
          <HugeiconsIcon
            icon={exportStatus === "saved" ? CheckmarkCircle02Icon : Download01Icon}
            size={15}
            aria-hidden
            className={exportMutation.isPending ? "animate-pulse" : undefined}
          />
        </button>
        {activeSession.permission !== "full" ? (
          <Stamp tone="warn">restricted</Stamp>
        ) : null}
        {/* Mission identity now reads from the MISSION RAIL's Mission badge —
            the small header "mission" stamp was removed to avoid double-
            signalling. The `restricted` exception stamp stays. */}
      </div>
    );
  }

  // Unreachable by contract: SessionPanel mounts this header only when a
  // session id is selected (the null-id welcome stage early-returns before
  // rendering it), so activeSessionId === null never lands here.
  return null;
}
