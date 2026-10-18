/**
 * THE TITLE BAR: the centre column's 44px head row, and the window's drag
 * region (docs/design/R3-MINIMAL.md section 3). Two cells:
 *
 *   - the LEFT cell says where you are: the session title with its mode
 *     ("Agent · Restricted", and the mission badge for a mission), the page
 *     name when a page is open ("Portfolio", "Needs you" with its count, and
 *     for a subpage its crumb, "Portfolio / Agent Scan", each parent a link
 *     up to it: `screens/page-crumbs.ts`), or the Studio project with its
 *     access. The page itself draws no crumb or close row;
 *   - the RIGHT cluster (gap 8): the page keys (export, and a close key for a
 *     page with no other way back), the Studio host status, Notices (only
 *     while notices exist), "Needs you · N" (while something waits or the
 *     read failed), then the token chip ("Vex chat" and its state), which
 *     also shows and hides the Vex sidebar.
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

import { Fragment, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { selectVexOpen, useUiStore, type RuntimeMode } from "../../stores/uiStore.js";
import { LineClose } from "../../components/icons/line/index.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { ErrorBoundary } from "../../components/ui/error-boundary.js";
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
import { titleBarPageOf, type PageTitle } from "./screens/page-crumbs.js";
import { closePageToPrevious, goUpToPage } from "./screens/page-trail.js";

export { titleBarPageOf };

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

/**
 * A subpage's crumb (docs/design/R3-MINIMAL.md section 3): each parent a
 * link up to it (13, muted), the page itself current (14 / 500). Going up
 * goes through the page trail, so a later Escape does not walk back down.
 */
function PageCrumbTitle({ page }: { readonly page: PageTitle }): JSX.Element {
  return (
    <nav aria-label="Breadcrumb" className="vex-tb-title" data-vex-area="title-bar-title">
      {page.parents.map((parent) => (
        <Fragment key={`${parent.route.kind}:${parent.label}`}>
          <button
            type="button"
            className="vex-tb-title__crumb underline-offset-[3px] hover:text-ink-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vex-alias-focus)]"
            onClick={() => goUpToPage(parent.route)}
          >
            {parent.label}
          </button>
          <span aria-hidden className="vex-tb-title__crumb">/</span>
        </Fragment>
      ))}
      <span className="vex-tb-title__name" aria-current="page">
        {page.name}
      </span>
    </nav>
  );
}

/**
 * The page's close key, ONLY where the page has no other way back: a page
 * without a crumb parent outside agent mode, where no nav stands beside it
 * (Studio and Lighter reach Settings from their own bars). Escape does the
 * same everywhere; this key is its pointer twin. It returns to the previous
 * page, else to the bare shell.
 */
function PageCloseKey({ runtimeMode }: { readonly runtimeMode: RuntimeMode }): JSX.Element | null {
  const route = useUiStore((s) => s.shellRoute);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const page = titleBarPageOf(route);
  if (page === null || page.parents.length > 0 || runtimeMode === "agent") return null;
  return (
    <Tooltip label="Close · Esc">
      <button
        type="button"
        aria-label={`Close ${page.name}`}
        className="vex-tb-key"
        onClick={() => closePageToPrevious(() => setShellRoute({ kind: "none" }))}
      >
        <LineClose size={16} />
      </button>
    </Tooltip>
  );
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
    return page.parents.length === 0 ? (
      <TitleText name={page.name} sub={null} />
    ) : (
      <PageCrumbTitle page={page} />
    );
  }
  if (runtimeMode === "studio") return <ProjectTitle projectId={activeProjectId} />;
  return <SessionTitle sessionId={sessionId} />;
}

/**
 * The title cell's own error boundary. The title bar stands outside the
 * centre's boundary (it owns the approvals live sync), so a title that threw
 * used to reach the App boundary and replace the whole window, sidebars and
 * title bar included. Now a failing title (a page crumb over a malformed
 * route, a session or project title) leaves the cell empty and is reported
 * like any boundary catch; everything else in the title bar keeps working,
 * and the next page, session or project renders it again (the reset key).
 */
function TitleCellBoundary({
  runtimeMode,
  sessionId,
  children,
}: {
  readonly runtimeMode: RuntimeMode;
  readonly sessionId: string | null;
  readonly children: ReactNode;
}): JSX.Element {
  const routeKind = useUiStore((s) => s.shellRoute.kind);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  return (
    <ErrorBoundary
      surface="shell.title-bar"
      resetKey={`${runtimeMode}:${routeKind}:${sessionId ?? ""}:${activeProjectId ?? ""}`}
      fallback={() => <span data-vex-title-failed="" className="vex-tb-title" />}
    >
      {children}
    </ErrorBoundary>
  );
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
      <PageCloseKey runtimeMode={runtimeMode} />
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
              <TitleCellBoundary runtimeMode={runtimeMode} sessionId={sessionScopedId}>
                <TitleBarContext runtimeMode={runtimeMode} sessionId={sessionScopedId} />
              </TitleCellBoundary>
            )}
            <MissionRail activeSessionId={sessionScopedId} />
          </div>
          {flank}
        </>
      )}
    </header>
  );
}
