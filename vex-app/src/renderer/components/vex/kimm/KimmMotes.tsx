/**
 * THE LOCK SCREEN'S LIGHT MOTES (owner decision 2026-11-15; `kimm-motes.ts` for the model; MOTION-POLICY.md "The
 * lock screen's lively Kimm"): a few soft points of light rising behind her figure, over her glyph field, on one 2D
 * canvas drawn by our own code.
 *
 *   - Mounted only while `active`: the lock screen's panel passes it while her live figure stands there, so under
 *     reduced motion, Save-Data, a closed device or GPU gate, a failed load, or in the Vex card, there is no canvas
 *     at all.
 *   - THE RUN GATE (`lib/motion/run-gate.ts`): it draws only while on screen in a shown window; a hidden or
 *     minimised window stops it at once, as it stops her.
 *   - At most 30 redraws a second (`KIMM_MOTES.fps`), each step clamped, at most twice the CSS pixel.
 *
 * Decorative: `aria-hidden`, and the canvas takes no pointer.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { RunGate } from "../../../lib/motion/run-gate.js";
import { createMotes, KIMM_MOTES, moteFrameDue, motePose, stepMotes } from "./kimm-motes.js";

export interface KimmMotesProps {
  /** Her live figure stands on the lock screen: the motes exist. */
  readonly active: boolean;
  /** Their pace: 1 by day, slower at night or while she is sleepy (`KIMM_MOTES.pace`). */
  readonly speed?: number;
}

export function KimmMotes({ active, speed = 1 }: KimmMotesProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || canvas === null) return undefined;
    const gate = new RunGate(canvas, setOnScreen);
    return () => gate.destroy();
  }, [active]);

  const running = active && onScreen;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!running || canvas === null) return undefined;
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    const motes = createMotes();
    let raf = 0;
    let last = 0;
    let stepped = 0;
    let clock = 0;
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (!moteFrameDue(now, last)) return;
      last = now;
      const dt = (stepped === 0 ? 0 : (now - stepped) / 1000) * speedRef.current;
      stepped = now;
      clock += Math.min(0.1, dt);
      stepMotes(motes, dt);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const t = clock;
      for (const m of motes) {
        const pose = motePose(m, t, width, height);
        if (pose.alpha <= 0.005) continue;
        const glow = context.createRadialGradient(pose.x, pose.y, 0, pose.x, pose.y, m.r * 4);
        glow.addColorStop(0, m.color);
        // the same colour at no alpha, so the edge never greys toward black
        glow.addColorStop(1, `${m.color}00`);
        context.globalAlpha = pose.alpha;
        context.fillStyle = glow;
        context.beginPath();
        context.arc(pose.x, pose.y, m.r * 4, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-vex-area="kimm-motes"
      data-kimm-motes-running={running ? "true" : "false"}
      data-kimm-motes-fps={KIMM_MOTES.fps}
      data-kimm-motes-speed={speed}
      className="vex-kimm-panel__motes"
    />
  );
}
