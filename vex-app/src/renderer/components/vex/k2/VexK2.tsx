/**
 * VEX K2: Vex as a halftone portrait on the hex dot screen, projected from the VEX token
 * (`docs/design/R3-MINIMAL.md section 10`). Her host fills the box the caller gives it; she stands
 * in it by `placement` (`k2-rig.ts`) and the engine (`k2-engine.ts`) paints one canvas there.
 *
 * ```
 * div[data-vex-k2=<placement>][data-vex-k2-ground][data-vex-k2-ready?]   her host, aria-hidden
 *    [data-vex-k2-open?][data-vex-k2-closed?]                            her episodes
 *   canvas                                                               her, her light, her token
 * ```
 *
 * The art is decorative: the state word beside her carries the state for assistive tech. She
 * takes no pointer. The still frame (reduced motion, Save-Data, or `still`) paints once.
 *
 * Her episodes (`docs/design/R3-MINIMAL.md sections 10.4 and 11`): `open` assembles her from the
 * token as she first shows (the Vex sidebar's dock from the welcome); `closed` collapses her into
 * the token and, set back, opens her again. Under the still frame she simply appears or goes.
 */
import { type JSX, useEffect, useRef } from "react";
import { useStillFrame } from "../../../lib/motion/use-still-frame.js";
import { cn } from "../../../lib/utils.js";
import { useUiStore } from "../../../stores/uiStore.js";
import type { K2Emotion } from "./k2-emotion.js";
import { K2Engine, type K2Ground } from "./k2-engine.js";
import { fitFor, type K2PlacementName } from "./k2-rig.js";
import type { GestureName } from "./k2-time.js";

export interface VexK2Props {
  /** Where she stands: the Vex sidebar's plate, the welcome's stage, the pre-shell plate. */
  readonly placement: K2PlacementName;
  /** What she shows of the agent (`k2-poses.ts`); only idle plays her idle life. */
  readonly emotion?: K2Emotion;
  /** What she stands on: the print, day paper or night paper. */
  readonly ground: K2Ground;
  /** Paint the still frame only (reduced motion and Save-Data always do). */
  readonly still?: boolean;
  /** Play the wake from the token on mount. */
  readonly wake?: boolean;
  /** The wake has handed her over. */
  readonly onWoken?: () => void;
  /** The pointer is on her (her grin and her peace sign). */
  readonly hover?: boolean;
  /** Review only: plays that gesture 1 s after she is awake. */
  readonly force?: GestureName | null;
  /** The composer she looks at while listening (by default her look goes down and to the side). */
  readonly composer?: () => HTMLElement | null;
  /** Play the open episode on mount: the token turns flat, her beam rises, she assembles. */
  readonly open?: boolean;
  /** She is closed into the token; a change plays the close or the open episode. */
  readonly closed?: boolean;
  readonly className?: string;
}

export function VexK2({
  placement,
  emotion = "idle",
  ground,
  still = false,
  wake = false,
  onWoken,
  hover = false,
  force = null,
  composer,
  open = false,
  closed = false,
  className,
}: VexK2Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<K2Engine | null>(null);
  const frame = useStillFrame() || still;
  const dark = useUiStore((s) => s.theme) === "chronos";
  const live = useRef({ dark, ground, emotion, hover, onWoken, composer, closed });
  live.current = { dark, ground, emotion, hover, onWoken, composer, closed };
  const placeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null) return;
    const now = live.current;
    const engine = new K2Engine({
      host,
      canvas,
      dark: now.dark,
      ground: now.ground,
      still: frame,
      wake,
      onWoken: () => live.current.onWoken?.(),
      force,
      composer: () => live.current.composer?.() ?? null,
      open,
      closed: now.closed,
    });
    engineRef.current = engine;
    engine.setEmotion(now.emotion);
    engine.setHover(now.hover);
    let started = false;
    const place = (): void => {
      // the bust's cut drops while the approval palm shows
      const palm = placement !== "stage" && live.current.emotion === "approval";
      const fit = fitFor(placement, host.clientWidth, host.clientHeight, palm);
      if (fit === null) return;
      engine.setFit(fit);
      if (started) return;
      started = true;
      void engine.start().catch(() => undefined);
    };
    placeRef.current = place;
    place();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      engine.destroy();
      engineRef.current = null;
      placeRef.current = null;
    };
  }, [placement, frame, wake, force, open]);

  useEffect(() => {
    engineRef.current?.setDark(dark);
  }, [dark]);
  useEffect(() => {
    engineRef.current?.setGround(ground);
  }, [ground]);
  useEffect(() => {
    engineRef.current?.setEmotion(emotion);
    placeRef.current?.();
  }, [emotion]);
  useEffect(() => {
    engineRef.current?.setHover(hover);
  }, [hover]);
  useEffect(() => {
    engineRef.current?.setClosed(closed);
  }, [closed]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-vex-k2={placement}
      data-vex-k2-ground={ground}
      data-vex-k2-open={open ? "" : undefined}
      data-vex-k2-closed={closed ? "" : undefined}
      className={cn("pointer-events-none relative overflow-hidden", className)}
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0 block" />
    </div>
  );
}
