/**
 * THE STAGE: her column beside every screen before the shell (docs/design/H3-DESKTOP.md section
 * 4.9, the plates `?plate=stage-*`, approved as drawn on 2026-11-04).
 *
 * `App` mounts ONE `StagePlate` with the pre-shell, so she holds still while the screens change
 * beside her: the wake (the gate), the first run screens (system check, the local runtime and the
 * move of a previous release's data, database) and the setup wizard. The unlock is not one of them
 * (owner decision, 2026-11-09; section 4.13): the lock screen is its own split, Kimm's panel
 * beside the password (`UnlockScreen.tsx`), so the stage stands over it only while the gate lifts
 * away, and lifts away with the gate. It is her
 * column on the shell's seams, laid over the empty middle column of every screen's frame
 * (`StageFrame.tsx`): the Vex key in the header cell, Kimm's section from the header to the bottom
 * row, and the tagline cell under her. Her section, the key and the chord are the shell's own
 * (`KimmSection`, `VexKeyView`, `useVexToggleShortcut`, bound here once while no shell stands),
 * and her open or closed choice is the shell's stored one (`vexOpenChat`), so a choice made before
 * the shell is the one the shell opens with.
 *
 * The layer stands above the screens (z 40) and below the wake (z 50), whose frame leaves her
 * column open. It renders nothing while the shell or the unlock stands, except under the gate's
 * crossfade to either, which lifts it away (`data-vex-stage-exit`).
 *
 * Layout and paint live in `styles/global-css/stage.css`; the crossfade in `chronos-gate.css`.
 */

import { useEffect, type JSX } from "react";
import { REST_LINE, TaglineView } from "../../features/vex/TaglineCell.js";
import { vexBarsMoodOf } from "../../features/vex/vex-bars.js";
import { useVexToggleShortcut } from "../../features/vex/useVexToggleShortcut.js";
import { VexKeyView } from "../../features/vex/VexKey.js";
import { VexSectionAnnouncer } from "../../features/vex/VexSectionAnnouncer.js";
import { announceVexSection, VEX_STAGE_SECTION_ID } from "../../features/vex/vex-section-a11y.js";
import {
  KIMM_HINT_KEYS,
  KIMM_SHORTCUT,
  useKimmFirstCloseHint,
} from "../../features/vex/VexPortraitPlate.js";
import { cn } from "../../lib/utils.js";
import { useUiStore, type View } from "../../stores/uiStore.js";
import { vexOpenPatch } from "../../stores/uiStore/layout.js";
import { KimmHint } from "../vex/kimm/KimmHint.js";
import { useKimmArt } from "../vex/kimm/kimm-art-context.js";
import { KimmSection, kimmGroundStyle } from "../vex/kimm/KimmSection.js";
import {
  getStageVex,
  stageVexEnd,
  stageVexSettle,
  stageVexView,
  stageVexWoken,
  useStageVex,
} from "./stage-vex.js";

/** Which layout the plate takes for a view: H3's stage, the one layout left. */
export type StageLayout = "stage";

const STAGE_VIEWS: ReadonlySet<View> = new Set<View>([
  "splash",
  "systemCheck",
  "runtimeMigration",
  "runtimeBootstrap",
  "migrations",
  "wizard",
]);

/** The views that are still the launch's own story: the wake, and the unlock it hands to. */
const LAUNCH_VIEWS: ReadonlySet<View> = new Set<View>(["splash", "unlock"]);

/**
 * The plate's layout for a view, or null when nothing stands on a stage. The shell and the unlock
 * (the lock screen draws Kimm in its own panel, section 4.13) hold the stage only while the gate
 * lifts it away (`holding`).
 */
export function stageLayoutFor(view: View, holding: boolean): StageLayout | null {
  if (STAGE_VIEWS.has(view)) return "stage";
  return holding ? "stage" : null;
}

/** Her open or closed choice on the stage is the shell's own, the chat's (`vexOpenChat`). */
const CHAT_CLASS = { runtimeMode: "agent", shellRoute: { kind: "none" } } as const;

/** Show or hide her: the same write as the shell's Vex key in a chat. */
function setStageVexOpen(open: boolean): void {
  useUiStore.setState(vexOpenPatch(CHAT_CLASS, open));
}

/**
 * Her column on H3's stage: the Vex key over her, her section from the header to the bottom row,
 * and the tagline cell under her. What she shows is the stage's (`stageVexView`): the Vex key says
 * its state and word, with a timer or a countdown as a figure, and her section its mood. Her art is
 * the nearest `KimmArtProvider`'s: the app's shipped art (VEX Cloud's renders in
 * `public/art/kimm/`, through `kimm-assets.ts`), the stand-ins in the H3 harness.
 */
function StageVexColumn(): JSX.Element {
  const view = stageVexView(useStageVex());
  const open = useUiStore((s) => s.vexOpenChat);
  const hint = useKimmFirstCloseHint(open);
  const art = useKimmArt();
  return (
    <div className="vex-pre-vex">
      <div className="vex-pre-vex__key">
        <VexKeyView
          open={open}
          onToggle={() => setStageVexOpen(!open)}
          state={view.state}
          word={view.word}
          mood={view.mood}
          timer={
            view.note === null ? null : (
              <span className="vex-key__timer vex-num" aria-hidden="true">
                {view.note}
              </span>
            )
          }
          controls={VEX_STAGE_SECTION_ID}
        />
        <VexSectionAnnouncer />
      </div>
      <div className="vex-pre-vex__kimm" data-vex-area="vex-sidebar">
        {/* Her ground, under her section. Open, her section covers it; closed,
            the column under her strip keeps her glyph field, without her
            figure, never an empty column: the stage has no console to stand
            there (owner decision, 2026-11-09). */}
        <div
          aria-hidden="true"
          data-vex-area="vex-stage-ground"
          className="vex-kimm__ground"
          style={kimmGroundStyle(art.field)}
        />
        <KimmSection
          mood={view.mood}
          open={open}
          onOpenChange={(next) => {
            setStageVexOpen(next);
            announceVexSection(next);
          }}
          shortcut={KIMM_SHORTCUT}
          reportsPhase={false}
          id={VEX_STAGE_SECTION_ID}
        />
        {hint ? <KimmHint keys={KIMM_HINT_KEYS} /> : null}
      </div>
      <div className="vex-pre-vex__tagline vex-drag">
        <TaglineView line={REST_LINE} bars={vexBarsMoodOf(view.state)} />
      </div>
    </div>
  );
}

/**
 * The stage's persistent layer: mounted once by `App` with every pre-shell screen and the void the
 * gate covers. It renders nothing while the shell stands, except under the gate's and the page
 * turn's crossfade to it, which lift it away.
 */
export function StagePlate({ className }: { readonly className?: string }): JSX.Element | null {
  const view = useUiStore((s) => s.currentView);
  // Only the gate holds her stage: the unlock's handoff starts from the lock screen, where no
  // stage stands, so the shell (or the wizard, which stands on its own) comes up without one.
  const holding = useUiStore((s) => s.setupGateActive);
  const exit = useStageVex().exit;
  const layout = stageLayoutFor(view, holding);

  // She has no wake episode to wait for: on a launch she is awake as her stage mounts, and the Vex
  // key says "Waking up" only until the pipeline hands off.
  useEffect(() => {
    if (layout === "stage" && getStageVex().launching) stageVexWoken();
  }, [layout]);

  // Leaving the launch (the first run, the wizard, the shell once her stage has gone) ends it: the
  // next unlock, after Lock Vex, starts with her asleep. Under the crossfade to the shell the stage
  // still stands, and its exit with it, until the layer is gone. The unlock keeps the launch though
  // no stage stands beside it ("Welcome back." against "Vex is locked."); once the gate has lifted
  // her stage away over it, the spent crossfade is settled.
  const gone = layout === null;
  const ends = (gone && view !== "unlock") || (view !== "appShell" && !LAUNCH_VIEWS.has(view));
  useEffect(() => {
    if (ends) stageVexEnd();
    else if (gone) stageVexSettle();
  }, [ends, gone]);

  // The chord (Cmd or Ctrl + Shift + B, docs/design/H3-DESKTOP.md section 4.4), bound here once
  // while her stage stands and no shell does: the shell binds its own (`AppShell`), so while the
  // stage lifts away over it only the shell's is bound and a press toggles her once.
  const open = useUiStore((s) => s.vexOpenChat);
  useVexToggleShortcut(
    layout === "stage" && view !== "appShell"
      ? { open, onToggle: () => setStageVexOpen(!open) }
      : null,
  );

  if (layout === null) return null;
  return (
    <div
      data-vex-stage-plate={layout}
      data-vex-stage-exit={exit}
      // Opacity-only under reduced motion: the documented opt-out from the
      // base.css sweep, with its own reduced rule in chronos-gate.css.
      data-vex-motion-opacity=""
      className={cn("vex-stage-plate vex-pre-stand", className)}
    >
      <StageVexColumn />
    </div>
  );
}
