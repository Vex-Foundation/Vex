/**
 * VEX K2: Vex as a halftone portrait on the hex dot screen, projected from the VEX token
 * (`docs/design/R3-MINIMAL.md section 10`). Her host fills the box the caller gives it; she stands
 * in it by `placement` (`k2-rig.ts`) and the engine (`k2-engine.ts`) paints one canvas there.
 *
 * ```
 * div[data-vex-k2=<placement>][data-vex-k2-ground][data-vex-k2-ready?]   her host, aria-hidden
 *   canvas                                                               her, her light, her token
 * ```
 *
 * The art is decorative: the state word beside her carries the state for assistive tech. She
 * takes no pointer. The still frame (reduced motion, Save-Data, or `still`) paints once.
 */
import { type JSX, useEffect, useRef } from "react";
import { useStillFrame } from "../../../lib/motion/use-still-frame.js";
import { cn } from "../../../lib/utils.js";
import { useUiStore } from "../../../stores/uiStore.js";
import type { K2Emotion } from "./k2-emotion.js";
import { K2Engine, type K2Ground } from "./k2-engine.js";
import { fitOf, type K2PlacementName, placementFor } from "./k2-rig.js";
import type { GestureName } from "./k2-time.js";

export interface VexK2Props {
  /** Where she stands: the Vex sidebar's plate, the welcome's stage, the pre-shell plate. */
  readonly placement: K2PlacementName;
  /** What she shows of the agent; anything but idle holds her idle gestures back. */
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
  className,
}: VexK2Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<K2Engine | null>(null);
  const frame = useStillFrame() || still;
  const dark = useUiStore((s) => s.theme) === "chronos";
  const live = useRef({ dark, ground, emotion, hover, onWoken });
  live.current = { dark, ground, emotion, hover, onWoken };

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
    });
    engineRef.current = engine;
    engine.setEmotion(now.emotion);
    engine.setHover(now.hover);
    let started = false;
    const place = (): void => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      engine.setFit(fitOf(placement, placementFor(placement, w, h)));
      if (started) return;
      started = true;
      void engine.start().catch(() => undefined);
    };
    place();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [placement, frame, wake, force]);

  useEffect(() => {
    engineRef.current?.setDark(dark);
  }, [dark]);
  useEffect(() => {
    engineRef.current?.setGround(ground);
  }, [ground]);
  useEffect(() => {
    engineRef.current?.setEmotion(emotion);
  }, [emotion]);
  useEffect(() => {
    engineRef.current?.setHover(hover);
  }, [hover]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-vex-k2={placement}
      data-vex-k2-ground={ground}
      className={cn("pointer-events-none relative overflow-hidden", className)}
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0 block" />
    </div>
  );
}
