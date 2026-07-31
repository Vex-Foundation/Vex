/**
 * Selected-session exception line, above the transcript.
 *
 * The REGISTER LINE IS GONE (session-UI redesign, owner decree 2026-07-29):
 * the session title now lives only in the left rail (it was being stated
 * twice), and the Markdown export key moved to the trailing edge of the thin
 * status strip above the chat column (`SessionExportControl`). What remains
 * here is what the strip cannot carry — the per-session EXCEPTION stamp
 * (silence-by-default: `restricted` permission deviates from the defaults;
 * agent/full earn no chrome), the trailing slot, and the loading /
 * error / not-found lines.
 *
 * Mission identity reads from the MISSION RAIL's Mission badge; the runtime
 * bar (model/usage/context/compaction) lives in the BOOK panel's RUNTIME &
 * COST block. Neither belongs here.
 */

import type { JSX, ReactNode } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { DotmHex3 } from "../../components/ui/dotm-hex-3.js";
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
  if (loading) {
    return (
      <div className="vex-micro flex h-9 items-center gap-2 tracking-[0.24em] text-[var(--vex-text-3)]">
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
        className="flex h-8 items-center justify-end gap-3"
      >
        {/* Mission identity reads from the MISSION RAIL's Mission badge; the
            title reads from the left rail. The `restricted` exception stamp is
            the only thing this row states on its own. */}
        {activeSession.permission !== "full" ? (
          <Stamp tone="warn">restricted</Stamp>
        ) : null}
        {/* Trailing slot — right-edge context host (see prop doc). A slot whose
            content renders null adds no box, so the row reserves no ghost
            space when empty. */}
        {trailing}
      </div>
    );
  }

  // Unreachable by contract: SessionPanel mounts this header only when a
  // session id is selected (the null-id welcome stage early-returns before
  // rendering it), so activeSessionId === null never lands here.
  return null;
}
