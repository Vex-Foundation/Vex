/**
 * THE VEX SIDEBAR: Vex's own column, between the chats and the chat
 * (docs/design/H3-DESKTOP.md section 1; the right-hand column on the Lighter
 * desk), as R3 drew it (docs/design/R3-MINIMAL.md section 5). Information
 * first, then her face:
 *
 *   aside[data-vex-area="vex-sidebar"][data-vex-vex-open]
 *     head            "Vex" and the hide key (44, a window drag row)
 *     body
 *       state         a 12px fill, the scope and the word, the live timer;
 *                     the narration; the background missions
 *       console top   Needs you, its decision row and the missions row
 *                     (`VexConsoleTop`);
 *                     on the Lighter desk R3's list, as its title bar's
 *       This project  Studio: the project's facts, Project assets, Agent Scan
 *       slot          a page's own block (the Board's Ask Vex)
 *       plate         the 280px print window with the K2 hologram
 *       foot          "Show avatar" and its switch
 *
 * On the Lighter desk the plate is followed by the desk chat, which takes the
 * rest of the column, and there is no foot. With the avatar off there is no
 * plate and no hologram: the 44px flat token (`VexStatus`, no ring round it)
 * stands beside the state instead, and everything else stays.
 *
 * SHE DOCKS: a column shown again after a hide plays her open episode in the
 * plate; a column open from the start shows her as she is. The welcome keeps
 * her column (docs/design/H3-DESKTOP.md section 1.7), so she never stands in
 * its centre to dock from. Under reduced motion she simply appears.
 *
 * WHAT HIDING HIDES (docs/design/H3-DESKTOP.md sections 1.2 and 3.6). In a
 * chat, in the agent shell and Studio, her column stays: hiding Vex hides
 * only her plate inside it (`plate` false), the forerunner of Kimm's section,
 * and her state, Needs you and the rest stand where they were, the flat token
 * beside the state in the plate's place. Nothing about the plate reaches the
 * frame's tracks, so a waiting card never moves. On the table pages hiding
 * folds the whole column to the page's strip, and on the Lighter desk it
 * closes the desk chat's column, as R3's hide did.
 *
 * A CLOSED COLUMN is zero width: the frame gives it a 0px track and the
 * aside renders its head and body only while open, so nothing in a closed
 * column takes focus, runs a query or paints her. The header's Vex key keeps
 * the fill, the word and the timer meanwhile.
 *
 * HIDING PLAYS HER CLOSE FIRST (`vex-hide.ts`): when the user hides her (the
 * column's hide key, the Vex key, the shortcut), she collapses into the
 * token in the plate and only then does the write land, so the plate (or the
 * column) waits for the episode. Under reduced motion or Save-Data, with the
 * avatar off or with her plate hidden under the inspect view there is
 * nothing to watch and the write lands at once. While she closes the column
 * is inert (nothing in it takes a click or focus). Where the column goes with
 * her, focus that was inside it moves to the header's Vex key (the desk's
 * token chip), the control that brings her back (section 3.4); where it stays
 * (`stays`), focus stays on the key that was pressed. A column the shell
 * closes on its own goes at once.
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
import { LineBack, LinePanelLeft, LinePanelRight } from "../../components/icons/line/index.js";
import { Swatch } from "../../components/ui/swatch.js";
import { useProject } from "../../lib/api/projects.js";
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
import { needsYouItemIsHere, openNeedsYouItem } from "./needs-you-open.js";
import { useAllMissions, useVexPresence, type VexPresence } from "./useVexPresence.js";
import { VexConsoleActivity, VexConsolePermission, VexConsoleTop } from "./VexConsole.js";
import { vexEmotionOf } from "./vex-emotion.js";
import { VexPortraitPlate } from "./VexPortraitPlate.js";
import { VexStatus } from "./VexStatus.js";
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
  /**
   * Where the frame seats her: her own column, or under 1024 the band under
   * the header, over the chat (docs/design/H3-DESKTOP.md section 1.10), where
   * the same parts lie in one row (vex-sidebar.css).
   */
  readonly seat?: "column" | "band";
  /** The hide key: the frame writes the page class's stored choice. */
  readonly onHide: () => void;
  /**
   * Her portrait plate shows: the page class's stored choice where the column
   * stands whatever it says (a chat, in the agent shell and Studio). Hidden,
   * the column keeps everything else. Defaults to shown.
   */
  readonly plate?: boolean;
  /**
   * The column stays when she hides (a chat): her close keeps focus where it
   * is rather than handing it to the token chip.
   */
  readonly stays?: boolean;
}

/**
 * Where focus goes when the column it was in goes: the control that brings
 * her back. The header's Vex key (docs/design/H3-DESKTOP.md section 3.4), or
 * on the Lighter desk the title row's token chip.
 */
function vexToggleControl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-vex-area='vex-key'], [data-vex-area='vex-token-chip']",
  );
}

/** Move focus out of the column to the Vex key, when focus is in the column. */
function handFocusOut(aside: HTMLElement | null): void {
  if (aside === null || !aside.contains(document.activeElement)) return;
  vexToggleControl()?.focus({ preventScroll: true });
}

/** Her plate is in the column and not hidden under the inspect view. */
function plateOnScreen(aside: HTMLElement): boolean {
  const plate = aside.querySelector("[data-vex-area='vex-portrait-plate']");
  return plate !== null && plate.closest("[hidden]") === null;
}

export function VexSidebar({
  open,
  onHide,
  seat = "column",
  plate = true,
  stays = false,
}: VexSidebarProps): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const theme = useUiStore((s) => s.theme);
  const environment = useLighterAnalysisStore((s) => s.desk.environment);
  const lighter = runtimeMode === "lighter";
  const asideRef = useRef<HTMLElement | null>(null);
  // She docks when she shows again after a hide (her column, or her plate in
  // a column that stayed); shown from the start (the welcome's included) she
  // stands as she is.
  const shown = open && plate;
  const [dock, setDock] = useState(() => !shown);
  useEffect(() => {
    if (!shown) setDock(true);
  }, [shown]);

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
        if (!stays) handFocusOut(aside);
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
  }, [open, stays]);

  return (
    <aside
      ref={asideRef}
      aria-label="Vex"
      data-vex-area="vex-sidebar"
      data-vex-vex-open={open ? "true" : "false"}
      data-vex-vs-mode={runtimeMode}
      data-vex-seat={seat}
      data-vex-vs-closing={open && closing ? "" : undefined}
      inert={open && closing}
      // On the desk the column carries the Lighter role scope, as the desk
      // chat's frame always has (lighter-tokens.css).
      data-lighter-theme={lighter ? theme : undefined}
      data-lighter-environment={lighter ? environment : undefined}
      className={cn("vex-vs", lighter && "lit-chat-frame")}
    >
      {open ? (
        <VexSidebarContent onHide={onHide} dock={dock} closing={closing} plate={plate} />
      ) : null}
    </aside>
  );
}

function VexSidebarContent({
  onHide,
  dock,
  closing,
  plate,
}: {
  readonly onHide: () => void;
  readonly dock: boolean;
  /** Her close is playing: the plate collapses her into the token. */
  readonly closing: boolean;
  /** Her plate shows (the stored choice where the column stays). */
  readonly plate: boolean;
}): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const showAvatar = useUiStore((s) => s.showAvatar);
  const setShowAvatar = useUiStore((s) => s.setShowAvatar);
  const presence = useVexPresence();
  const missions = useAllMissions();
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
          {/* The panel the key folds, on the side it stands: the right on
            * the Lighter desk, the left of the chat everywhere else. */}
          {lighter ? <LinePanelRight size={16} /> : <LinePanelLeft size={16} />}
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
          <VexStateBlock presence={presence} avatar={showAvatar && plate} />
          {/* The console's Needs you (H3-DESKTOP.md section 1.5); the Lighter
            * desk keeps R3's list until its own restyle. */}
          {lighter ? (
            <NeedsYouSection
              presence={presence}
              runtimeMode={runtimeMode}
              activeSessionId={activeSessionId}
            />
          ) : (
            <VexConsoleTop needsYou={presence.needsYou} missions={missions} />
          )}
          {studio && activeProjectId !== null ? <ThisProjectBlock projectId={activeProjectId} /> : null}
          <div ref={setVexSidebarSlot} data-vex-area="vex-sidebar-slot" className="vex-vs__slot" />
        </div>
        {showAvatar && plate ? (
          <VexPortraitPlate
            emotion={vexEmotionOf(presence.state)}
            dock={dock}
            closed={closing}
          />
        ) : null}
        {/* The console's rest (H3-DESKTOP.md section 1.5): under her plate,
          * the part her section covers while open. Not on the Lighter desk,
          * whose chat takes the rest of its column. */}
        {lighter ? null : (
          <div className="vex-vs__rest" data-vex-area="vex-console-rest">
            <VexConsolePermission sessionId={studio ? null : activeSessionId} />
            <VexConsoleActivity />
          </div>
        )}
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
    needsYouItemIsHere(item, { runtimeMode, activeSessionId });
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
