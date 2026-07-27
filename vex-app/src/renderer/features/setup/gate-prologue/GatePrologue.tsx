/**
 * GATE PROLOGUE — the cinematic cold open, in the style of a studio ident.
 *
 * One full-window canvas stages three acts on the SAME particles the setup
 * gate's monogram is made of (`lib/sigil-sampler.ts` — one sampler, one
 * source of truth for the letterform shape):
 *
 *   I  FIELD (0–0.8s)     scattered across the whole window as a star field,
 *                         with one slow cobalt arc sweeping the screen.
 *   II GLOBE (0.8–2.2s)   the stars converge onto a slowly rotating sphere
 *                         (fibonacci lattice, orthographic projection).
 *   III SIGNATURE (2.2s+) the sphere breaks orbit onto the letterforms at
 *                         hero scale; a specular glint travels the mark.
 *   SETTLE                the mark shrinks into the VexLoader ring slot.
 *
 * THE HANDOFF, and why `children` never unmount: the real hold content
 * (VexLoader + VexSigil) is mounted underneath from the very first frame at
 * opacity 0. VexSigil therefore runs its own ~1.4s assembly DURING the
 * prologue and is already settled and shimmering when the settle crossfades
 * it in — without that, the handoff would show the mark dissolve and
 * re-assemble a second time at 200px. This component stays mounted around
 * the children for the rest of the gate's life (it becomes a plain wrapper
 * once finished) precisely so React never remounts and re-assembles them.
 *
 * Play policy lives in `prologue-policy.ts`, act boundaries in
 * `prologue-phases.ts`, sphere maths in `prologue-geometry.ts` — all plain
 * functions, all unit-tested. This file is only the renderer.
 *
 * Motion contract: rAF-driven canvas, devicePixelRatio capped at 1.5, a
 * seeded PRNG (never Math.random in a loop), draws batched to ONE path +
 * ONE fill per style bucket. `play="none"` (prefers-reduced-motion) renders
 * the children immediately at full opacity and starts no loop at all —
 * exactly the gate's pre-prologue contract. Any pointerdown or keydown skips
 * straight to that same state.
 *
 * CSP: zero inline style attributes — the crossfade is a single CSSOM
 * property assignment per frame (`element.style.opacity = …`), which
 * `MOTION-POLICY.md` documents as the allowed path under `style-src 'self'`.
 *
 * Failure contract: no canvas 2D, an image that fails to load, or an empty
 * sample → finish immediately and show the children. The gate then behaves
 * exactly as it did before the prologue existed.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import {
  DPR_CAP,
  buildSigilStyles,
  type SigilPalette,
} from "../../../lib/sigil-sampler.js";
import { rotateYProject } from "./prologue-geometry.js";
import {
  buildPrologueParticles,
  type PrologueParticles,
} from "./prologue-particles.js";
import {
  actProgress,
  holdOpacityAt,
  timelineFor,
  type PrologueTimeline,
} from "./prologue-phases.js";
import type { ProloguePlay } from "./prologue-policy.js";

/** The monogram sampled for the constellation shape. */
const SIGIL_SRC = "/logo_clean.png";

/** Globe radius as a fraction of viewport height (owner spec: ≈35vh). */
const GLOBE_RADIUS_VH = 0.35;
/** Globe rotation — one slow revolution per ~9s. */
const GLOBE_TURN_MS = 9000;
/** Hero mark width as a fraction of the viewport's smaller side. */
const HERO_MARK_FRACTION = 0.62;
/**
 * Fallback settle target when the real sigil box cannot be measured: the
 * VexLoader hero ring is 200px and insets its slot by 14%, so the mark lands
 * on a 144px box. The measured box (`readSettleSlot`) is preferred.
 */
const RING_MARK_PX = 200 * 0.72;
/** Half-width of the travelling specular band, in mark-normalised units. */
const GLINT_HALF_WIDTH = 0.16;

/** Style bucket offsets within a color (dim / base / bright). */
const ALPHA_DIM = 0;
const ALPHA_BASE = 1;
const ALPHA_BRIGHT = 2;
const ALPHA_STEPS = 3;

const easeOutQuint = (t: number): number => 1 - (1 - t) ** 5;
const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export interface GatePrologueProps {
  /** Which variant to play; `none` renders the children immediately. */
  readonly play: ProloguePlay;
  /** Canvas paint channels — the gate shares the sigil's palette. */
  readonly palette: SigilPalette;
  /** Fired once when the prologue finishes, is skipped, or cannot run. */
  readonly onFinished: () => void;
  /** The real gate hold content, mounted (invisible) from frame one. */
  readonly children: ReactNode;
}

export function GatePrologue({
  play,
  palette,
  onFinished,
  children,
}: GatePrologueProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const holdRef = useRef<HTMLDivElement | null>(null);
  const [finished, setFinished] = useState(play === "none");

  // Read once at mount, like VexSigil: this is a one-shot cold open, and a
  // prop change mid-flight is not a supported reset path.
  const playRef = useRef(play);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    const mode = playRef.current;
    const holdEl = holdRef.current;
    if (mode === "none") {
      if (holdEl !== null) holdEl.style.opacity = "1";
      onFinishedRef.current();
      return undefined;
    }

    const timeline: PrologueTimeline = timelineFor(mode);
    const styles = buildSigilStyles(paletteRef.current);
    const canvasEl = canvasRef.current;
    if (canvasEl === null) return undefined;
    // Re-declared with the narrowed type so the hoisted closures below see a
    // non-null canvas (narrowing does not flow into them) — the repo idiom.
    const canvas: HTMLCanvasElement = canvasEl;

    let ctx2d: CanvasRenderingContext2D | null = null;
    try {
      ctx2d = canvas.getContext("2d");
    } catch {
      ctx2d = null;
    }

    let disposed = false;
    let rafId: number | null = null;
    let particles: PrologueParticles | null = null;
    let startedAt = 0;
    let viewW = 1;
    let viewH = 1;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);

    /** Land on the finished state exactly once, from any path. */
    let done = false;
    function finish(): void {
      if (done) return;
      done = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const el = holdRef.current;
      if (el !== null) el.style.opacity = "1";
      setFinished(true);
      onFinishedRef.current();
    }

    if (ctx2d === null) {
      // No canvas 2D (jsdom, blocked context) — the gate falls back to the
      // plain hold content it always had.
      finish();
      return undefined;
    }
    const ctx: CanvasRenderingContext2D = ctx2d;

    function resize(): void {
      viewW = Math.max(1, window.innerWidth);
      viewH = Math.max(1, window.innerHeight);
      const w = Math.max(1, Math.floor(viewW * dpr));
      const h = Math.max(1, Math.floor(viewH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      // Resizing resets canvas state — re-pin the DPR transform so all
      // drawing below happens in CSS px.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Per-frame scratch buffers, sized once the particle count is known.
    // Cached across the whole loop so a frame never allocates.
    let scratchX = new Float32Array(0);
    let scratchY = new Float32Array(0);
    let scratchStyle = new Uint8Array(0);

    /**
     * Measure the real sigil box the settle must land on. `data-vex-sigil`
     * is VexSigil's own root attribute, so this reads the exact frame the
     * crossfade is about to reveal — no duplicated layout arithmetic, and it
     * self-corrects if the hold column's composition ever changes.
     */
    let settleSlot: { x: number; y: number; size: number } | null = null;
    let settleSlotMeasured = false;
    function readSettleSlot(): { x: number; y: number; size: number } | null {
      // Cached: getBoundingClientRect forces layout, and this must not run
      // once per frame. Invalidated on resize, which is the only thing that
      // moves the slot (the hold column's composition is static).
      if (settleSlotMeasured) return settleSlot;
      const host = holdRef.current;
      if (host === null) return null;
      const sigil = host.querySelector("[data-vex-sigil]");
      if (sigil === null) return null;
      const box = sigil.getBoundingClientRect();
      if (box.width <= 0) return null;
      settleSlotMeasured = true;
      settleSlot = {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        size: box.width,
      };
      return settleSlot;
    }

    /** Act I's eclipse rim: one slow cobalt arc crossing the screen. */
    function paintArc(t: number): void {
      // Fade in and back out across the act so it never pops.
      const alpha = Math.sin(Math.PI * t) * 0.5;
      if (alpha <= 0.01) return;
      const radius = Math.hypot(viewW, viewH) * 0.75;
      const cx = viewW * 0.5;
      const cy = viewH * 0.5 + radius * 0.82;
      const sweep = Math.PI * 0.34;
      // Travels left→right along the rim.
      const mid = -Math.PI / 2 + (t - 0.5) * Math.PI * 0.55;
      ctx.strokeStyle = `rgba(123,164,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, mid - sweep / 2, mid + sweep / 2);
      ctx.stroke();
    }

    /** One frame: resolve the act, place every particle, batch the fills. */
    function paint(elapsed: number): void {
      if (particles === null) return;
      const p = particles;
      const { act, t } = actProgress(timeline, elapsed);
      ctx.clearRect(0, 0, viewW, viewH);

      const cx = viewW / 2;
      const cy = viewH / 2;
      const globeR = viewH * GLOBE_RADIUS_VH;
      const heroMark = Math.min(viewW, viewH) * HERO_MARK_FRACTION;
      const angle = (elapsed / GLOBE_TURN_MS) * Math.PI * 2;

      // Where the mark must LAND: the real VexSigil's box inside the hold
      // content, measured rather than assumed. The hold column is a flex
      // stack (ring + status line), so its ring does NOT sit on the viewport
      // centre — settling to `cy` would visibly jog the mark at the
      // crossfade. Falls back to the nominal ring slot if the sigil is
      // absent (it always exists in the gate; the fallback keeps this
      // renderer honest when reused).
      const slot = readSettleSlot();
      const settleX = slot?.x ?? cx;
      const settleY = slot?.y ?? cy;
      const settleSize = slot?.size ?? RING_MARK_PX;

      // Mark geometry for this frame. `done` is held at the settled values —
      // reverting to hero size for the final frame would pop the mark back
      // to full size for ~16ms just before the canvas is torn down.
      const settleT =
        act === "settle" ? easeInOutCubic(t) : act === "done" ? 1 : 0;
      const markSize = heroMark + (settleSize - heroMark) * settleT;
      const markCx = cx + (settleX - cx) * settleT;
      const markCy = cy + (settleY - cy) * settleT;

      // Glint band centre, travelling the mark diagonally during the flight.
      const glintCentre = act === "signature" ? -1.2 + t * 2.4 : Number.NaN;

      // Positions are computed into these per-particle temporaries inside
      // the batching loop below; recomputing them per style bucket would be
      // 9× the maths, so they are cached once per frame.
      const px = scratchX;
      const py = scratchY;
      const pStyle = scratchStyle;

      for (let i = 0; i < p.count; i++) {
        const nx = p.normX[i] ?? 0;
        const ny = p.normY[i] ?? 0;
        const starPx = (p.starX[i] ?? 0) * viewW;
        const starPy = (p.starY[i] ?? 0) * viewH;
        const proj = rotateYProject(
          { x: p.sphX[i] ?? 0, y: p.sphY[i] ?? 0, z: p.sphZ[i] ?? 0 },
          angle,
        );
        const globePx = cx + proj.x * globeR;
        const globePy = cy + proj.y * globeR;
        const markPx = markCx + nx * markSize;
        const markPy = markCy + ny * markSize;

        let x: number;
        let y: number;
        let alphaIdx: number = ALPHA_BASE;

        if (act === "field") {
          // A slow outward drift keeps the field alive without motion noise.
          const drift = 1 + t * 0.04;
          x = cx + (starPx - cx) * drift;
          y = cy + (starPy - cy) * drift;
          alphaIdx = (i & 3) === 0 ? ALPHA_DIM : ALPHA_BASE;
        } else if (act === "globe") {
          const e = easeInOutCubic(t);
          x = starPx + (globePx - starPx) * e;
          y = starPy + (globePy - starPy) * e;
          // The far hemisphere dims — that is what reads as a solid body.
          alphaIdx = proj.depth < -0.15 ? ALPHA_DIM : ALPHA_BASE;
        } else if (act === "signature") {
          const d = p.delay[i] ?? 0;
          const local = (t - d) / (1 - d);
          const e = local <= 0 ? 0 : local >= 1 ? 1 : easeOutQuint(local);
          x = globePx + (markPx - globePx) * e;
          y = globePy + (markPy - globePy) * e;
          // Specular pass: brighten the particles the band is crossing.
          alphaIdx =
            Math.abs(nx + ny - glintCentre) < GLINT_HALF_WIDTH
              ? ALPHA_BRIGHT
              : ALPHA_BASE;
        } else {
          x = markPx;
          y = markPy;
        }

        px[i] = x;
        py[i] = y;
        pStyle[i] = (p.colorIdx[i] ?? 0) * ALPHA_STEPS + alphaIdx;
      }

      // Batched draw: ONE path + ONE fill per style bucket (≤9 per frame).
      for (const [s, style] of styles.entries()) {
        ctx.fillStyle = style;
        ctx.beginPath();
        let bucketHasRects = false;
        for (let i = 0; i < p.count; i++) {
          if (pStyle[i] !== s) continue;
          const size = p.sizePx[i] ?? 0;
          ctx.rect((px[i] ?? 0) - size / 2, (py[i] ?? 0) - size / 2, size, size);
          bucketHasRects = true;
        }
        if (bucketHasRects) ctx.fill();
      }

      if (act === "field") paintArc(t);
    }

    function tick(now: number): void {
      rafId = null;
      if (disposed || particles === null) return;
      const elapsed = now - startedAt;
      paint(elapsed);
      const el = holdRef.current;
      if (el !== null) {
        el.style.opacity = holdOpacityAt(timeline, elapsed).toFixed(3);
      }
      if (elapsed >= timeline.totalMs) {
        finish();
        return;
      }
      rafId = requestAnimationFrame(tick);
    }

    // Skip: any deliberate input jumps to the hold state. Window-level and
    // passive, so no focus contract on the page changes and nothing is
    // swallowed from the screens underneath.
    const onSkip = (): void => finish();
    window.addEventListener("pointerdown", onSkip, { passive: true });
    window.addEventListener("keydown", onSkip, { passive: true });

    const onResize = (): void => {
      if (disposed || done) return;
      settleSlotMeasured = false;
      settleSlot = null;
      resize();
    };
    window.addEventListener("resize", onResize);

    const image = new Image();
    image.onload = (): void => {
      if (disposed || done) return;
      const built = buildPrologueParticles(image);
      if (built === null) {
        finish();
        return;
      }
      particles = built;
      scratchX = new Float32Array(built.count);
      scratchY = new Float32Array(built.count);
      scratchStyle = new Uint8Array(built.count);
      resize();
      startedAt = performance.now();
      rafId = requestAnimationFrame(tick);
    };
    image.onerror = (): void => {
      if (disposed) return;
      finish();
    };
    image.src = SIGIL_SRC;

    return () => {
      disposed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      image.onload = null;
      image.onerror = null;
      window.removeEventListener("pointerdown", onSkip);
      window.removeEventListener("keydown", onSkip);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div
      data-vex-gate-prologue={finished ? "finished" : playRef.current}
      className="absolute inset-0"
    >
      {finished ? null : (
        <canvas
          ref={canvasRef}
          aria-hidden
          data-vex-prologue-canvas
          className="pointer-events-none absolute inset-0 block h-full w-full"
        />
      )}
      {/* The real hold content: mounted from frame one so its own assembly
          runs UNDER the prologue and is finished before the crossfade. */}
      <div
        ref={holdRef}
        data-vex-gate-hold
        className="absolute inset-0 flex flex-col items-center justify-center opacity-0"
      >
        {children}
      </div>
    </div>
  );
}
