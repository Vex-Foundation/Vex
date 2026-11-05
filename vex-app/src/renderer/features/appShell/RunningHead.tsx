/**
 * THE TITLE BAR: the header's title cell (docs/design/H3-DESKTOP.md section
 * 1.3; its contents are still R3-MINIMAL.md section 3's). The Vex key's cell
 * beside it is the header's own (`ShellHeader`, `VexKey`), on the Lighter
 * desk as everywhere else.
 *
 *   - the TITLE cell, over the chat, says where you are: the session title
 *     with its mode ("Agent · Restricted", and the mission badge for a
 *     mission), the page name when a page is open ("Portfolio", "Needs you"
 *     with its count, and for a subpage its crumb, "Portfolio / Agent Scan",
 *     each parent a link up to it: `screens/page-crumbs.ts`), or the Studio
 *     project with its access. The page itself draws no crumb or close row.
 *     The cell ends in the cluster (gap 8): the page keys (a page's own keys
 *     such as Portfolio's refresh, through `pageKeysSlot.tsx`; export; a
 *     close key for a page with no other way back), the Studio host status,
 *     Notices (only while notices exist) and "Needs you · N" (while something
 *     waits or the read failed).
 *
 * The header (`ShellHeader.tsx`) lays the cells out and reserves the window
 * chrome; the title cell is a window drag region (`.vex-drag`) and every
 * control inside it opts out on its own (window-chrome.css). On the welcome
 * the title cell has no title (`empty`).
 *
 * Mounted ONCE by the header for an invariant, not for tidiness:
 * `GlobalApprovalsSync` owns `useGlobalApprovalsLiveSync`, which subscribes to
 * the engine bridge, and preload allows at most one subscriber per event kind
 * per window. A head per shell would mount a second sync across a mode switch
 * and the app-wide inbox would silently lose its live sync. So the header
 * mounts this once, above the mode dispatch, and renders it as a fragment
 * whose first child is the sync in every mode: the cells after it change
 * with the mode, the sync never does. The sync sits outside the cluster, so
 * the cluster moving into Lighter's bar never remounts it.
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
 * ON THE LIGHTER DESK (docs/design/H3-DESKTOP.md section 4.9, the approved
 * desk plate) the title cell holds the desk's own head (`deskHead`: where
 * you are and the desk's three keys, `LighterSidebar`), and the cluster
 * keeps only what the desk can need there: a page's keys and close key while
 * a page stands over the desk, and Notices while notices exist. Needs you
 * is the console's on the desk too, and the desk chat's export is not in the
 * desk's row. `data-vex-area="shell-status-strip"` stays the test seam: the
 * title cell in every mode.
 */

import { Fragment, type JSX, type ReactNode } from "react";
import { useUiStore, type RuntimeMode } from "../../stores/uiStore.js";
import { LineClose } from "../../components/icons/line/index.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { ErrorBoundary } from "../../components/ui/error-boundary.js";
import { useProject } from "../../lib/api/projects.js";
import { useSession } from "../../lib/api/sessions.js";
import { NotificationAnnouncer } from "../../components/ui/notification-announcer.js";
import { NeedsYouControl } from "../vex/NeedsYouControl.js";
import { useNeedsYou } from "../vex/useVexPresence.js";
import { GlobalApprovalsSync } from "./GlobalApprovals.js";
import { MissionRail } from "./MissionRail.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { SessionExportControl } from "./SessionExportControl.js";
import { StudioHostStatusWord } from "./StudioHostStatusWord.js";
import { getSessionTitle } from "./sessionListModel.js";
import { setPageKeysSlot } from "./pageKeysSlot.js";
import { assetsPageTitle, titleBarPageOf, type PageTitle } from "./screens/page-crumbs.js";
import { assetsRouteScope } from "../../stores/uiStore/shell-route.js";
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
   * desk's solve closed is not open); `null` means there is no Vex column to
   * toggle (Zen). Omitted, the chip reads the stored choice.
   */
  readonly vex?: VexToggle | null;
  /** The Lighter desk's head, which the desk's title cell holds. */
  readonly deskHead?: ReactNode;
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

/** A project's name from the shared projects read, or null until it answers. */
function useProjectName(projectId: string | null): string | null {
  const query = useProject(projectId);
  const data = query.data;
  return projectId !== null && data !== undefined && data.ok ? (data.data?.name ?? null) : null;
}

/**
 * The open page's title as the left cell draws it (section 3: "Pages put
 * their name there"), or null with no page open. A project's register names
 * its project, as its own dialog does ("Project assets: vex-core"). Lighter's
 * title row draws the same title while a page stands over the desk
 * (`LighterSidebar.tsx`), so a page opened from Lighter is named too.
 */
export function OpenPageTitle(): JSX.Element | null {
  const route = useUiStore((s) => s.shellRoute);
  const scope = route.kind === "assets" ? assetsRouteScope(route) : null;
  const projectName = useProjectName(scope?.kind === "project" ? scope.projectId : null);
  const page = titleBarPageOf(route);
  if (page === null) return null;
  if (route.kind === "needsYou") return <NeedsYouPageTitle />;
  const named: PageTitle = scope === null ? page : { ...page, name: assetsPageTitle(scope, projectName) };
  return named.parents.length === 0 ? (
    <TitleText name={named.name} sub={named.sub ?? null} />
  ) : (
    <PageCrumbTitle page={named} />
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
  const routeKind = useUiStore((s) => s.shellRoute.kind);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  if (routeKind !== "none") return <OpenPageTitle />;
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

export function RunningHead({
  runtimeMode,
  activeSessionId,
  empty = false,
  deskHead = null,
}: RunningHeadProps): JSX.Element {
  // See the module note: the session-scoped parts belong to the agent shell.
  const sessionScopedId = runtimeMode === "studio" ? null : activeSessionId;
  const lighter = runtimeMode === "lighter";

  const flank = (
    <div className="vex-running-head__flank">
      {/* A page's own keys land here (Portfolio's refresh): the first keys of
       * the cluster, before export and the close key. */}
      <div className="vex-tb-pagekeys" data-vex-area="title-bar-page-keys" ref={setPageKeysSlot} />
      <PageCloseKey runtimeMode={runtimeMode} />
      {lighter ? null : <SessionExportControl activeSessionId={sessionScopedId} />}
      {runtimeMode === "studio" ? <StudioHostStatusWord /> : null}
      {/* Session-LESS failures (memory maintenance) reach the user here too:
       * they are notifications, so the center is their surface. Renders null
       * while there are none. */}
      <NotificationCenter />
      {/* On the desk Needs you is the console's (the approved desk plate). */}
      {lighter ? null : <NeedsYouControl />}
      <NotificationAnnouncer />
    </div>
  );

  // A fragment in every mode, the sync its first child: across a mode switch
  // only what follows the sync changes, so the sync itself is never
  // remounted (its subscription would otherwise be dropped and taken again).
  return (
    <>
      <GlobalApprovalsSync />
      <div
        data-vex-head-cell="title"
        className="vex-running-head vex-drag"
        data-vex-area="shell-status-strip"
        data-vex-desk-head={lighter ? "" : undefined}
        data-empty={empty || undefined}
      >
        {lighter ? (
          <>
            <div className="vex-running-head__start">{deskHead}</div>
            {flank}
          </>
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
      </div>
    </>
  );
}
