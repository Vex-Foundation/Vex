/**
 * THE STATUS STRIP - three zones on a 1fr/auto/1fr grid, equal flanks so the
 * centre is truly centred: the MISSION/PLAN badge cluster (left), the one live
 * status word (centre), and the approvals inbox plus the export key (right).
 *
 * Extracted verbatim from `AppShell.tsx`'s inline `<header>` for one reason,
 * and it is an invariant rather than tidiness: `GlobalApprovals` owns
 * `useGlobalApprovalsLiveSync`, which subscribes to the engine bridge, and
 * preload allows at most one subscriber per event kind per window. If each
 * shell mounted its own strip, switching between agent and Studio mode would
 * mount a second `GlobalApprovals` alongside the first for the length of a
 * commit, and the approvals inbox would silently lose its live sync. So the
 * FRAME mounts this once, above the mode dispatch, and only the centre word
 * changes with the mode. The hook stays inside `GlobalApprovals` - the plan
 * ratified that simplification; it is already mode-independent.
 *
 * `MissionRail` and `SessionExportControl` are SESSION-scoped, and the session
 * they scope to belongs to the AGENT shell. Because this strip is mounted above
 * the mode dispatch it keeps rendering while Studio is on screen, and
 * `activeSessionId` survives a mode switch (the store keeps the selection so
 * switching back returns to it) - so in Studio both components would otherwise
 * receive a live session id and paint a mission badge and an export key over a
 * project workspace that has nothing to do with them. This file gates that at
 * the source: in Studio they are handed `null`.
 *
 * `null` rather than not rendering them, because `null` is what each of them
 * already treats as "no session": `MissionRail` returns null (its render gate
 * requires a non-null id) and `SessionExportControl` returns null (no resolved
 * session, nothing to export), and both hand `null` on to `useSession`, whose
 * `enabled: false` means Studio also fires no session IPC for a session nobody
 * is looking at. Not rendering them would have the same pixels and would fork
 * the strip's composition by mode for no gain.
 *
 * `GlobalErrorBanner` and `GlobalApprovals` are deliberately NOT gated:
 * approvals are one app-wide queue and are meant to be visible in whichever
 * mode the user is in. `ShellStatusStrip.test.tsx` asserts all of this rather
 * than trusting it.
 *
 * `NotificationCenter` and `NotificationAnnouncer` join them for the same
 * reason and are mounted for the same reason the strip itself is: exactly one
 * of each per window, above the mode dispatch. Two centers would fork one
 * list, and two announcers would speak every message twice. The announcer
 * renders only screen-reader live regions (no pixels), and it lives at the
 * strip rather than in `ToastHost` because a permanent `role="alert"` node
 * inside the toast host would make every `role="alert"` query in the app
 * ambiguous.
 */

import type { JSX } from "react";
import type { RuntimeMode } from "../../stores/uiStore.js";
import { DeskRuleTapeState } from "./DeskRuleTapeState.js";
import { GlobalApprovals } from "./GlobalApprovals.js";
import { GlobalErrorBanner } from "./GlobalErrorBanner.js";
import { MissionRail } from "./MissionRail.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { NotificationAnnouncer } from "../../components/ui/notification-announcer.js";
import { SessionExportControl } from "./SessionExportControl.js";
import { StudioHostStatusWord } from "./StudioHostStatusWord.js";

export interface ShellStatusStripProps {
  readonly runtimeMode: RuntimeMode;
  readonly activeSessionId: string | null;
}

export function ShellStatusStrip({
  runtimeMode,
  activeSessionId,
}: ShellStatusStripProps): JSX.Element {
  // See the module note: the session-scoped flanks belong to the agent shell.
  const sessionScopedId = runtimeMode === "studio" ? null : activeSessionId;
  return (
    <header
      className="relative grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6"
      data-vex-area="shell-status-strip"
    >
      <div className="flex min-w-0 items-center justify-start">
        <MissionRail activeSessionId={sessionScopedId} />
      </div>
      <div className="flex min-w-0 items-center justify-center">
        {runtimeMode === "studio" ? (
          <StudioHostStatusWord />
        ) : (
          <DeskRuleTapeState />
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        {/* Session-LESS failures (memory maintenance) surface here: they
         * belong to no conversation. Renders null when idle. */}
        <GlobalErrorBanner />
        <NotificationCenter />
        <GlobalApprovals />
        <NotificationAnnouncer />
        <SessionExportControl activeSessionId={sessionScopedId} />
      </div>
    </header>
  );
}
