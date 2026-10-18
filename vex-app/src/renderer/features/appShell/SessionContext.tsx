/**
 * The selected session's head, above the transcript.
 *
 * IN THE SHELL (`namedByTitleBar`) there is no head: the title bar row names
 * the session and its mode ("Agent · Restricted", docs/design/R3-MINIMAL.md
 * section 3), so a second copy here would be the duplicate R3 removed. Only a
 * trailing slot, when a caller supplies one, gets a row.
 *
 * IN A SIDE RAIL (the embedded Lighter chat) there is no title bar for the
 * session, so the head keeps the per-session EXCEPTION stamp (silence-by-
 * default: `restricted` permission deviates from the defaults; agent/full
 * earn no chrome). Either way the Markdown export key lives in the title bar
 * (`SessionExportControl`), and the loading / error / not-found lines stay
 * here, in the sans at 13 with their fill.
 *
 * Mission identity reads from the title bar's mission badge; the model,
 * context and permission read from the composer. Neither belongs here.
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
   * The shell's title bar already names the session, so no head row is drawn
   * (only a supplied trailing slot gets one). Off (the default) for a side
   * rail, which keeps the exception stamp instead.
   */
  readonly namedByTitleBar?: boolean;
}

export function SessionContext({
  activeSession,
  activeSessionId,
  loading,
  error,
  trailing,
  namedByTitleBar = false,
}: SessionContextProps): JSX.Element | null {
  if (loading) {
    return (
      <div
        role="status"
        className="flex h-9 items-center gap-2 text-[13px] text-ink-tertiary"
      >
        <span aria-hidden className="inline-flex text-accent-primary">
          <Swatch state="ongoing" size={10} />
        </span>
        Loading session
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex h-9 items-center gap-2 text-[13px] text-ink-primary">
        <Swatch state="error" size={10} />
        {error}
      </div>
    );
  }

  if (activeSessionId !== null && activeSession === null) {
    return (
      <div className="flex h-9 items-center text-[13px] text-ink-tertiary">
        Session not found
      </div>
    );
  }

  if (activeSession !== null) {
    const title = getSessionTitle(activeSession);
    if (namedByTitleBar) {
      // The title bar names the session; a supplied trailing slot is the only
      // reason for a row here.
      if (trailing === undefined || trailing === null) return null;
      return (
        <div
          data-vex-area="session-header"
          role="group"
          aria-label={`Session: ${title}`}
          className="flex h-8 items-center justify-end gap-3"
        >
          {trailing}
        </div>
      );
    }
    return (
      <div
        data-vex-area="session-header"
        role="group"
        aria-label={`Session: ${title}`}
        className="flex h-8 items-center justify-end gap-3"
      >
        {/* Mission identity reads from the mission badge; the title reads
            from the left sidebar. The `restricted` exception stamp is the only
            thing this row states on its own. */}
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
