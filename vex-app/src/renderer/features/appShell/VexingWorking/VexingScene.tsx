/**
 * VEXING SCENE — the VEX monogram assembling from particles, holding, and
 * dispersing, on a loop, for as long as the turn has produced nothing to read.
 *
 * A THIRD choreography over `lib/sigil-sampler.ts`, not a new letterform and
 * not an extension of `VexSigil` (453 lines, three live consumers, and a
 * one-shot assembly is a different reason to change). The canvas idiom below is
 * the repo's proven one, copied deliberately: sample once, batch the draw into
 * ONE path + ONE fill per style bucket, cap devicePixelRatio, and create and
 * tear down everything inside a single empty-dep effect so a StrictMode
 * double-mount is safe.
 *
 * MOTION CONTRACT
 *  - `prefers-reduced-motion` → the assembled mark is painted exactly ONCE.
 *    No loop, no animation timer, no listeners. (The caption's elapsed counter
 *    keeps its own 1s interval — a counter that stops counting is a lie.)
 *  - `document.hidden` → the frame is cancelled and the loop's elapsed offset
 *    is banked, so returning resumes MID-PHASE instead of snapping to a fresh
 *    assembly. This loop never ends on its own, so unlike VexSigil's one-shot
 *    it cannot be left to the browser's own throttling.
 *  - Nothing here writes an inline style attribute or injects a stylesheet:
 *    all drawing is JS on a canvas (CSP `style-src 'self'` safe).
 *
 * FAILURE CONTRACT: no 2D context (the jsdom case), an image error, or an
 * empty sample → the plain <img src="/logo_clean.png"> renders inside the SAME
 * fixed square box, so the fallback causes no layout shift.
 *
 * Decorative only: aria-hidden + pointer-events-none. The caption and the
 * counter beside it carry the meaning.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { cn } from "../../../lib/utils.js";
import {
  ALPHA_LEVELS,
  BASE_ALPHA_IDX,
  DEFAULT_SIGIL_PALETTE,
  buildSigilStyles,
} from "../../../lib/sigil-sampler.js";
import {
  DPR_CAP,
  STAGGER_FRACTION,
  buildVexingParticles,
  type VexingParticles,
} from "./particles.js";
import { VEXING_CYCLE, phaseAt, type VexingPhase } from "./phases.js";

/** The VEX script monogram (square PNG) — the same mark everywhere. */
const SIGIL_SRC = "/logo_clean.png";

/** Per-particle progress inside an act, once its stagger has been spent. */
function stagger(t: number, delay: number): number {
  const start = delay * STAGGER_FRACTION;
  const span = 1 - STAGGER_FRACTION;
  const local = (t - start) / span;
  return local <= 0 ? 0 : local >= 1 ? 1 : local;
}

export interface VexingSceneProps {
  /** Height-driven box (e.g. "h-40"); the mark keeps its square aspect. */
  readonly className?: string;
}

export function VexingScene({ className }: VexingSceneProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const styles = buildSigilStyles(DEFAULT_SIGIL_PALETTE);
    const canvasEl = canvasRef.current;
    if (canvasEl === null) return undefined;
    // Re-declared with the narrowed type so the hoisted closures below see a
    // non-null canvas — the repo canvas idiom.
    const canvas: HTMLCanvasElement = canvasEl;

    let ctx2d: CanvasRenderingContext2D | null = null;
    try {
      ctx2d = canvas.getContext("2d");
    } catch {
      ctx2d = null;
    }
    if (ctx2d === null) {
      setFailed(true);
      return undefined;
    }
    const ctx: CanvasRenderingContext2D = ctx2d;

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let disposed = false;
    let rafId: number | null = null;
    let particles: VexingParticles | null = null;
    /** Scratch positions — sized once, never reallocated per frame. */
    let posX: Float32Array | null = null;
    let posY: Float32Array | null = null;
    /** Loop origin; rebased on resume so a hidden window costs no phase. */
    let loopStart = 0;
    let bankedElapsedMs = 0;
    let lastPaintedPhase: VexingPhase | null = null;
    // Cover-fit transform (sample space → CSS px), recomputed on resize.
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let boxW = 0;
    let boxH = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);

    function resize(): void {
      boxW = Math.max(1, canvas.clientWidth);
      boxH = Math.max(1, canvas.clientHeight);
      const w = Math.max(1, Math.floor(boxW * dpr));
      const h = Math.max(1, Math.floor(boxH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      // Resizing resets canvas state — re-pin the DPR transform so all
      // drawing below happens in CSS px.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (particles !== null) {
        scale = Math.max(boxW / particles.width, boxH / particles.height);
        offsetX = (boxW - particles.width * scale) / 2;
        offsetY = (boxH - particles.height * scale) / 2;
      }
    }

    /** Batched paint: ONE path + ONE fill per style bucket (≤9 per frame). */
    function paintFrame(): void {
      if (particles === null || posX === null || posY === null) return;
      const p = particles;
      const x = posX;
      const y = posY;
      ctx.clearRect(0, 0, boxW, boxH);
      for (const [s, style] of styles.entries()) {
        ctx.fillStyle = style;
        ctx.beginPath();
        let bucketHasRects = false;
        for (let i = 0; i < p.count; i++) {
          if ((p.colorIdx[i] ?? 0) * ALPHA_LEVELS.length + BASE_ALPHA_IDX !== s) {
            continue;
          }
          const size = p.sizePx[i] ?? 0;
          ctx.rect(
            offsetX + (x[i] ?? 0) * scale - size / 2,
            offsetY + (y[i] ?? 0) * scale - size / 2,
            size,
            size,
          );
          bucketHasRects = true;
        }
        if (bucketHasRects) ctx.fill();
      }
    }

    /** Settle every particle onto its letterform target. */
    function seatAtTarget(): void {
      if (particles === null || posX === null || posY === null) return;
      posX.set(particles.targetX);
      posY.set(particles.targetY);
    }

    function tickFrame(now: number): void {
      rafId = null;
      if (disposed || particles === null || posX === null || posY === null) {
        return;
      }
      const p = particles;
      const x = posX;
      const y = posY;
      const frame = phaseAt(VEXING_CYCLE, now - loopStart);

      if (frame.phase === "hold" || frame.phase === "gap") {
        // Nothing moves in these acts: seat once on entry, then let the last
        // painted frame stand rather than repainting an identical field.
        if (lastPaintedPhase !== frame.phase) {
          if (frame.phase === "hold") seatAtTarget();
          else {
            x.set(p.outX);
            y.set(p.outY);
          }
          paintFrame();
          lastPaintedPhase = frame.phase;
        }
      } else {
        const assembling = frame.phase === "assemble";
        for (let i = 0; i < p.count; i++) {
          const tx = p.targetX[i] ?? 0;
          const ty = p.targetY[i] ?? 0;
          const ox = p.outX[i] ?? 0;
          const oy = p.outY[i] ?? 0;
          const delay = p.delay[i] ?? 0;
          if (assembling) {
            // easeOutQuint — the landing Out curve VexSigil arrives on.
            const local = stagger(frame.t, delay);
            const eased = 1 - (1 - local) ** 5;
            x[i] = ox + (tx - ox) * eased;
            y[i] = oy + (ty - oy) * eased;
          } else {
            // easeInQuint, with the stagger reversed so the mark comes apart
            // from the other end than it came together.
            const local = stagger(frame.t, 1 - delay);
            const eased = local ** 5;
            x[i] = tx + (ox - tx) * eased;
            y[i] = ty + (oy - ty) * eased;
          }
        }
        paintFrame();
        lastPaintedPhase = frame.phase;
      }
      rafId = requestAnimationFrame(tickFrame);
    }

    function startLoop(): void {
      if (disposed || particles === null || rafId !== null || document.hidden) {
        return;
      }
      loopStart = performance.now() - bankedElapsedMs;
      rafId = requestAnimationFrame(tickFrame);
    }

    function stopLoop(): void {
      if (rafId === null) return;
      cancelAnimationFrame(rafId);
      rafId = null;
      bankedElapsedMs = performance.now() - loopStart;
    }

    /** A hidden window burns zero frames; returning resumes mid-phase. */
    const onVisibilityChange = (): void => {
      if (document.hidden) stopLoop();
      else startLoop();
    };

    const image = new Image();
    const handleLoad = (): void => {
      if (disposed) return;
      const built = buildVexingParticles(image);
      if (built === null) {
        setFailed(true);
        return;
      }
      particles = built;
      posX = new Float32Array(built.count);
      posY = new Float32Array(built.count);
      resize();
      if (reducedMotion) {
        // FULL STOP: the assembled mark, painted exactly once.
        seatAtTarget();
        paintFrame();
        return;
      }
      posX.set(built.outX);
      posY.set(built.outY);
      startLoop();
    };
    const handleError = (): void => {
      if (disposed) return;
      setFailed(true);
    };
    image.onload = handleLoad;
    image.onerror = handleError;
    image.src = SIGIL_SRC;

    if (!reducedMotion) {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    // jsdom lacks ResizeObserver — the current frame simply stays.
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (disposed || particles === null) return;
        resize();
        if (rafId === null) paintFrame();
      });
      resizeObserver.observe(canvas);
    }

    return () => {
      disposed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      image.onload = null;
      image.onerror = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver?.disconnect();
    };
  }, []);

  return (
    <div
      aria-hidden
      data-vex-vexing-scene
      className={cn(
        // aspect-square = the monogram's own aspect; one fixed box for both
        // the canvas and the fallback.
        "pointer-events-none relative aspect-square select-none",
        className,
      )}
    >
      {failed ? (
        <img
          src={SIGIL_SRC}
          alt=""
          aria-hidden
          data-vex-vexing-fallback
          className="block h-full w-full object-contain opacity-95"
        />
      ) : (
        <canvas
          ref={canvasRef}
          data-vex-vexing-canvas
          className="block h-full w-full"
        />
      )}
    </div>
  );
}
