/**
 * VEX SIGIL — the script monogram (/logo_clean.png) recreated as a particle
 * constellation on a canvas-2D stage. The hero's crown: on mount the mark
 * CONJURES itself — every particle flies in from a scattered ring and eases
 * onto its letterform target like ink settling into a signature.
 *
 * Pipeline:
 *   1. SAMPLE ONCE — the monogram is drawn to an offscreen canvas at a fixed
 *      ~220px working resolution (DPR-independent by construction) and its
 *      ImageData is read ONE time. Opaque pixels (alpha > 128) on a 2px grid
 *      become particle targets; the grid falls back to 1px for sparse art and
 *      dense results are stride-thinned so the count lands in the
 *      1500–3000 band.
 *   2. ASSEMBLE (one-shot) — each particle starts 40–120% of the mark's
 *      half-diagonal away from its target at a seeded-PRNG angle
 *      (deterministic from index — no Math.random in the loop) and eases home
 *      over ~1400ms with a per-particle stagger (≤500ms) on the landing Out
 *      curve (quintic: 1-(1-t)^5). rAF-driven; devicePixelRatio capped at 1.5;
 *      draws are batched — ONE path + ONE fill per color/alpha bucket.
 *   3. IDLE SHIMMER — after assembly a ~8fps interval (NOT a 60fps loop)
 *      flips ~1.5% of particles between dim (0.75) and bright (1.0) alpha
 *      each tick, so the signature barely breathes. Paused while
 *      document.hidden (visibilitychange), resumed on return.
 *
 * Look: 85% landing paper (#f3f4f7) at 0.9 alpha with 15% periwinkle sparks
 * (#8ba2ff / #7d92ff) — the white signature with cobalt life. The hex
 * literals below are JS canvas PAINT values (not Tailwind classes); none is
 * in the shell-design-guard ban list.
 *
 * Motion contract: prefers-reduced-motion → NO assembly, NO shimmer — the
 * fully-assembled mark is painted exactly once (matches the retired SignalSky's
 * full-stop posture). All drawing is JS on a canvas — zero inline style
 * attributes, zero new keyframes (CSP style-src 'self' safe).
 *
 * Failure contract: canvas 2D unavailable (jsdom), image load error, or an
 * empty sample → the plain <img src="/logo_clean.png"> renders inside the
 * SAME fixed aspect-square box, so the fallback causes no layout shift.
 *
 * Decorative only: aria-hidden root, pointer-events-none. Cleanup cancels
 * the rAF, the shimmer interval, image handlers, the visibility listener and
 * the ResizeObserver — StrictMode double-mount safe (everything is created
 * and torn down inside one effect).
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { cn } from "../../lib/utils.js";
import {
  ALPHA_LEVELS,
  BASE_ALPHA_IDX,
  DEFAULT_SIGIL_PALETTE,
  DPR_CAP,
  buildSigilStyles,
  mulberry32,
  sampleSigilTargets,
  type SigilPalette,
} from "../../lib/sigil-sampler.js";

/** Default source: the VEX script monogram (square PNG). */
const SIGIL_SRC = "/logo_clean.png";

/** Per-particle flight time on the landing Out curve. */
const ASSEMBLE_MS = 1400;
/** Max per-particle stagger — delay = hash(index) * 500ms. */
const STAGGER_MS = 500;
/** Idle shimmer ticker ≈ 8fps — deliberately NOT a rAF loop. */
const SHIMMER_TICK_MS = 120;
/** Fraction of particles whose alpha flips per shimmer tick (~1.5%). */
const SHIMMER_FRACTION = 0.015;
/** Seed for the one-time particle PRNG ("VEXS"). */
const SIGIL_SEED = 0x56455853;

/* The sampling pipeline, the palette vocabulary and the PRNG now live in
 * `lib/sigil-sampler.ts` — the setup gate's cinematic prologue assembles the
 * SAME monogram and must read the same letterform targets. Re-exported here
 * so this component's long-standing public API is unchanged. */
export { DEFAULT_SIGIL_PALETTE, type SigilPalette };

/** Particle store — parallel typed arrays; positions in SAMPLE space. */
interface SigilParticles {
  readonly count: number;
  /** Sample-space dimensions (cover-fit into the box at draw time). */
  readonly width: number;
  readonly height: number;
  readonly targetX: Float32Array;
  readonly targetY: Float32Array;
  readonly startX: Float32Array;
  readonly startY: Float32Array;
  readonly delayMs: Float32Array;
  readonly sizePx: Float32Array;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly colorIdx: Uint8Array;
  readonly styleIdx: Uint8Array;
}

/**
 * ONE-time sampling: rasterize the loaded monogram at the working
 * resolution, read ImageData once, and derive every per-particle constant
 * (target, scattered start, stagger, size, color) from the seeded PRNG in
 * index order. Returns null when sampling is impossible (no 2D context,
 * unreadable pixels, empty mark) — the caller falls back to the plain <img>.
 */
function buildParticles(image: HTMLImageElement): SigilParticles | null {
  const sample = sampleSigilTargets(image);
  if (sample === null) return null;
  const { width: sampleW, height: sampleH, count, coords } = sample;

  const prng = mulberry32(SIGIL_SEED);
  const targetX = new Float32Array(count);
  const targetY = new Float32Array(count);
  const startX = new Float32Array(count);
  const startY = new Float32Array(count);
  const delayMs = new Float32Array(count);
  const sizePx = new Float32Array(count);
  const posX = new Float32Array(count);
  const posY = new Float32Array(count);
  const colorIdx = new Uint8Array(count);
  const styleIdx = new Uint8Array(count);

  /** Scatter reference: the mark's half-diagonal. */
  const scatterRadius = 0.5 * Math.hypot(sampleW, sampleH);
  for (let i = 0; i < count; i++) {
    const tx = coords[i * 2] ?? 0;
    const ty = coords[i * 2 + 1] ?? 0;
    targetX[i] = tx;
    targetY[i] = ty;
    // Scattered start: seeded angle, 40–120% of the half-diagonal beyond
    // the target. Deterministic from index (PRNG stream in index order).
    const angle = prng() * Math.PI * 2;
    const dist = (0.4 + prng() * 0.8) * scatterRadius;
    const sx = tx + Math.cos(angle) * dist;
    const sy = ty + Math.sin(angle) * dist;
    startX[i] = sx;
    startY[i] = sy;
    posX[i] = sx;
    posY[i] = sy;
    delayMs[i] = prng() * STAGGER_MS;
    sizePx[i] = 1.6 + prng() * 0.6;
    const roll = prng();
    // 85% paper, 15% periwinkle sparks split across the two spark tones.
    const color = roll < 0.85 ? 0 : roll < 0.925 ? 1 : 2;
    colorIdx[i] = color;
    styleIdx[i] = color * ALPHA_LEVELS.length + BASE_ALPHA_IDX;
  }

  return {
    count,
    width: sampleW,
    height: sampleH,
    targetX,
    targetY,
    startX,
    startY,
    delayMs,
    sizePx,
    posX,
    posY,
    colorIdx,
    styleIdx,
  };
}

export interface VexSigilProps {
  /** Sizing hook — height-driven (e.g. "h-28 md:h-32"); the box keeps the
   * monogram's square aspect so canvas and <img> fallback occupy the same
   * fixed frame (no layout shift). */
  readonly className?: string;
  /** Image sampled for the constellation SHAPE (alpha mask only — colors come
   * from `palette`). Defaults to the VEX monogram. */
  readonly src?: string;
  /** Body + two spark channels. Defaults to the VEX cobalt palette. */
  readonly palette?: SigilPalette;
}

export function VexSigil({
  className,
  src = SIGIL_SRC,
  palette = DEFAULT_SIGIL_PALETTE,
}: VexSigilProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  // `src`/`palette` are read ONCE at mount (inside the effect). A theme flip
  // REMOUNTS this component via a `key` on the parent, so these refs always
  // hold the current mount's values — they are DELIBERATELY not effect deps:
  // the assembly is a static-source, empty-dep one-shot (VexSigil.test.tsx
  // pins the single mount-time rAF kickoff), and prop mutation without a
  // remount is not a supported reset path.
  const srcRef = useRef(src);
  srcRef.current = src;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  useEffect(() => {
    const styles = buildSigilStyles(paletteRef.current);
    const canvasEl = canvasRef.current;
    if (canvasEl === null) return undefined;
    // Re-declared with the narrowed type so the hoisted closures below see a
    // non-null canvas (narrowing does not flow into them) — the repo canvas idiom.
    const canvas: HTMLCanvasElement = canvasEl;

    // jsdom returns null (logging "not implemented"); some environments
    // throw. Both → the plain <img> fallback.
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
    let shimmerId: number | null = null;
    let assembled = false;
    let assembleStart = 0;
    let particles: SigilParticles | null = null;
    let shimmerPrng: (() => number) | null = null;
    /** Indices flipped by the last shimmer tick (reverted on the next). */
    let flipped: number[] = [];
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
        // Cover-fit, centered: the sampled mark fills the component box.
        scale = Math.max(boxW / particles.width, boxH / particles.height);
        offsetX = (boxW - particles.width * scale) / 2;
        offsetY = (boxH - particles.height * scale) / 2;
      }
    }

    /** Paint the current particle positions — batched: ONE path + ONE fill
     * per style bucket (color × alpha level; ≤9 fills per frame). */
    function paintFrame(): void {
      if (particles === null) return;
      const p = particles;
      ctx.clearRect(0, 0, boxW, boxH);
      for (const [s, style] of styles.entries()) {
        ctx.fillStyle = style;
        ctx.beginPath();
        let bucketHasRects = false;
        for (let i = 0; i < p.count; i++) {
          if (p.styleIdx[i] !== s) continue;
          const size = p.sizePx[i] ?? 0;
          ctx.rect(
            offsetX + (p.posX[i] ?? 0) * scale - size / 2,
            offsetY + (p.posY[i] ?? 0) * scale - size / 2,
            size,
            size,
          );
          bucketHasRects = true;
        }
        if (bucketHasRects) ctx.fill();
      }
    }

    /** One-shot assembly frame: ease every particle toward its target on
     * the landing Out curve; when the last one lands, the exact final frame
     * is already painted and the idle shimmer takes over. */
    function tickAssembly(now: number): void {
      rafId = null;
      if (disposed || particles === null) return;
      const p = particles;
      const elapsed = now - assembleStart;
      let done = true;
      for (let i = 0; i < p.count; i++) {
        const t = (elapsed - (p.delayMs[i] ?? 0)) / ASSEMBLE_MS;
        const tx = p.targetX[i] ?? 0;
        const ty = p.targetY[i] ?? 0;
        if (t >= 1) {
          p.posX[i] = tx;
          p.posY[i] = ty;
          continue;
        }
        done = false;
        const sx = p.startX[i] ?? 0;
        const sy = p.startY[i] ?? 0;
        if (t <= 0) {
          p.posX[i] = sx;
          p.posY[i] = sy;
          continue;
        }
        // easeOutQuint — the landing Out curve.
        const eased = 1 - (1 - t) ** 5;
        p.posX[i] = sx + (tx - sx) * eased;
        p.posY[i] = sy + (ty - sy) * eased;
      }
      paintFrame();
      if (done) {
        assembled = true;
        startShimmer();
        return;
      }
      rafId = requestAnimationFrame(tickAssembly);
    }

    /** Idle tick (~8fps): revert last tick's flips to base alpha, flip a
     * fresh ~1.5% between dim (0.75) and bright (1.0), repaint. */
    function shimmerTick(): void {
      if (disposed || particles === null || shimmerPrng === null) return;
      const p = particles;
      const rand = shimmerPrng;
      for (const i of flipped) {
        p.styleIdx[i] =
          (p.colorIdx[i] ?? 0) * ALPHA_LEVELS.length + BASE_ALPHA_IDX;
      }
      flipped = [];
      const flips = Math.max(1, Math.round(p.count * SHIMMER_FRACTION));
      for (let k = 0; k < flips; k++) {
        const i = Math.floor(rand() * p.count);
        p.styleIdx[i] =
          (p.colorIdx[i] ?? 0) * ALPHA_LEVELS.length + (rand() < 0.5 ? 0 : 2);
        flipped.push(i);
      }
      paintFrame();
    }

    function startShimmer(): void {
      if (disposed || !assembled || shimmerId !== null || document.hidden) {
        return;
      }
      shimmerId = window.setInterval(shimmerTick, SHIMMER_TICK_MS);
    }

    function stopShimmer(): void {
      if (shimmerId !== null) {
        window.clearInterval(shimmerId);
        shimmerId = null;
      }
    }

    /** Visibility gate for the shimmer ticker — a hidden window burns zero
     * timers. (The assembly rAF is throttled by the browser on its own.) */
    const onVisibilityChange = (): void => {
      if (document.hidden) stopShimmer();
      else startShimmer();
    };

    const image = new Image();
    const handleLoad = (): void => {
      if (disposed) return;
      const built = buildParticles(image);
      if (built === null) {
        setFailed(true);
        return;
      }
      particles = built;
      resize();
      if (reducedMotion) {
        // FULL STOP: no assembly, no shimmer — the fully-assembled mark,
        // painted exactly once.
        built.posX.set(built.targetX);
        built.posY.set(built.targetY);
        paintFrame();
        return;
      }
      shimmerPrng = mulberry32(SIGIL_SEED ^ 0x9e3779b9);
      assembleStart = performance.now();
      rafId = requestAnimationFrame(tickAssembly);
    };
    const handleError = (): void => {
      if (disposed) return;
      setFailed(true);
    };
    image.onload = handleLoad;
    image.onerror = handleError;
    image.src = srcRef.current;

    if (!reducedMotion) {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    // jsdom lacks ResizeObserver — the current frame simply stays (same
    // guard as the retired SignalSky). A running assembly repaints at the new size on
    // its next rAF; static/idle frames repaint here.
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
      stopShimmer();
      image.onload = null;
      image.onerror = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver?.disconnect();
    };
  }, []);

  return (
    <div
      aria-hidden
      data-vex-sigil
      className={cn(
        // aspect-square = the monogram's own aspect (the source PNG is
        // square); one fixed box for both canvas and fallback.
        "pointer-events-none relative aspect-square select-none",
        className,
      )}
    >
      {failed ? (
        <img
          src={src}
          alt=""
          aria-hidden
          data-vex-sigil-fallback
          className="block h-full w-full object-contain opacity-95"
        />
      ) : (
        <canvas
          ref={canvasRef}
          data-vex-sigil-canvas
          className="block h-full w-full"
        />
      )}
    </div>
  );
}
