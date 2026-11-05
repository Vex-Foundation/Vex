/**
 * HER GLYPH FIELD (docs/design/H3-DESKTOP.md sections 1.5, 3.2 and 3.5; plan
 * row S4-17): the falling V, X and E on her blue ground, behind her figure.
 * A canvas the model (`kimm-field.ts`) is drawn into, bound four ways, the
 * named exception MOTION-POLICY.md gives it:
 *
 *   - IT RUNS ONLY WHILE HER SECTION IS OPEN (`running`): closed, the field
 *     holds its frame in the strip ("the field holds its frame", section
 *     3.2), and opening starts it again from that frame.
 *   - THE RUN GATE (`lib/motion/run-gate.ts`): only while the canvas is on
 *     screen and the window is shown; a hidden window, a column scrolled or
 *     folded away, or the inspect view over her paints no frame.
 *   - A FIXED STEP AND A CLOCK CAP: the model steps 10 times a second
 *     (`KIMM_FIELD_STEP_MS`), so a frame whose step has not come repaints
 *     nothing, and one frame never advances it more than
 *     `KIMM_FIELD_CLOCK_CAP_MS`, so a stalled window resumes where it
 *     stopped.
 *   - THE STILL FRAME (`lib/motion/use-still-frame.ts`): under reduced motion
 *     or Save-Data it paints one composed frame (`KIMM_FIELD_STILL_STEP`) and
 *     repaints only when its box changes.
 *
 * The glyphs take their colour from the canvas's own CSS `color` (ink, in
 * kimm.css), read once per paint, so no colour is spelled here. Decorative:
 * the canvas is `aria-hidden` and takes no pointer.
 */

import { useEffect, useRef, type JSX } from "react";
import { RunGate } from "../../../lib/motion/run-gate.js";
import { useStillFrame } from "../../../lib/motion/use-still-frame.js";
import {
  KIMM_FIELD_CELL,
  KIMM_FIELD_CLOCK_CAP_MS,
  KIMM_FIELD_STEP_MS,
  KIMM_FIELD_STILL_STEP,
  KimmFieldModel,
} from "./kimm-field.js";

export interface KimmFieldProps {
  /** Her section is open: the field runs; closed, it holds its frame. */
  readonly running: boolean;
}

/** Paint the model's glyphs into the canvas at its device pixel ratio. */
export function paintKimmField(canvas: HTMLCanvasElement, model: KimmFieldModel): boolean {
  const context = canvas.getContext("2d");
  if (context === null) return false;
  const ratio = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  // Her ink and the mono face, from the canvas's own computed style.
  const style = getComputedStyle(canvas);
  context.fillStyle = style.color;
  context.font = `${String(KIMM_FIELD_CELL.height - 6)}px ${style.fontFamily || "monospace"}`;
  context.textBaseline = "top";
  for (const glyph of model.glyphs()) {
    context.globalAlpha = glyph.alpha;
    context.fillText(
      glyph.glyph,
      glyph.column * KIMM_FIELD_CELL.width + 1,
      glyph.row * KIMM_FIELD_CELL.height + 3,
    );
  }
  context.globalAlpha = 1;
  return true;
}

export function KimmField({ running }: KimmFieldProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<KimmFieldModel | null>(null);
  const still = useStillFrame();

  // The model follows the canvas's box: a new box is a new field at the
  // same step, so a resize never jumps it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const fit = (): void => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const step = modelRef.current?.step ?? (still ? KIMM_FIELD_STILL_STEP : 0);
      const model = new KimmFieldModel(width, height);
      model.advance(step);
      modelRef.current = model;
      paintKimmField(canvas, model);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [still]);

  // The loop: only while running, never under the still frame, and only
  // while the run gate is open.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || !running || still) return undefined;
    let raf = 0;
    let last: number | null = null;
    let carry = 0;
    const frame = (now: number): void => {
      const model = modelRef.current;
      if (model !== null) {
        const elapsed = last === null ? 0 : Math.min(now - last, KIMM_FIELD_CLOCK_CAP_MS);
        last = now;
        carry += elapsed;
        const steps = Math.floor(carry / KIMM_FIELD_STEP_MS);
        if (steps > 0) {
          carry -= steps * KIMM_FIELD_STEP_MS;
          model.advance(steps);
          paintKimmField(canvas, model);
        }
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
  }, [running, still]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-vex-area="kimm-field"
      data-kimm-field-running={running && !still ? "true" : "false"}
      className="vex-kimm__field"
    />
  );
}
