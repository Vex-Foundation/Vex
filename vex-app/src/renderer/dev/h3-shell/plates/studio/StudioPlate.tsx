/**
 * OUR H3 PLATE FOR STUDIO (S8-01): the whole window while Studio is open, in
 * the merged H3 frame. A design proposal for the owner, not the product: no
 * code for Studio is written from it until it is approved.
 *
 * THE FRAME IS THE SHELL'S. The plate builds the frame `AppShell` builds,
 * from the same solver (`lib/shell-columns.ts`: the tier, the tracks, the
 * rows, the header's columns) and on the same classes, so shell.css,
 * title-bar.css and vex-sidebar.css place every cell and draw every rule
 * where the product does, at every width: header 76, chats 248, the Vex
 * column 30% of the window, the chat the rest, bottom row 72; under 1024 the
 * 76 rail and the 132 band. The parts that already exist are mounted, over
 * the stand-in bridge's base fixtures as `?state=new-chat` mounts them: the
 * logo and sidebar key cells (`AgentSidebarHeader`), the Vex key (`VexKey`),
 * the network cell (`ChatHeaderCells`), the console's top block and its
 * recent activity (`VexConsole.tsx`) and the account cell (`SidebarProfile`).
 *
 * WHAT IS DRAWN. Studio's own parts, as static markup on the H3 tokens: the
 * Studio sidebar (`StudioSidebarPlate`), the centre (`StudioCentrePlate`),
 * the console's This project block and her section on the stand-in art
 * (`StudioVexColumnPlate`), and in the header the project's title cell with
 * the Studio host's cell. The tagline cell takes a Studio line (proposed).
 *
 * WHAT STUDIO ASKS OF THE FRAME, proposed here:
 *   - the header's title cell names the project ("vex-core", and under it
 *     "Studio · Full access", today's `ProjectTitle` words), and ends in the
 *     host's cell: a state square and RUNNING, over "2 connected" (today's
 *     pill word, `studioHostStatusWord`, in two lines; "Running at capacity"
 *     replaces the figure at capacity, and the pill's card keeps "2 of 16
 *     connections in use"); the cell takes the place of today's host pill,
 *     so the host stays in view while she is open;
 *   - the centre runs to the window's foot, as a page does (section 1.9):
 *     Studio has no composer, so the bottom row is the account cell and the
 *     tagline cell alone.
 */

import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { StateSquare } from "../../../../components/ui/state-square.js";
import { AgentSidebarHeader } from "../../../../features/appShell/AgentSidebarHeader.js";
import { ChatHeaderCells } from "../../../../features/appShell/ChatHeaderCells.js";
import { SidebarProfile } from "../../../../features/appShell/SidebarProfile.js";
import { STUDIO_SIDEBAR_COLLAPSE_LABEL } from "../../../../features/appShell/studio/studio-copy.js";
import { VexKey } from "../../../../features/vex/VexKey.js";
import {
  computeH3ShellColumns,
  h3GridTemplateColumns,
  h3ShellTier,
  shellGridTemplateRows,
  shellHeadTemplateColumns,
} from "../../../../lib/shell-columns.js";
import { StudioCentrePlate, type StudioCentreProps } from "./StudioCentrePlate.js";
import { StudioFilesDrawerPlate, StudioRailPlate, StudioSidebarPlate } from "./StudioSidebarPlate.js";
import { StudioVexColumnPlate } from "./StudioVexColumnPlate.js";
import { SAMPLE_HOST, SAMPLE_PROJECT } from "./studio-sample.js";
import "./studio-plate.css";

function noop(): void {
  // A plate's keys press nothing.
}

/** The window's width, as the frame's own ResizeObserver reads it in the app. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => {
      setWidth(window.innerWidth);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** The header's title cell in Studio: the project, then the host's cell. */
function StudioHeaderTitle(): JSX.Element {
  return (
    <div
      data-vex-head-cell="title"
      className="vex-running-head vex-drag"
      data-vex-area="shell-status-strip"
    >
      <div className="vex-running-head__start">
        <span className="vex-tb-title" data-vex-area="title-bar-title">
          <span className="vex-tb-title__name">{SAMPLE_PROJECT.name}</span>
          <span className="vex-tb-title__sub">Studio · Full access</span>
        </span>
      </div>
      <div className="vex-running-head__flank">
        <div
          className="vex-plate-host"
          data-vex-plate-part="studio-host"
          title={`Vex Studio is serving your projects. ${String(SAMPLE_HOST.connected)} of ${String(SAMPLE_HOST.max)} connections in use.`}
        >
          <span className="vex-plate-host__state">
            <StateSquare state="ongoing" size={6} />
            <span>Running</span>
          </span>
          <span className="vex-plate-host__figure">{`${String(SAMPLE_HOST.connected)} connected`}</span>
        </div>
      </div>
    </div>
  );
}

export interface StudioPlateScene {
  /** Her section open (the Vex key reads HIDE VEX) or closed to the strip. */
  readonly open: boolean;
  readonly centre: StudioCentreProps;
  /** On the rail: its Projects and files drawer stands open over the centre. */
  readonly drawer?: boolean;
}

export function StudioPlate({ scene }: { readonly scene: StudioPlateScene }): JSX.Element {
  const viewport = useWindowWidth();
  // AppShell's solve for the agent shell and Studio: from 1280 up the chats
  // column is the stored choice (open here); from 1024 to 1279 it is
  // the rail (its drawer over Vex's column); under 1024 the band too.
  const tier = h3ShellTier(viewport);
  const cols = computeH3ShellColumns({ viewport, chats: tier === "wide" });
  const band = cols.vexSeat === "band";
  const rail = cols.chatsRail;
  // The drawer is the rail's: with the column open the sections are in it.
  const drawer = rail && scene.drawer === true;
  // The solver is D2's now (docs/design/H3-DESKTOP.md section 6): the plate
  // lays its parts on D2's tracks, Vex's panel over the chat's top right, as
  // Studio itself does; what each part draws is the plate approved under H3.
  const headColumns = shellHeadTemplateColumns({
    chats: cols.chats,
    vex: cols.vex > 0 ? cols.vex : null,
  });
  const frameStyle: CSSProperties &
    Record<"--vex-vex-track" | "--vex-overlay-left" | "--vex-chat-track" | "--vex-panel-w", string> = {
    gridTemplateColumns: h3GridTemplateColumns(cols),
    gridTemplateRows: shellGridTemplateRows({ head: true, foot: true, band }),
    "--vex-vex-track": `${String(cols.vex)}px`,
    "--vex-overlay-left": `${String(cols.chatLeft)}px`,
    "--vex-chat-track": `${String(cols.chat)}px`,
    "--vex-panel-w": `${String(cols.vex)}px`,
  };

  return (
    <main
      className="relative isolate flex h-screen w-screen overflow-hidden bg-[var(--vex-surface-0)] text-foreground"
      data-vex-shell="true"
      data-vex-theme="chronos"
      data-vex-plate-screen="studio"
      data-vex-runtime-mode="studio"
    >
      <div
        className="vex-shell-frame relative z-10 h-full min-w-0 flex-1"
        style={frameStyle}
        data-vex-area="shell-frame"
        data-vex-frame="h3"
        data-vex-seat={cols.vexSeat}
        data-vex-tier={tier}
        data-vex-sidebar-collapsed={rail || undefined}
      >
        <header className="vex-shell-head vex-drag" data-vex-area="shell-head" style={{ gridTemplateColumns: headColumns }}>
          <AgentSidebarHeader rail={rail} label={STUDIO_SIDEBAR_COLLAPSE_LABEL} onCollapse={noop} />
          <div data-vex-head-cell="vex-key" className="vex-shell-head__vex vex-drag">
            <VexKey open={scene.open} onToggle={noop} />
          </div>
          <StudioHeaderTitle />
          <ChatHeaderCells />
        </header>

        <div
          className="vex-left-page relative z-20 h-full min-h-0 min-w-0"
          data-vex-area="left-page"
          data-vex-left-page={rail ? "spine" : "page"}
        >
          <div className="vex-left-page__content">
            {rail ? <StudioRailPlate drawer={drawer} /> : <StudioSidebarPlate />}
          </div>
        </div>
        <div className="vex-shell-account vex-ls" data-vex-area="account-cell" data-rail={rail || undefined}>
          <footer className="vex-ls-foot" data-rail-foot>
            <SidebarProfile sidebarOpen={!rail} />
          </footer>
        </div>

        <section className="vex-shell-centre relative z-10 flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1" data-vex-area="studio-center">
            <StudioCentrePlate {...scene.centre} />
          </div>
          {drawer ? <StudioFilesDrawerPlate /> : null}
        </section>

        {/* Her panel over the chat's top right (section 6.3), after the
          * chat as the shell has it; her bars are its foot strip now. */}
        <div className="vex-shell-vex lit-zen-assistant relative z-10 h-full min-h-0 min-w-0 overflow-visible">
          <StudioVexColumnPlate open={scene.open} band={band} />
        </div>
      </div>
    </main>
  );
}
