/**
 * THE BARS (docs/design/H3-DESKTOP.md section 1.8; VEX Cloud's `.vx-foot
 * canvas`): a canvas on the foot of Vex's column, under her line, drawn from
 * the pure model (`vex-bars.ts`). A display only (Cloud's PD-15): it shows
 * her mood (ready, busy, approve) and nothing else, no figure, no data, no
 * claim. It is the named exception MOTION-POLICY.md gives it ("Vex's bars"),
 * bound three ways:
 *
 *   - THE RUN GATE (`lib/motion/run-gate.ts`): it draws only while the
 *     canvas is on screen and the window is shown; a hidden window or a
 *     column folded away paints no frame, and no frame is asked for.
 *   - A CAPPED STEP: one frame never eases the levels more than 50ms, so a
 *     stalled window resumes calmly.
 *   - THE STILL FRAME (`lib/motion/use-still-frame.ts`): under reduced motion
 *     or Save-Data it paints one settled frame for her mood, again only when
 *     her mood or its box changes; no loop starts.
 *
 * The bars take their colour from the canvas's own CSS `color` (white, the
 * sheet's `--vex-alias-bars`), read once per box, so no colour is spelled
 * here; each bar's alpha is the model's. Decorative: `aria-hidden`, and it
 * takes no pointer.
 */

import { useEffect, useRef, type JSX } from "react";
import { RunGate } from "../../lib/motion/run-gate.js";
import { useStillFrame } from "../../lib/motion/use-still-frame.js";
import {
  VEX_BARS_GAP,
  VEX_BARS_STILL_S,
  VexBarsModel,
  vexBarAlpha,
  vexBarCount,
  type VexBarsMood,
} from "./vex-bars.js";

/** The canvas's box in CSS px and the colour its sheet gives it. */
interface BarsBox {
  readonly width: number;
  readonly height: number;
  readonly color: string;
}

/** Paint the model's bars into the canvas's box. */
export function paintVexBars(canvas: HTMLCanvasElement, model: VexBarsModel, box: BarsBox): boolean {
  const { width, height } = box;
  const context = canvas.getContext("2d");
  if (context === null) return false;
  const ratio = canvas.width / Math.max(1, width);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = box.color;
  const bar = (width - VEX_BARS_GAP * (model.count - 1)) / model.count;
  model.levels().forEach((level, i) => {
    context.globalAlpha = vexBarAlpha(level);
    context.fillRect(i * (bar + VEX_BARS_GAP), 0, bar, height);
  });
  context.globalAlpha = 1;
  return true;
}

export function VexBars({ mood }: { readonly mood: VexBarsMood }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<VexBarsModel | null>(null);
  const boxRef = useRef<BarsBox>({ width: 0, height: 0, color: "" });
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const still = useStillFrame();

  // The model follows the canvas's box: a new width is a new count of bars.
  // Under the still frame every fit (and every change of mood) paints the
  // settled frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const fit = (): void => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      // Its colour is read here, once per box, never per frame.
      boxRef.current = { width, height, color: getComputedStyle(canvas).color };
      const count = vexBarCount(width);
      let model = modelRef.current;
      if (model === null || model.count !== count) {
        model = new VexBarsModel(count);
        modelRef.current = model;
      }
      if (still) model.settle(moodRef.current, VEX_BARS_STILL_S);
      paintVexBars(canvas, model, boxRef.current);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [still]);

  // The still frame follows her mood.
  useEffect(() => {
    const canvas = canvasRef.current;
    const model = modelRef.current;
    if (!still || canvas === null || model === null) return;
    if (boxRef.current.width === 0 || boxRef.current.height === 0) return;
    model.settle(mood, VEX_BARS_STILL_S);
    paintVexBars(canvas, model, boxRef.current);
  }, [mood, still]);

  // The loop: never under the still frame, and only while the run gate is
  // open. The mood is read each frame, so a change eases in on the spring.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || still) return undefined;
    let raf = 0;
    let last: number | null = null;
    const frame = (now: number): void => {
      const model = modelRef.current;
      const box = boxRef.current;
      if (model !== null && box.width > 0 && box.height > 0) {
        const dt = last === null ? 0 : (now - last) / 1000;
        last = now;
        model.step(moodRef.current, now / 1000, dt);
        paintVexBars(canvas, model, box);
      }
      raf = requestAnimationFrame(frame);
    };
    const gate = new RunGate(canvas, (run) => {
      if (run) {
        last = null;
        raf = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(raf);
      }
    });
    return () => {
      gate.destroy();
      cancelAnimationFrame(raf);
    };
  }, [still]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-vex-area="vex-bars"
      data-vex-bars={mood}
      data-vex-bars-running={still ? "false" : "true"}
      className="vex-foot__bars"
    />
  );
}
