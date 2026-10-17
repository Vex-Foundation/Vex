/**
 * THE VEX SIDEBAR: the right column of the shell, Vex's own
 * (docs/design/R3-MINIMAL.md section 5). Information first, then her face:
 *
 *   aside[data-vex-area="vex-sidebar"][data-vex-vex-open]
 *     head            "Vex" and the hide key (44, a window drag row)
 *     body
 *       state         a 12px fill, the scope and the word, the live timer;
 *                     the narration; the background missions
 *       Needs you     the same list as the title bar's panel
 *       This project  Studio: the project's facts, Project assets, Agent Scan
 *       slot          a page's own block (the Board's Ask Vex)
 *       plate         the 280px print window with the K2 hologram
 *       foot          "Show avatar" and its switch
 *
 * On the Lighter desk the plate is followed by the desk chat, which takes the
 * rest of the column, and there is no foot. With the avatar off there is no
 * plate and no hologram: the 44px flat token in its state ring (`VexStatus`)
 * stands beside the state instead, and everything else stays.
 *
 * SHE DOCKS: a column that shows after the shell came up (the first message
 * off the welcome, where she stood in the centre, or the column shown again)
 * plays her open episode in the plate; a column open from the start shows her
 * as she is. Under reduced motion she simply appears.
 *
 * HIDDEN is zero width: the frame gives the column a 0px track and the aside
 * renders its head and body only while open, so nothing in a closed column
 * takes focus, runs a query or paints her. The title bar's token chip keeps
 * the fill, the word and the timer meanwhile.
 *
 * HIDING PLAYS HER CLOSE FIRST (`vex-hide.ts`): when the user hides the
 * column (its hide key, the token chip, the shortcut), she collapses into the
 * token in the plate and only then does the column go, so the unmount waits
 * for the episode. Under reduced motion or Save-Data, with the avatar off or
 * with her plate hidden under the inspect view there is nothing to watch and
 * the column goes at once. While she closes the column is inert (nothing in
 * it takes a click or focus), and focus that was inside it moves to the token
 * chip, the control that brings her back; a hide that skips the episode hands
 * focus over the same way. A column the shell closes on its own goes at once.
 *
 * THE INSPECT VIEW takes over the body for one tool call (a Back key returns):
 * the body is hidden, never unmounted, so her canvas and the page slot keep
 * their state. A payload from another session never renders, and switching
 * the session closes the view.
 *
 * Paint and layout only: every state, word and count comes from
 * `useVexPresence` (no invented text), the Needs you list never decides an
 * approval (Review opens the card), and the store setters are the existing
 * ones.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { LineBack, LinePanelRight } from "../../components/icons/line/index.js";
import { Swatch } from "../../components/ui/swatch.js";
import { useProject } from "../../lib/api/projects.js";
import { prefersReducedMotion } from "../../lib/motion/reduced-motion.js";
import { prefersStillFrame } from "../../lib/motion/use-still-frame.js";
import { cn } from "../../lib/utils.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import { useUiStore, type RuntimeMode } from "../../stores/uiStore.js";
import { assetsRouteFor, type ShellScreenOrigin } from "../../stores/uiStore/shell-route.js";
import { BookInspectPanel } from "../appShell/book/inspect/BookInspectPanel.js";
import { useToolInspectStore } from "../appShell/book/inspect/inspect-store.js";
import { LighterChatRail } from "../appShell/lighterTrading/LighterChatRail.js";
import { formatSessionTime } from "../appShell/sessionListModel.js";
import { formatElapsed } from "../appShell/TurnIsland/ElapsedCounter.js";
import type { NeedsYouItem } from "./needs-you.js";
import { NeedsYouList } from "./needs-you/NeedsYouList.js";
import { useVexPresence, type VexPresence } from "./useVexPresence.js";
import { vexEmotionOf } from "./vex-emotion.js";
import { VexPortraitPlate } from "./VexPortraitPlate.js";
import { VexStatus } from "./VexStatus.js";
import { takeVexDock, vexDockPending } from "./vex-dock.js";
import {
  VEX_HIDE_EPISODE_MS,
  registerVexCloser,
  requestVexHide,
  setVexClosing,
} from "./vex-hide.js";
import { setVexSidebarSlot } from "./vex-sidebar-slot.js";

export interface VexSidebarProps {
  /** Whether the column is open; the frame solved it (0px track when closed). */
  readonly open: boolean;
  /** The hide key: the frame writes the page class's stored choice. */
  readonly onHide: () => void;
}

/** The title bar's token chip: where focus goes when the column it was in goes. */
function tokenChip(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-area='vex-token-chip']");
}

/** Move focus out of the column to the token chip, when focus is in the column. */
function handFocusOut(aside: HTMLElement | null): void {
  if (aside === null || !aside.contains(document.activeElement)) return;
  tokenChip()?.focus({ preventScroll: true });
}

/** Her plate is in the column and not hidden under the inspect view. */
function plateOnScreen(aside: HTMLElement): boolean {
  const plate = aside.querySelector("[data-vex-area='vex-portrait-plate']");
  return plate !== null && plate.closest("[hidden]") === null;
}

export function VexSidebar({ open, onHide }: VexSidebarProps): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const theme = useUiStore((s) => s.theme);
  const environment = useLighterAnalysisStore((s) => s.desk.environment);
  const lighter = runtimeMode === "lighter";
  const asideRef = useRef<HTMLElement | null>(null);
  // She docks when the column shows after the shell came up: from the
  // welcome, or open again after a hide.
  const [dock, setDock] = useState(() => !open || vexDockPending());
  useEffect(() => {
    takeVexDock();
  }, []);
  useEffect(() => {
    if (!open) setDock(true);
  }, [open]);

  // Her close, played before a hide the user asked for commits.
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    let timer: number | null = null;
    const stop = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      setClosing(false);
      setVexClosing(false);
    };
    const unregister = registerVexCloser({
      close: (commit) => {
        const aside = asideRef.current;
        handFocusOut(aside);
        if (timer !== null) return true;
        if (aside === null || prefersStillFrame() || !plateOnScreen(aside)) return false;
        setClosing(true);
        setVexClosing(true);
        timer = window.setTimeout(() => {
          timer = null;
          // Committed in the same task as the reset, so the column closes
          // on the token she became rather than opening her first.
          setClosing(false);
          setVexClosing(false);
          commit();
        }, VEX_HIDE_EPISODE_MS);
        return true;
      },
      keep: stop,
    });
    return () => {
      stop();
      unregister();
    };
  }, [open]);

  return (
    <aside
      ref={asideRef}
      aria-label="Vex"
      data-vex-area="vex-sidebar"
      data-vex-vex-open={open ? "true" : "false"}
      data-vex-vs-mode={runtimeMode}
      data-vex-vs-closing={open && closing ? "" : undefined}
      inert={open && closing}
      // On the desk the column carries the Lighter role scope, as the desk
      // chat's frame always has (lighter-tokens.css).
      data-lighter-theme={lighter ? theme : undefined}
      data-lighter-environment={lighter ? environment : undefined}
      className={cn("vex-vs", lighter && "lit-chat-frame")}
    >
      {open ? (
        <VexSidebarContent onHide={onHide} dock={dock} closing={closing} />
      ) : null}
    </aside>
  );
}

function VexSidebarContent({
  onHide,
  dock,
  closing,
}: {
  readonly onHide: () => void;
  readonly dock: boolean;
  /** Her close is playing: the plate collapses her into the token. */
  readonly closing: boolean;
}): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const showAvatar = useUiStore((s) => s.showAvatar);
  const setShowAvatar = useUiStore((s) => s.setShowAvatar);
  const presence = useVexPresence();
  const lighter = runtimeMode === "lighter";
  const studio = runtimeMode === "studio";

  // The inspect view: only this session's call, and a session switch closes it.
  const inspect = useToolInspectStore((s) => s.inspect);
  const closeToolInspect = useToolInspectStore((s) => s.closeToolInspect);
  const inspectSessionId = studio ? null : activeSessionId;
  const lastSession = useRef(inspectSessionId);
  useEffect(() => {
    if (lastSession.current === inspectSessionId) return;
    lastSession.current = inspectSessionId;
    closeToolInspect();
  }, [inspectSessionId, closeToolInspect]);
  const shownInspect =
    inspect !== null && inspectSessionId !== null && inspect.sessionId === inspectSessionId
      ? inspect
      : null;
  const inspecting = shownInspect !== null;

  return (
    <>
      <header className="vex-vs__head vex-drag">
        <span className="vex-vs__title">Vex</span>
        <button
          type="button"
          aria-label="Hide Vex"
          title="Hide Vex"
          onClick={() => requestVexHide(onHide)}
          className="vex-vs__key"
        >
          <LinePanelRight size={16} />
        </button>
      </header>

      {shownInspect !== null ? (
        <div className="vex-vs__inspect">
          <button
            type="button"
            onClick={closeToolInspect}
            className="vex-vs__back"
          >
            <LineBack size={14} />
            Back
          </button>
          <BookInspectPanel inspect={shownInspect} />
        </div>
      ) : null}

      <div
        data-vex-area="vex-sidebar-body"
        hidden={inspecting}
        className="vex-vs__body"
      >
        <div className="vex-vs__info">
          <VexStateBlock presence={presence} avatar={showAvatar} />
          <NeedsYouSection
            presence={presence}
            runtimeMode={runtimeMode}
            activeSessionId={activeSessionId}
          />
          {studio && activeProjectId !== null ? <ThisProjectBlock projectId={activeProjectId} /> : null}
          <div ref={setVexSidebarSlot} data-vex-area="vex-sidebar-slot" className="vex-vs__slot" />
        </div>
        {lighter ? null : <div className="vex-vs__spacer" />}
        {showAvatar ? (
          <VexPortraitPlate
            emotion={vexEmotionOf(presence.state)}
            dock={dock}
            closed={closing}
          />
        ) : null}
        {lighter ? (
          <div data-vex-area="vex-desk-chat" className="vex-vs__desk">
            <LighterChatRail />
          </div>
        ) : (
          <div className="vex-vs__foot">
            <span id="vex-vs-avatar-label">Show avatar</span>
            <button
              type="button"
              role="switch"
              aria-checked={showAvatar}
              aria-labelledby="vex-vs-avatar-label"
              onClick={() => setShowAvatar(!showAvatar)}
              className="vex-vs__switch"
            />
          </div>
        )}
      </div>
    </>
  );
}

/* --------------------------------- state --------------------------------- */

function VexStateBlock({
  presence,
  avatar,
}: {
  readonly presence: VexPresence;
  readonly avatar: boolean;
}): JSX.Element {
  const { state, word, fill, scope, timerStartedAt, narration, background } = presence;
  const main = (
    <div className="vex-vs__state-main">
      <div className="vex-vs__row">
        <Swatch state={fill} size={12} className="vex-vs__sw text-accent-primary" />
        <p className="vex-vs__word">
          {scope === null ? null : <span className="vex-vs__scope">{`${scope} `}</span>}
          {word}
        </p>
        {timerStartedAt === null ? null : <VexTimer startedAtMs={timerStartedAt} />}
      </div>
      {narration === null ? null : <p className="vex-vs__narr">{narration}</p>}
      {background.summary === null ? null : (
        <p data-vex-area="vex-background" className="vex-vs__bg">
          <Swatch state="done" size={10} className="vex-vs__sw text-accent-primary" />
          <span>{background.summary}</span>
        </p>
      )}
    </div>
  );
  return (
    <div data-vex-area="vex-state" data-vex-state={state} className="vex-vs__state">
      {avatar ? main : <VexStatus state={state}>{main}</VexStatus>}
    </div>
  );
}

/** The live m:ss beside the word; recomputed from the start, so it never drifts. */
function VexTimer({ startedAtMs }: { readonly startedAtMs: number }): JSX.Element {
  const [label, setLabel] = useState(() => formatElapsed(Date.now() - startedAtMs));
  useEffect(() => {
    const tick = (): void => setLabel(formatElapsed(Date.now() - startedAtMs));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAtMs]);
  return <span className="vex-vs__timer">{label}</span>;
}

/* ------------------------------- Needs you ------------------------------- */

function NeedsYouSection({
  presence,
  runtimeMode,
  activeSessionId,
}: {
  readonly presence: VexPresence;
  readonly runtimeMode: RuntimeMode;
  readonly activeSessionId: string | null;
}): JSX.Element {
  const { needsYou } = presence;
  const count =
    needsYou.status === "unknown"
      ? " · ?"
      : needsYou.count !== null && needsYou.count > 0
        ? ` · ${String(needsYou.count)}`
        : "";
  // The card is in the transcript beside this column: "Review ↓" points at it.
  const here = (item: NeedsYouItem): boolean =>
    item.kind === "approval" && runtimeMode !== "studio" && item.sessionId === activeSessionId;
  return (
    <section aria-label="Needs you" data-vex-area="vex-needs-you" className="vex-vs__sec">
      <h3 className="vex-vs__h">{`Needs you${count}`}</h3>
      <NeedsYouList
        model={needsYou}
        variant="sidebar"
        onReview={openNeedsYouItem}
        goLabel={(item) => (here(item) ? "Review ↓" : item.go)}
      />
    </section>
  );
}

/**
 * Open what a Needs you row names, never decide it. An approval in the chat
 * already open scrolls its card into view; one raised elsewhere opens its
 * session (mode first, then the selection, then the page closed, as the
 * approvals inbox always has); an approval with no session (a Studio project's)
 * opens the Needs you page, where its card is; a mission opens its session.
 */
export function openNeedsYouItem(item: NeedsYouItem): void {
  const ui = useUiStore.getState();
  if (item.sessionId === null) {
    ui.setShellRoute({ kind: "needsYou", origin: null });
    return;
  }
  const alreadyOpen = ui.runtimeMode !== "studio" && ui.activeSessionId === item.sessionId;
  if (!alreadyOpen) {
    ui.setRuntimeMode("agent");
    ui.setActiveSessionId(item.sessionId);
  }
  ui.setShellRoute({ kind: "none" });
  if (item.approvalId !== null) revealApprovalCard(item.approvalId);
}

/** Scroll the approval card into view once the session has painted it. */
function revealApprovalCard(approvalId: string): void {
  requestAnimationFrame(() => {
    const card = Array.from(document.querySelectorAll<HTMLElement>("[data-approval-id]")).find(
      (node) => node.dataset["approvalId"] === approvalId,
    );
    if (card === undefined || typeof card.scrollIntoView !== "function") return;
    card.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  });
}

/* ------------------------------ This project ----------------------------- */

/** The rect of the pressed key: the page's expand-from-trigger entrance. */
function originOf(element: HTMLElement): ShellScreenOrigin {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Studio's "This project": the project's facts as the Studio rail's Project
 * card read them (Mode, Access, Started, Path, from the same detail query),
 * then the two project-scoped pages: Project assets and Agent Scan.
 */
function ThisProjectBlock({ projectId }: { readonly projectId: string }): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const query = useProject(projectId);
  const project = query.data !== undefined && query.data.ok ? query.data.data : null;
  return (
    <section aria-label="This project" data-vex-area="vex-this-project" className="vex-vs__sec">
      <h3 className="vex-vs__h">This project</h3>
      {project === null ? (
        <p className="vex-vs__note">{query.isLoading ? "Loading…" : "Unavailable."}</p>
      ) : (
        <>
          <dl className="vex-vs__kv">
            <dt>Mode</dt>
            <dd>Studio</dd>
            <dt>Access</dt>
            <dd>{project.permission === "full" ? "Full" : "Restricted"}</dd>
            <dt>Started</dt>
            <dd>{formatSessionTime(project.createdAt)}</dd>
          </dl>
          <p className="vex-vs__path" title={project.displayPath}>
            {project.displayPath}
          </p>
        </>
      )}
      <div className="vex-vs__links">
        <button
          type="button"
          onClick={(event) => {
            setShellRoute(
              assetsRouteFor({ kind: "project", projectId }, originOf(event.currentTarget)),
            );
          }}
          className="vex-vs__link"
        >
          Project assets
        </button>
        <button
          type="button"
          onClick={(event) => {
            setShellRoute({ kind: "agentScan", origin: originOf(event.currentTarget), projectId });
          }}
          className="vex-vs__link"
        >
          Agent Scan
        </button>
      </div>
    </section>
  );
}
