/**
 * THE TITLE BAR: the centre column's 44px head row, and the window's drag
 * region (docs/design/R3-MINIMAL.md section 3). Two cells:
 *
 *   - the LEFT cell says where you are: the session title with its mode
 *     ("Agent · Restricted", and the mission badge for a mission), the page
 *     name when a page is open ("Portfolio", "Needs you" with its count, a
 *     crumb for a subpage), or the Studio project with its access;
 *   - the RIGHT cluster (gap 8): the page keys (export), the Studio host
 *     status, Notices (only while notices exist), "Needs you · N" (always),
 *     then the token chip, which also shows and hides the Vex sidebar.
 *
 * The row is a window drag region (`.vex-drag`); every control inside it opts
 * out on its own (window-chrome.css). Its right padding reserves the Windows
 * and Linux caption buttons wherever the Vex column under them is narrower
 * than they are (title-bar.css). On the welcome the row has no title and no
 * chip (Vex is in the centre there), and its rule is clear (`empty`).
 *
 * Mounted ONCE by the frame for an invariant, not for tidiness:
 * `GlobalApprovalsSync` owns `useGlobalApprovalsLiveSync`, which subscribes to
 * the engine bridge, and preload allows at most one subscriber per event kind
 * per window. A head per shell would mount a second sync across a mode switch
 * and the app-wide inbox would silently lose its live sync. So the FRAME
 * mounts this once, above the mode dispatch. The sync sits outside the right
 * cluster, so the cluster moving into Lighter's bar never remounts it.
 *
 * `MissionRail`, `SessionExportControl` and the session title are
 * SESSION-scoped, and the session they scope to belongs to the agent shell.
 * `activeSessionId` survives a mode switch (switching back returns to it), so
 * in Studio they are handed `null`, which each of them treats as "no session"
 * (render nothing, fire no session IPC). Needs you is deliberately NOT gated:
 * it is one app-wide list, visible in whichever mode the user is in.
 * `RunningHead.test.tsx` asserts all of this rather than trusting it.
 *
 * `NotificationCenter` and `NotificationAnnouncer` live here for the same
 * once-per-window reason: two centers would fork one list, and two announcers
 * would speak every message twice. The announcer renders only screen-reader
 * live regions (no pixels).
 *
 * Lighter has no head row of its own: the desk's top bar is its title bar,
 * and the right cluster rides at its right end through a portal
 * (`lighterTrading/shellStripSlot.ts`). The row collapses; the cluster only
 * moves in the DOM. `data-vex-area="shell-status-strip"` stays the test seam.
 */

import type { JSX } from "react";
import { createPortal } from "react-dom";
import type { ShellRoute } from "../../stores/uiStore/shell-route.js";
import { selectVexOpen, useUiStore, type RuntimeMode } from "../../stores/uiStore.js";
import { useProject } from "../../lib/api/projects.js";
import { useSession } from "../../lib/api/sessions.js";
import { NotificationAnnouncer } from "../../components/ui/notification-announcer.js";
import { NeedsYouControl } from "../vex/NeedsYouControl.js";
import { VexTokenChip } from "../vex/VexTokenChip.js";
import { useNeedsYou } from "../vex/useVexPresence.js";
import { GlobalApprovalsSync } from "./GlobalApprovals.js";
import { MissionRail } from "./MissionRail.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { SessionExportControl } from "./SessionExportControl.js";
import { StudioHostStatusWord } from "./StudioHostStatusWord.js";
import { getSessionTitle } from "./sessionListModel.js";
import { useShellStripSlot } from "./lighterTrading/shellStripSlot.js";

/** The Vex toggle as the frame solved it: open, and the press that flips it. */
export interface VexToggle {
  readonly open: boolean;
  readonly onToggle: () => void;
}

export interface RunningHeadProps {
  readonly runtimeMode: RuntimeMode;
  readonly activeSessionId: string | null;
  /** The welcome stage: nothing to say, so the rule under the row is clear. */
  readonly empty?: boolean;
  /**
   * The Vex toggle. The frame passes the open state it solved (a column the
   * narrow tier closed is not open); `null` means there is no Vex column to
   * toggle (the welcome, Zen). Omitted, the chip reads the stored choice.
   */
  readonly vex?: VexToggle | null;
}

/** The access word of a session or a project. */
function accessWord(permission: "restricted" | "full"): string {
  return permission === "full" ? "Full access" : "Restricted";
}

/** The page name in the left cell, or null with no page open. */
export function titleBarPageOf(
  route: ShellRoute,
): { readonly name: string; readonly crumb: string | null } | null {
  switch (route.kind) {
    case "none":
      return null;
    case "memory":
      return { name: "Memory", crumb: null };
    case "sessions":
      return { name: "Sessions", crumb: null };
    case "howItWorks":
      return { name: "How Vex works", crumb: null };
    case "portfolio":
      return { name: "Portfolio", crumb: null };
    case "board":
      return { name: "Board", crumb: null };
    case "needsYou":
      return { name: "Needs you", crumb: null };
    case "settings":
      return { name: "Settings", crumb: null };
    case "agentScan":
      return { name: "Agent Scan", crumb: "Portfolio" };
    case "assets":
      return { name: "All assets", crumb: "Portfolio" };
    case "tokenHistory":
      return { name: "Token history", crumb: "Portfolio" };
  }
}

function TitleText({
  name,
  sub,
}: {
  readonly name: string;
  readonly sub: string | null;
}): JSX.Element {
  return (
    <span className="vex-tb-title" data-vex-area="title-bar-title">
      <span className="vex-tb-title__name">{name}</span>
      {sub === null ? null : <span className="vex-tb-title__sub">{sub}</span>}
    </span>
  );
}

/** "Needs you" with the number of decisions in muted, from the shared list. */
function NeedsYouPageTitle(): JSX.Element {
  const { count } = useNeedsYou();
  const sub = count === null ? null : `${String(count)} ${count === 1 ? "decision" : "decisions"}`;
  return <TitleText name="Needs you" sub={sub} />;
}

function SessionTitle({ sessionId }: { readonly sessionId: string | null }): JSX.Element | null {
  const query = useSession(sessionId);
  const data = query.data;
  const session = sessionId !== null && data !== undefined && data.ok ? data.data : null;
  if (session === null) return null;
  const mode = session.mode === "mission" ? "Mission" : "Agent";
  return <TitleText name={getSessionTitle(session)} sub={`${mode} · ${accessWord(session.permission)}`} />;
}

function ProjectTitle({ projectId }: { readonly projectId: string | null }): JSX.Element | null {
  const query = useProject(projectId);
  const data = query.data;
  const project = projectId !== null && data !== undefined && data.ok ? data.data : null;
  if (project === null) return null;
  return <TitleText name={project.name} sub={`Studio · ${accessWord(project.permission)}`} />;
}

/** The left cell's words: the page, else the project or the session. */
function TitleBarContext({
  runtimeMode,
  sessionId,
}: {
  readonly runtimeMode: RuntimeMode;
  readonly sessionId: string | null;
}): JSX.Element | null {
  const route = useUiStore((s) => s.shellRoute);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const page = titleBarPageOf(route);
  if (page !== null) {
    if (route.kind === "needsYou") return <NeedsYouPageTitle />;
    return page.crumb === null ? (
      <TitleText name={page.name} sub={null} />
    ) : (
      <span className="vex-tb-title" data-vex-area="title-bar-title">
        <span className="vex-tb-title__crumb">{page.crumb} /</span>
        <span className="vex-tb-title__name">{page.name}</span>
      </span>
    );
  }
  if (runtimeMode === "studio") return <ProjectTitle projectId={activeProjectId} />;
  return <SessionTitle sessionId={sessionId} />;
}

/** The stored choice, for a head mounted without the frame's solve. */
function useStoredVexToggle(): VexToggle {
  const open = useUiStore(selectVexOpen);
  const setVexOpen = useUiStore((s) => s.setVexOpen);
  return { open, onToggle: () => setVexOpen(!open) };
}

export function RunningHead({
  runtimeMode,
  activeSessionId,
  empty = false,
  vex,
}: RunningHeadProps): JSX.Element {
  // See the module note: the session-scoped parts belong to the agent shell.
  const sessionScopedId = runtimeMode === "studio" ? null : activeSessionId;
  const lighter = runtimeMode === "lighter";
  const lighterSlot = useShellStripSlot();
  const stored = useStoredVexToggle();
  const toggle = vex === undefined ? stored : vex;
  // The welcome has Vex in the centre: no column, so no toggle.
  const chip =
    toggle === null || (empty && !lighter) ? null : (
      <VexTokenChip open={toggle.open} onToggle={toggle.onToggle} />
    );

  const flank = (
    <div className="vex-running-head__flank">
      <SessionExportControl activeSessionId={sessionScopedId} />
      {runtimeMode === "studio" ? <StudioHostStatusWord /> : null}
      {/* Session-LESS failures (memory maintenance) reach the user here too:
       * they are notifications, so the center is their surface. Renders null
       * while there are none. */}
      <NotificationCenter />
      <NeedsYouControl />
      {chip}
      <NotificationAnnouncer />
    </div>
  );

  return (
    <header
      className={lighter ? "contents" : "vex-running-head vex-drag"}
      data-vex-area="shell-status-strip"
      data-collapsed={lighter || undefined}
      data-empty={(!lighter && empty) || undefined}
    >
      <GlobalApprovalsSync />
      {lighter ? (
        lighterSlot === null ? <div hidden>{flank}</div> : createPortal(flank, lighterSlot)
      ) : (
        <>
          <div className="vex-running-head__start">
            {empty ? null : (
              <TitleBarContext runtimeMode={runtimeMode} sessionId={sessionScopedId} />
            )}
            <MissionRail activeSessionId={sessionScopedId} />
          </div>
          {flank}
        </>
      )}
    </header>
  );
}
