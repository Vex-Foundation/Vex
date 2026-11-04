/**
 * THE VEX SIDEBAR: Vex's own column, between the chats and the chat
 * (docs/design/H3-DESKTOP.md section 1; the right-hand column on the Lighter
 * desk). Under the header's Vex key it is her console, in square cells, with
 * her section laid over its rest (section 1.5):
 *
 *   aside[data-vex-area="vex-sidebar"][data-vex-vex-open][data-vex-seat]
 *     body
 *       console top   Needs you, its decision row and the missions row, a
 *                     fixed height (`VexConsoleTop`)
 *       plate         Kimm's section, laid over the console's rest
 *                     (`VexPortraitPlate` with `kimm`, plan rows S4-04 on);
 *                     on the Lighter desk the print window with the K2
 *                     hologram
 *       console rest  Studio's This project, a page's own block (the Board's
 *                     Ask Vex), AI permission, recent activity and Open
 *                     activity: what her section covers while she is open,
 *                     inert until her close has ended (`useKimmCovers`)
 *
 * The header's Vex key opens and closes her (`VexKey`), with the shortcut;
 * the column has no head row, no state block and no avatar switch of its own
 * (S3-11): her state is the key's line, and her one remembered open or closed
 * choice (`vexOpenChat`) replaced R3's "Show avatar" (S4-14). Her corner key
 * opens her (`setVexOpen`) and hides her through the frame's `onHide`.
 *
 * On the Lighter desk, which keeps R3's frame until its own restyle, the
 * column is R3's Needs you list, the plate and the desk chat, which takes the
 * rest of the column; the desk's title row carries the token chip. Her choice
 * hides the K2 plate there too. On a table page with her closed the column is
 * the page strip, the console's one line (`VexConsoleStrip`, section 1.9).
 * Under 1024 the same parts lie in the band, one row under the header
 * (section 1.10).
 *
 * SHE DOCKS: a column shown again after a hide plays her open episode in the
 * plate; a column open from the start shows her as she is. The welcome keeps
 * her column (docs/design/H3-DESKTOP.md section 1.7), so she never stands in
 * its centre to dock from. Under reduced motion she simply appears.
 *
 * WHAT HIDING HIDES (docs/design/H3-DESKTOP.md sections 1.2 and 3.6). In a
 * chat, in the agent shell and Studio, her column stays: hiding Vex hides
 * only her plate inside it (`plate` false), the forerunner of Kimm's section,
 * and the console stands where it was, its rest showing under the top block
 * in the plate's place. Nothing about the plate reaches the
 * frame's tracks, so a waiting card never moves. On the table pages hiding
 * folds the whole column to the page's strip, and on the Lighter desk it
 * closes the desk chat's column, as R3's hide did.
 *
 * A CLOSED COLUMN is zero width: the frame gives it a 0px track and the
 * aside renders its body only while open, so nothing in a closed
 * column takes focus, runs a query or paints her. The header's Vex key keeps
 * the fill, the word and the timer meanwhile.
 *
 * HIDING PLAYS HER CLOSE FIRST on the Lighter desk (`vex-hide.ts`): when the
 * user hides her (the token chip, the shortcut), she collapses into the token
 * in the plate and only then does the write land, so the column waits for
 * the episode. Under reduced motion or Save-Data, with her figure hidden by
 * her choice or under the inspect view there is nothing to watch and the
 * write lands at once; so it does in H3's frame, where her section's own
 * wipe is the close. While she closes the column
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
import { LineBack } from "../../components/icons/line/index.js";
import { useKimmCovers } from "../../components/vex/kimm/kimm-section-state.js";
import { useProject } from "../../lib/api/projects.js";
import { prefersStillFrame } from "../../lib/motion/use-still-frame.js";
import { cn } from "../../lib/utils.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import { useUiStore, vexPageClass, type RuntimeMode } from "../../stores/uiStore.js";
import { assetsRouteFor, type ShellScreenOrigin } from "../../stores/uiStore/shell-route.js";
import { BookInspectPanel } from "../appShell/book/inspect/BookInspectPanel.js";
import { useToolInspectStore } from "../appShell/book/inspect/inspect-store.js";
import { LighterChatRail } from "../appShell/lighterTrading/LighterChatRail.js";
import { formatSessionTime } from "../appShell/sessionListModel.js";
import type { NeedsYouItem } from "./needs-you.js";
import { NeedsYouList } from "./needs-you/NeedsYouList.js";
import { needsYouItemIsHere, openNeedsYouItem } from "./needs-you-open.js";
import { useAllMissions, useVexPresence, type VexPresence } from "./useVexPresence.js";
import { VexConsoleActivity, VexConsolePermission, VexConsoleTop } from "./VexConsole.js";
import { vexEmotionOf } from "./vex-emotion.js";
import { VexConsoleStrip } from "./VexConsoleStrip.js";
import { VexPortraitPlate } from "./VexPortraitPlate.js";
import { VEX_HIDE_EPISODE_MS, registerVexCloser, setVexClosing } from "./vex-hide.js";
import { setVexSidebarSlot } from "./vex-sidebar-slot.js";

/**
 * The Needs you opener lives in `needs-you-open.ts`, where the console, the
 * page strip and the desk's list all read it; re-exported here for the
 * importers that knew it from this module.
 */
export { openNeedsYouItem } from "./needs-you-open.js";

export interface VexSidebarProps {
  /** Whether the column is open; the frame solved it (0px track when closed). */
  readonly open: boolean;
  /**
   * Where the frame seats her: her own column, or under 1024 the band under
   * the header, over the chat (docs/design/H3-DESKTOP.md section 1.10), where
   * the same parts lie in one row (vex-sidebar.css).
   */
  readonly seat?: "column" | "band";
  /**
   * Hide her: the frame's write of the page class's stored choice. The
   * column draws no hide key of its own any more (the header's Vex key and
   * the shortcut hide her); her section's corner key presses this (S4).
   */
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
  // THE PAGE STRIP (docs/design/H3-DESKTOP.md section 1.9): on a table page
  // her column closed is the frame's strip (`computeH3ShellColumns` seats her
  // there exactly when a table page has her hidden, and the frame then gives
  // her no track), so the closed aside draws the console's one line instead
  // of nothing. The frame stands it over the page (vex-sidebar.css).
  const tablePage = useUiStore((s) => vexPageClass(s) === "pages");
  const strip = !open && !lighter && tablePage;
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
      data-vex-seat={strip ? "strip" : seat}
      data-vex-vs-closing={open && closing ? "" : undefined}
      inert={open && closing}
      // On the desk the column carries the Lighter role scope, as the desk
      // chat's frame always has (lighter-tokens.css).
      data-lighter-theme={lighter ? theme : undefined}
      data-lighter-environment={lighter ? environment : undefined}
      className={cn("vex-vs", lighter && "lit-chat-frame")}
    >
      {strip ? <VexConsoleStrip /> : null}
      {open ? (
        <VexSidebarContent dock={dock} closing={closing} plate={plate} onHide={onHide} />
      ) : null}
    </aside>
  );
}

function VexSidebarContent({
  dock,
  closing,
  plate,
  onHide,
}: {
  readonly dock: boolean;
  /** Her close is playing: the plate collapses her into the token. */
  readonly closing: boolean;
  /** Her plate shows (the stored choice where the column stays). */
  readonly plate: boolean;
  /** Hide her: her corner key's press (the frame's write). */
  readonly onHide: () => void;
}): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  // Her one remembered choice (S4-14), which replaced "Show avatar": in H3's
  // frame it reaches here as `plate`; the desk, which keeps K2's print window
  // until its restyle, reads it to show or hide her figure there too.
  const kimmChoice = useUiStore((s) => s.vexOpenChat);
  const presence = useVexPresence();
  const missions = useAllMissions();
  const lighter = runtimeMode === "lighter";
  const studio = runtimeMode === "studio";
  const figure = lighter ? kimmChoice && plate : plate;
  // Her section covers the console's rest while open and until a close has
  // ended (`kimm-section-state.ts`, S4-11).
  const covered = useKimmCovers();

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
        {lighter ? (
          <div className="vex-vs__info">
            <NeedsYouSection
              presence={presence}
              runtimeMode={runtimeMode}
              activeSessionId={activeSessionId}
            />
            <div ref={setVexSidebarSlot} data-vex-area="vex-sidebar-slot" className="vex-vs__slot" />
          </div>
        ) : (
          // The console's top block (H3-DESKTOP.md section 1.5): a fixed
          // height, the line her section's box starts under.
          <VexConsoleTop needsYou={presence.needsYou} missions={missions} />
        )}
        {lighter ? (
          figure ? (
            <VexPortraitPlate
              emotion={vexEmotionOf(presence.state)}
              dock={dock}
              closed={closing}
            />
          ) : null
        ) : (
          // H3's frame: Kimm's section, laid over the console's rest, mounted
          // open or closed so her large art loads only when she opens (S4-05).
          <VexPortraitPlate kimm state={presence.state} open={plate} onHide={onHide} />
        )}
        {lighter ? (
          <div data-vex-area="vex-desk-chat" className="vex-vs__desk">
            <LighterChatRail />
          </div>
        ) : (
          // The console's rest: under her plate, the part her section covers
          // while open and shows while she is closed; inert while she covers
          // it, until a close has ended (S4-11).
          <div className="vex-vs__rest" data-vex-area="vex-console-rest" inert={covered}>
            {studio && activeProjectId !== null ? <ThisProjectBlock projectId={activeProjectId} /> : null}
            <div ref={setVexSidebarSlot} data-vex-area="vex-sidebar-slot" className="vex-vs__slot" />
            <VexConsolePermission sessionId={studio ? null : activeSessionId} />
            <VexConsoleActivity />
          </div>
        )}
      </div>
    </>
  );
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
