/**
 * THE RUNNING HEAD: the centre page's 44px head row, and the window's title
 * bar (docs/design/V10-SPREAD.md sections 4 and 8). Three zones on a
 * 1fr/auto/1fr grid, equal flanks so the centre is truly centred: the
 * MISSION/PLAN badge cluster (left), the one live status word (centre), and
 * the notices, the approvals inbox and the export key (right).
 *
 * The row is a window drag region (`.vex-drag`); every control inside it opts
 * out on its own (window-chrome.css). Its right padding reserves the Windows
 * and Linux caption buttons wherever the BOOK track is too narrow to sit under
 * them (`--vex-book-track`, set by the frame). Under the spread, the gutter
 * folds into this row: the left cell carries the caption's context (`fold`),
 * painted like the gutter (generated content, `aria-hidden`) because it only
 * repeats it. On the welcome stage the row has nothing to say and its rule is
 * transparent (`empty`).
 *
 * Mounted ONCE by the frame for an invariant, not for tidiness:
 * `GlobalApprovals` owns `useGlobalApprovalsLiveSync`, which subscribes to the
 * engine bridge, and preload allows at most one subscriber per event kind per
 * window. If each shell mounted its own head, switching between agent and
 * Studio mode would mount a second `GlobalApprovals` alongside the first for
 * the length of a commit, and the approvals inbox would silently lose its live
 * sync. So the FRAME mounts this once, above the mode dispatch, and only the
 * centre word changes with the mode.
 *
 * `MissionRail` and `SessionExportControl` are SESSION-scoped, and the session
 * they scope to belongs to the AGENT shell. Because this head is mounted above
 * the mode dispatch it keeps rendering while Studio is on screen, and
 * `activeSessionId` survives a mode switch (the store keeps the selection so
 * switching back returns to it) - so in Studio both components would otherwise
 * receive a live session id and paint a mission badge and an export key over a
 * project workspace that has nothing to do with them. This file gates that at
 * the source: in Studio they are handed `null`, which is what each of them
 * already treats as "no session" (both render nothing, and `useSession`'s
 * `enabled: false` means Studio fires no session IPC either).
 *
 * `GlobalApprovals` is deliberately NOT gated: approvals are one app-wide
 * queue and are meant to be visible in whichever mode the user is in.
 * `RunningHead.test.tsx` asserts all of this rather than trusting it.
 *
 * `NotificationCenter` and `NotificationAnnouncer` join it for the same reason:
 * exactly one of each per window, above the mode dispatch. Two centers would
 * fork one list, and two announcers would speak every message twice. The
 * announcer renders only screen-reader live regions (no pixels), and it lives
 * here rather than in `ToastHost` because a permanent `role="alert"` node
 * inside the toast host would make every `role="alert"` query in the app
 * ambiguous.
 *
 * Lighter has no head row of its own: the desk's top bar is its running head,
 * and the flank rides at its right end through a portal
 * (`lighterTrading/shellStripSlot.ts`). The row collapses; the flank only moves
 * in the DOM. `data-vex-area="shell-status-strip"` stays the test seam.
 */

import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RuntimeMode } from "../../stores/uiStore.js";
import { DeskRuleTapeState } from "./DeskRuleTapeState.js";
import { GlobalApprovals } from "./GlobalApprovals.js";
import { MissionRail } from "./MissionRail.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { NotificationAnnouncer } from "../../components/ui/notification-announcer.js";
import { SessionExportControl } from "./SessionExportControl.js";
import { StudioHostStatusWord } from "./StudioHostStatusWord.js";
import { useShellStripSlot } from "./lighterTrading/shellStripSlot.js";

export interface RunningHeadProps {
  readonly runtimeMode: RuntimeMode;
  readonly activeSessionId: string | null;
  /** Under the spread: the gutter's context, carried in the left cell. */
  readonly fold?: ReactNode;
  /** The welcome stage: nothing to say, so the rule under the row is clear. */
  readonly empty?: boolean;
}

export function RunningHead({
  runtimeMode,
  activeSessionId,
  fold = null,
  empty = false,
}: RunningHeadProps): JSX.Element {
  // See the module note: the session-scoped flanks belong to the agent shell.
  const sessionScopedId = runtimeMode === "studio" ? null : activeSessionId;
  const lighter = runtimeMode === "lighter";
  const lighterSlot = useShellStripSlot();
  const flank = (
    <div className="vex-running-head__flank">
      {/* Session-LESS failures (memory maintenance) reach the user here
       * too: they are notifications, so the center is their surface and
       * there is no second pill beside it. Renders null when idle. */}
      <NotificationCenter />
      <GlobalApprovals />
      <NotificationAnnouncer />
      <SessionExportControl activeSessionId={sessionScopedId} />
    </div>
  );
  return (
    <header
      className={lighter ? "contents" : "vex-running-head vex-drag"}
      data-vex-area="shell-status-strip"
      data-collapsed={lighter || undefined}
      data-empty={(!lighter && empty) || undefined}
    >
      {lighter ? (
        lighterSlot === null ? <div hidden>{flank}</div> : createPortal(flank, lighterSlot)
      ) : (
        <>
          <div className="vex-running-head__start">
            {fold}
            <MissionRail activeSessionId={sessionScopedId} />
          </div>
          <div className="vex-running-head__centre">
            {runtimeMode === "studio" ? <StudioHostStatusWord /> : <DeskRuleTapeState />}
          </div>
          {flank}
        </>
      )}
    </header>
  );
}
