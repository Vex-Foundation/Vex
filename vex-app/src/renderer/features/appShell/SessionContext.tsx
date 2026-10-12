/**
 * The selected session's head, above the transcript.
 *
 * ON THE SPREAD (`chapter`, the shell's own surface) the head is the CHAPTER
 * TITLE: the session's name in the 56px serif (docs/design/V10-SPREAD.md
 * section 1, reference d3), the way a chapter of the book opens. The access
 * mode is not repeated here: the composer's access-mode seat names it (with
 * its accessible name), and the gutter caption repeats it, so a third copy
 * would be the duplicate the calmness pass removed.
 *
 * IN A SIDE RAIL (the embedded Lighter chat) there is no chapter and no
 * gutter, so the head keeps the per-session EXCEPTION stamp (silence-by-
 * default: `restricted` permission deviates from the defaults; agent/full
 * earn no chrome). Either way the Markdown export key lives on the running
 * head (`SessionExportControl`), and the trailing slot and the loading /
 * error / not-found lines stay here.
 *
 * Mission identity reads from the MISSION RAIL's Mission badge; the runtime
 * bar (model/usage/context/compaction) lives in the BOOK panel's RUNTIME &
 * COST block. Neither belongs here.
 */

import type { JSX, ReactNode } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { Swatch } from "../../components/ui/swatch.js";
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
  /**
   * The session opens as a chapter of the spread: its title is printed as
   * the page's serif head. Off (the default) for a side rail, which keeps the
   * exception stamp instead.
   */
  readonly chapter?: boolean;
}

export function SessionContext({
  activeSession,
  activeSessionId,
  loading,
  error,
  trailing,
  chapter = false,
}: SessionContextProps): JSX.Element | null {
  if (loading) {
    return (
      <div
        role="status"
        className="flex h-9 items-center gap-[9px] font-mono text-[11px] uppercase tracking-status text-ink-secondary"
      >
        <span aria-hidden className="inline-flex text-accent-primary">
          <Swatch state="ongoing" size={9} />
        </span>
        Loading session
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex h-9 items-center gap-2 text-[13px] text-ink-primary">
        <Swatch state="error" size={9} />
        {error}
      </div>
    );
  }

  if (activeSessionId !== null && activeSession === null) {
    return (
      <div className="flex h-9 items-center text-[14px] text-ink-secondary">
        Session not found
      </div>
    );
  }

  if (activeSession !== null) {
    const title = getSessionTitle(activeSession);
    if (chapter) {
      return (
        <header
          data-vex-area="session-header"
          role="group"
          aria-label={`Session: ${title}`}
          className="flex items-start justify-between gap-4 pb-1.5 pt-2"
        >
          <h1 className="vex-chapter__title min-w-0">{title}</h1>
          {/* Trailing slot - right-edge context host (see prop doc). */}
          {trailing}
        </header>
      );
    }
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
