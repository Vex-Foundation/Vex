/**
 * THE PRINT PLATE: the sepia plateau print with the agent's flock living in
 * it. One print, one `aria-hidden` canvas, one state. The print never moves;
 * only the animals do, and how they move is the agent state
 * (`flock-engine.ts`).
 *
 * The print is in place: it is laid out at window size (100vw x 100vh, cover,
 * focal point 60% 50%) from the plate's top left corner, so a plate that
 * starts at the window's corner (the left page, its spine, the full window
 * stage) is a window onto the same picture, and the page and the stage line
 * up during the handoff from the unlock (`docs/design/V10-SPREAD.md section 3`
 * and `docs/design/V10-SPREAD.md section 10`).
 *
 * ```
 * div[data-vex-print-plate][data-vex-agent][data-vex-plate-layout]   relative, isolated, the plate fill
 *   img (day print)   shown under celeris
 *   img (night print) shown under chronos (the default)
 *   div (grain)       the print's grain: fractal noise, multiply, 10%, z 1
 *   canvas            the flock, z 3, aria-hidden
 *   children          the caller's furniture over the print (z 4 and up)
 * ```
 *
 * The art is decorative: the running head's tape word carries the state for
 * assistive tech. Reduced motion and Save-Data paint the composed frame once,
 * the same frame every motion starts from.
 */

import { useEffect, useRef, type JSX, type ReactNode } from "react";
import { useReducedMotion } from "../../lib/motion/index.js";
import { cn } from "../../lib/utils.js";
import type { DeskAgentState } from "./agent-state.js";
import {
  FlockEngine,
  PLATE_ART,
  STAGE_POSE,
  type PlateLayout,
  type StagePose,
} from "./flock-engine.js";

type NetworkInformationLike = { readonly saveData?: boolean };

/** The user asked the network to save data: the composed frame only. */
export function prefersSaveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav: Navigator & { readonly connection?: NetworkInformationLike } = navigator;
  return nav.connection?.saveData === true;
}

/** One composed frame instead of motion: reduced motion or Save-Data. */
export function useStillFrame(): boolean {
  const reduced = useReducedMotion();
  return reduced || prefersSaveData();
}

export interface PrintPlateProps {
  /** What the agent is doing; `paused` shows the empty print. */
  readonly state: DeskAgentState;
  /** `page` (the left page; it closes to the spine composition under 120 wide) or `stage`. */
  readonly layout?: PlateLayout;
  /** Stage only: where the eagle sits, fractions of the window. */
  readonly stagePose?: StagePose;
  readonly className?: string;
  /** Furniture over the print; position it yourself, z 4 and up. */
  readonly children?: ReactNode;
}

export function PrintPlate({
  state,
  layout = "page",
  stagePose = STAGE_POSE,
  className,
  children,
}: PrintPlateProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const still = useStillFrame();
  const { x, y, frac, cell } = stagePose;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const engine = new FlockEngine({
      canvas,
      state,
      layout,
      stagePose: { x, y, frac, cell },
      still,
    });
    void engine.start().catch(() => undefined);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => engine.resize());
    observer?.observe(canvas);
    return () => {
      observer?.disconnect();
      engine.destroy();
    };
  }, [state, layout, x, y, frac, cell, still]);

  return (
    <div
      data-vex-print-plate=""
      data-vex-agent={state}
      data-vex-plate-layout={layout}
      className={cn(
        "relative isolate overflow-hidden bg-[#150F0D] [[data-vex-theme=celeris]_&]:bg-[#C7B6A6]",
        className,
      )}
    >
      <img
        src={PLATE_ART.day}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
        className="pointer-events-none absolute left-0 top-0 hidden h-screen w-screen max-w-none select-none object-cover object-[60%_50%] [[data-vex-theme=celeris]_&]:block"
      />
      <img
        src={PLATE_ART.night}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
        className="pointer-events-none absolute left-0 top-0 h-screen w-screen max-w-none select-none object-cover object-[60%_50%] [[data-vex-theme=celeris]_&]:hidden"
      />
      {/* The print's grain sits on the photograph only, under the animals. */}
      <div
        aria-hidden="true"
        data-vex-print-grain=""
        className="pointer-events-none absolute inset-0 z-[1] bg-[url(/art/grain.svg)] bg-[length:220px_220px] opacity-10 mix-blend-multiply"
      />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[3] block size-full [image-rendering:pixelated]"
      />
      {children}
    </div>
  );
}
