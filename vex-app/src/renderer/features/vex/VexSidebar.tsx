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
 *                     (`VexPortraitPlate`, plan rows S4-04 on);
 *                     on the Lighter desk over the desk chat
 *       console rest  Studio's This project (`VexConsoleThisProject`), a
 *                     page's own block (the Board's Ask Vex), AI permission,
 *                     recent activity (the open project's, in Studio) and
 *                     Open activity: what her section covers while she is
 *                     open, inert until her close has ended (`useKimmCovers`)
 *
 * The header's Vex key opens and closes her (`VexKey`), with the shortcut;
 * the column has no head row, no state block and no avatar switch of its own
 * (S3-11): her state is the key's line, and her one remembered open or closed
 * choice (`vexOpenChat`) replaced R3's "Show avatar" (S4-14). Her corner key
 * opens her (`setVexOpen`) and hides her through the frame's `onHide`.
 *
 * ON THE LIGHTER DESK (the owner-approved desk plate, H3-DESKTOP.md section
 * 4.9; plan row S8-11) the column is the desk chat, at the desk's right:
 * the console's top block (Needs you, the missions row), her section as a
 * box over it (216 open, 132 under a 1024 window, the 56 strip closed), the
 * desk chat under the strip, and its composer in the bottom row. The column
 * stands whatever she shows; her choice is the desk's own (`vexOpenLighter`)
 * and opens or folds her section alone. On a table page with her closed the
 * column is the page strip, the console's one line (`VexConsoleStrip`,
 * section 1.9).
 * Under 1024 (section 1.10; VEX Cloud's 768 to 1023 layout) there is no
 * column: the aside is the console line, one 48 row under the header across
 * the chat (`VexConsoleStrip` with its state key), and her section is the
 * band, a box laid over the chat's top under it (`KimmSection` with `band`),
 * opened and closed by the person's own session choice and resting while a
 * turn runs, a card waits or the composer is in use (`band-hold.ts`).
 *
 * SHE OPENS in her section's own wipe (`KimmSection`), the welcome's
 * included (docs/design/H3-DESKTOP.md section 1.7). Under reduced motion she
 * simply appears.
 *
 * WHAT HIDING HIDES (docs/design/H3-DESKTOP.md sections 1.2 and 3.6). In a
 * chat, in the agent shell and Studio, her column stays: hiding Vex hides
 * only her plate inside it (`plate` false), the forerunner of Kimm's section,
 * and the console stands where it was, its rest showing under the top block
 * in the plate's place. Nothing about the plate reaches the
 * frame's tracks, so a waiting card never moves. On the table pages hiding
 * folds the whole column to the page's strip. On the Lighter desk it folds
 * her section over the desk chat, which stays.
 *
 * A CLOSED COLUMN is zero width: the frame gives it a 0px track and the
 * aside renders its body only while open, so nothing in a closed
 * column takes focus, runs a query or paints her. The header's Vex key keeps
 * the fill, the word and the timer meanwhile.
 *
 * A HIDE LANDS AT THE PRESS (`vex-hide.ts`): her section's own wipe is the
 * close (docs/design/H3-DESKTOP.md section 3.6), so the open column takes a
 * toggle's hide only to hand focus on, and the write lands at once. Where the
 * column goes with her, focus that was inside it moves to the header's Vex
 * key (the desk's token chip), the control that brings her back (section
 * 3.4); where it stays (`stays`), focus stays on the key that was pressed. A
 * column the shell closes on its own goes at once.
 *
 * THE INSPECT VIEW takes over the body for one tool call (a Back key returns):
 * the body is hidden, never unmounted, so her section and the page slot keep
 * their state. A payload from another session never renders, and switching
 * the session closes the view.
 *
 * Paint and layout only: every state, word and count comes from
 * `useVexPresence` (no invented text), the Needs you list never decides an
 * approval (Review opens the card), and the store setters are the existing
 * ones.
 */

import { useEffect, useRef, type JSX } from "react";
import { LineBack } from "../../components/icons/line/index.js";
import { useKimmCovers } from "../../components/vex/kimm/kimm-section-state.js";
import { cn } from "../../lib/utils.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import { useUiStore, vexPageClass } from "../../stores/uiStore.js";
import { BookInspectPanel } from "../appShell/book/inspect/BookInspectPanel.js";
import { useToolInspectStore } from "../appShell/book/inspect/inspect-store.js";
import { LighterChatRail } from "../appShell/lighterTrading/LighterChatRail.js";
import { useAllMissions, useVexPresence } from "./useVexPresence.js";
import {
  VexConsoleActivity,
  VexConsolePermission,
  VexConsoleThisProject,
  VexConsoleTop,
} from "./VexConsole.js";
import { VexConsoleStrip, type VexConsoleLineBand } from "./VexConsoleStrip.js";
import { KIMM_SHORTCUT, VexPortraitPlate } from "./VexPortraitPlate.js";
import { KimmSection } from "../../components/vex/kimm/KimmSection.js";
import { kimmMoodOf } from "./kimm-mood.js";
import { TAGLINES, taglineMomentOf } from "./TaglineCell.js";
import { registerVexCloser } from "./vex-hide.js";
import { announceVexSection, VEX_SECTION_ID } from "./vex-section-a11y.js";
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
  /**
   * Under 1024 (`seat` "band"): her band as the frame solved it, the console
   * line's key, and the band's own close (its foot row).
   */
  readonly band?: VexConsoleLineBand & { readonly onClose: () => void };
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

export function VexSidebar({
  open,
  onHide,
  seat = "column",
  plate = true,
  stays = false,
  band,
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

  // A hide the user asked for: her section's own wipe is the close, so the
  // open column only hands focus on and declines, and the write lands now.
  useEffect(() => {
    if (!open) return undefined;
    return registerVexCloser({
      close: () => {
        if (!stays) handFocusOut(asideRef.current);
        return false;
      },
      keep: () => undefined,
    });
  }, [open, stays]);

  return (
    <aside
      ref={asideRef}
      aria-label="Vex"
      data-vex-area="vex-sidebar"
      data-vex-vex-open={open ? "true" : "false"}
      data-vex-vs-mode={runtimeMode}
      data-vex-seat={strip ? "strip" : seat}
      // On the desk the column carries the Lighter role scope, as the desk
      // chat's frame always has (lighter-tokens.css).
      data-lighter-theme={lighter ? theme : undefined}
      data-lighter-environment={lighter ? environment : undefined}
      className={cn("vex-vs", lighter && "lit-chat-frame")}
    >
      {strip ? <VexConsoleStrip /> : null}
      {seat === "band" && band !== undefined && !lighter ? (
        <>
          <VexConsoleStrip band={band} />
          <VexBand open={band.open} onClose={band.onClose} />
        </>
      ) : open ? (
        <VexSidebarContent plate={plate} onHide={onHide} />
      ) : null}
    </aside>
  );
}

/**
 * Her band under 1024 (section 1.10): her section in its band seat, her mood
 * from Vex's state, and on its foot row the moment's words, the tagline the
 * bottom row says beside her column from 1024 up.
 */
function VexBand({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const pageOpen = useUiStore((s) => s.shellRoute.kind !== "none");
  const { state } = useVexPresence();
  const line = TAGLINES[taglineMomentOf({ runtimeMode, activeSessionId, pageOpen, state })];
  return (
    <KimmSection
      mood={kimmMoodOf(state)}
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
          announceVexSection(false);
        }
      }}
      shortcut={KIMM_SHORTCUT}
      band={{ line }}
      id={VEX_SECTION_ID}
    />
  );
}

function VexSidebarContent({
  plate,
  onHide,
}: {
  /** Her plate shows (the stored choice where the column stays). */
  readonly plate: boolean;
  /** Hide her: her corner key's press (the frame's write). */
  readonly onHide: () => void;
}): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  // Her one remembered choice reaches here as `plate`, the page class's
  // stored choice (the desk's own on the Lighter desk).
  const presence = useVexPresence();
  const missions = useAllMissions();
  const lighter = runtimeMode === "lighter";
  const studio = runtimeMode === "studio";
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
        {/* The console's top block (H3-DESKTOP.md section 1.5): a fixed
          * height, the line her section's box starts under; on the desk too. */}
        <VexConsoleTop needsYou={presence.needsYou} missions={missions} />
        {/* Kimm's section, laid over the column's rest (on the desk, over
          * the desk chat), mounted open or closed so her large art loads only
          * when she opens (S4-05). */}
        <VexPortraitPlate state={presence.state} open={plate} onHide={onHide} />
        {lighter ? (
          // The desk chat, under her strip; her open section covers its top
          // and moves nothing in it (section 3.6).
          <div data-vex-area="vex-desk-chat" className="vex-vs__desk">
            <div ref={setVexSidebarSlot} data-vex-area="vex-sidebar-slot" className="vex-vs__slot" />
            <LighterChatRail />
          </div>
        ) : (
          // The console's rest: under her plate, the part her section covers
          // while open and shows while she is closed; inert while she covers
          // it, until a close has ended (S4-11).
          <div className="vex-vs__rest" data-vex-area="vex-console-rest" inert={covered}>
            {/* In Studio, This project stands where a chat's AI permission
              * does (our approved Studio plate), and recent activity is the
              * open project's. */}
            {studio && activeProjectId !== null ? (
              <VexConsoleThisProject projectId={activeProjectId} />
            ) : null}
            <div ref={setVexSidebarSlot} data-vex-area="vex-sidebar-slot" className="vex-vs__slot" />
            <VexConsolePermission sessionId={studio ? null : activeSessionId} />
            <VexConsoleActivity projectId={studio ? activeProjectId : null} />
          </div>
        )}
      </div>
    </>
  );
}

