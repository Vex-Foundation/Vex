/**
 * THE STAGE: the picture every pre-shell screen stands on, and the furniture the screens share
 * (`docs/design/R3-MINIMAL.md section 10`).
 *
 * `App` mounts ONE `StagePlate` behind the pre-shell, so the picture holds still while the
 * screens change over it. It has two layouts:
 *
 *   plate  the wake, the unlock and the first run screens (system check, Docker, services,
 *          database): a 720 wide plate at the left at the full window height (the plateau print
 *          by day or night, its grain, Vex rising from the VEX token, her state word on the
 *          print) and paper at the right. A first run screen says what she shows
 *          (`stageVexFace`, `SetupFrame`);
 *   print  the wizard, which draws its own R3 frame and plate over it (`WizardShell`): the same
 *          print at window size, no animal on it.
 *
 *   StagePlate    the persistent plate (decorative, except the state word)
 *   VersionStamp  the small version at the window's bottom right
 *   StageHead     the 44px head row: the title bar's drag region
 *   StageCounter  the giant italic counter on the sky (the wizard's leaf only)
 *   StageGround   the hairline and the mono caption row on the dark ground (the wizard's leaf)
 *
 * Layout and paint live in `styles/global-css/chronos-gate.css`.
 */

import { useEffect, useState, type JSX, type ReactNode } from "react";
import { useStillFrame } from "../../lib/motion/use-still-frame.js";
import { cn } from "../../lib/utils.js";
import { useUiStore, type View } from "../../stores/uiStore.js";
import { StateWord } from "../ui/state-word.js";
import { VexK2 } from "../vex/k2/VexK2.js";
import { wakeEnd } from "../vex/k2/k2-time.js";
import {
  getStageVex,
  stageVexEnd,
  stageVexView,
  stageVexWoken,
  useStageVex,
} from "./stage-vex.js";

/** The day and the night print (the plateau, `public/art/`) and the grain laid on it. */
const PRINT_ART = {
  day: "/art/plateau.jpg",
  night: "/art/plateau-night.jpg",
} as const;

/** How long after the wake the plate waits for the engine before it calls her woken anyway. */
const WAKE_FALLBACK_MS = wakeEnd("full") + 1500;

/**
 * The release the giant counter shows: `0.3.1` of `0.3.1`, and of a
 * pre-release such as `0.4.0-beta.2` the `0.4.0` with the rest returned as
 * the suffix, so a test build never prints a counter wider than its sky.
 */
export function releaseOf(version: string): {
  readonly core: string;
  readonly suffix: string | null;
} {
  const match = /^(\d+\.\d+\.\d+)(.*)$/.exec(version);
  if (match === null) return { core: version, suffix: null };
  const rest = match[2] ?? "";
  return { core: match[1] ?? version, suffix: rest === "" ? null : rest };
}

/** Which layout the plate takes for a view. */
export type StageLayout = "plate" | "print";

const PLATE_VIEWS: ReadonlySet<View> = new Set<View>([
  "splash",
  "unlock",
  "systemCheck",
  "dockerBootstrap",
  "composeBootstrap",
  "migrations",
]);
const PRINT_VIEWS: ReadonlySet<View> = new Set<View>(["wizard"]);

/**
 * The plate's layout for a view, or null when nothing stands on a stage. The shell holds the plate
 * only while the gate or the page turn lifts it away (`holding`).
 */
export function stageLayoutFor(view: View, holding: boolean): StageLayout | null {
  if (PLATE_VIEWS.has(view)) return "plate";
  if (PRINT_VIEWS.has(view)) return "print";
  return holding ? "plate" : null;
}

/** Both prints, one shown per room (`data-vex-theme`), and the grain over them. */
function PrintLayers(): JSX.Element {
  return (
    <>
      <img
        src={PRINT_ART.day}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
        className="vex-stage-plate__img vex-stage-plate__img--day"
      />
      <img
        src={PRINT_ART.night}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
        className="vex-stage-plate__img vex-stage-plate__img--night"
      />
      <div aria-hidden="true" data-vex-print-grain="" className="vex-stage-plate__grain" />
    </>
  );
}

/**
 * The plate at the left: the print, Vex and her state word. She wakes from the token on a launch
 * and never otherwise; the wake belongs to the plate's life, so it is read once when the plate
 * mounts (a changing flag would restart her).
 */
function PlateScene(): JSX.Element {
  const stage = useStageVex();
  const view = stageVexView(stage);
  const [wake] = useState(() => getStageVex().launching);
  const still = useStillFrame();

  // The engine says when the wake has handed her over. Under the still frame she was never asleep,
  // and a plate whose art failed to load never says: both call her woken so the word cannot stick.
  useEffect(() => {
    if (!wake) return;
    if (still) {
      stageVexWoken();
      return;
    }
    const timer = window.setTimeout(stageVexWoken, WAKE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [wake, still]);

  return (
    <div className="vex-stage-plate__plate">
      <PrintLayers />
      <VexK2
        placement="stage"
        ground="print"
        emotion={view.emotion}
        wake={wake}
        onWoken={stageVexWoken}
        className="vex-stage-plate__vex"
      />
      <div className="vex-stage-plate__word">
        <StateWord state={view.swatch} word={view.word} timer={view.note} size={10} />
      </div>
    </div>
  );
}

/**
 * The stage's persistent plate: mounted once by `App` behind every pre-shell screen and the void
 * the gate covers. It renders nothing while the shell stands, except under the gate's and the
 * page turn's crossfade to it, which lift it away.
 */
export function StagePlate({ className }: { readonly className?: string }): JSX.Element | null {
  const view = useUiStore((s) => s.currentView);
  const holding = useUiStore((s) => s.setupGateActive || s.unlockCurtainActive);
  const exit = useStageVex().exit;
  const layout = stageLayoutFor(view, holding);

  // Leaving the launch (the shell, a first run screen) ends the wake: the next plate to mount,
  // after Lock Vex, starts with her asleep.
  useEffect(() => {
    if (layout !== "plate") stageVexEnd();
  }, [layout]);

  if (layout === null) return null;
  return (
    <div
      data-vex-stage-plate={layout}
      data-vex-stage-exit={exit}
      // Opacity-only under reduced motion: the documented opt-out from the
      // base.css sweep, with its own reduced rule in chronos-gate.css.
      data-vex-motion-opacity=""
      className={cn("vex-stage-plate vex-gate-plate pointer-events-none", className)}
    >
      {layout === "plate" ? (
        <PlateScene />
      ) : (
        <div className="vex-stage-plate__full">
          <PrintLayers />
        </div>
      )}
    </div>
  );
}

/** The small version stamp at the bottom right of the wake and the unlock (spec 10.2). */
export function VersionStamp({ className }: { readonly className?: string }): JSX.Element {
  return (
    <span data-vex-version-stamp="" className={cn("vex-stage-stamp vex-num", className)}>
      {`v${__VEX_APP_VERSION__}`}
    </span>
  );
}

/** The head row: the hidden title bar's drag region, clear of the traffic lights. */
export function StageHead({ className }: { readonly className?: string }): JSX.Element {
  return <div aria-hidden="true" className={cn("vex-stage__tb vex-drag", className)} />;
}

/**
 * The giant counter: `(0.3.1)`, `(02)`. Decorative to assistive tech; pass
 * `label` when the number carries information no visible text repeats.
 */
export function StageCounter({
  children,
  label,
  className,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <>
      <span aria-hidden="true" className={cn("vex-stage-counter", className)}>
        ({children})
      </span>
      {label !== undefined ? <span className="sr-only">{label}</span> : null}
    </>
  );
}

/** The release counter, from the app version (the first run screens' sky). */
export function ReleaseCounter({ className }: { readonly className?: string }): JSX.Element {
  return (
    <StageCounter label={`v${__VEX_APP_VERSION__}`} className={className}>
      {releaseOf(__VEX_APP_VERSION__).core}
    </StageCounter>
  );
}

/**
 * The ground: a white hairline over one mono caption row. `rule` replaces
 * the plain hairline.
 */
export function StageGround({
  start,
  end,
  rule,
  className,
}: {
  readonly start?: ReactNode;
  readonly end?: ReactNode;
  readonly rule?: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={cn("vex-stage-ground", className)}>
      {rule ?? <div aria-hidden="true" className="vex-stage-ground__rule" />}
      <div className="vex-stage-ground__row">
        {start ?? <span />}
        {end ?? <span />}
      </div>
    </div>
  );
}
