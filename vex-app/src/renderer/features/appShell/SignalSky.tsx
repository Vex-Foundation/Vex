/**
 * SIGNAL SKY — the landing page's procedural WebGL dither sky, mounted as
 * the shell's z-0 background layer (phase 5). No imagery: the whole scene is
 * generated in-shader (see signalSkyShaders.ts), so the WOW is pure signal.
 *
 * Layer contract: fills its parent absolutely at z-0; the shell's columns sit
 * above it (center section carries `relative z-10`, the two glass rails carry
 * their own stacking contexts and blur this canvas as their backdrop).
 * Decorative only — aria-hidden, pointer-events-none.
 *
 * Perf contract:
 *   - ONE WebGL context, ONE program, ONE fullscreen-triangle buffer, all
 *     created at mount; per-frame work is uniforms + drawArrays only — no
 *     allocations, no state re-binds, no layout reads (resize goes through
 *     ResizeObserver, never per-frame clientWidth polling).
 *   - devicePixelRatio capped at 1.5 (the landing engine's value).
 *   - The rAF loop PAUSES while document.visibilityState is hidden and
 *     resumes on visibilitychange — a hidden window burns zero frames.
 *
 * Motion contract: the loop is the sanctioned "ambient stage" exception
 * (like DitherHero before it) and is gated hard — under
 * prefers-reduced-motion there is NO loop at all: exactly one static frame
 * is drawn (and re-drawn once per intensity/resize change).
 *
 * Intensity: the `intensity` prop (0..1) scales the animated cloud/fleck
 * terms — 1 on the welcome stage, ~0.35 dimmed behind an active session.
 * The uniform eases toward the prop inside the render loop (~600ms for a
 * full sweep), so welcome ⇄ session switches breathe instead of snapping.
 *
 * Failure: WebGL unavailable (jsdom, blocklisted GPU) or shader compile/link
 * failure → the canvas unmounts and a static CSS radial-gradient fallback div
 * renders in its place (accent-deep 12% mix at top-center → transparent).
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  SKY_ACCENTS,
  SKY_FRAGMENT_SHADER,
  SKY_VERTEX_SHADER,
  type RgbTriplet,
  type SkyTheme,
} from "./signalSkyShaders.js";

/** Landing engine caps devicePixelRatio at 1.5 (perf over retina crispness). */
const DPR_CAP = 1.5;
/** Duration of a full 0→1 intensity sweep (and a full accent-channel swing);
 * smaller deltas finish proportionally sooner (linear approach — allocation-
 * free in the loop). Shared so an intensity dim and a theme flip breathe at
 * the same cadence. */
const INTENSITY_TRANSITION_MS = 600;

export interface SignalSkyProps {
  /** Cloud/spark strength 0..1 — 1 (default) on the welcome stage, ~0.35
   * dimmed behind an active session. Out-of-range values are clamped. */
  readonly intensity?: number;
  /** Accent theme for the sky's signal flecks (u_deep / u_bright). `vex`
   * (default) = cobalt; `robinhood` = neon lime. The color eases toward the
   * prop in the loop, so a theme flip crossfades rather than snaps. */
  readonly theme?: SkyTheme;
}

function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** Linear one-channel approach toward `target`, clamped so it lands exactly. */
function approach(current: number, target: number, step: number): number {
  if (current === target) return current;
  return current < target
    ? Math.min(target, current + step)
    : Math.max(target, current - step);
}

/** Ease an RGB triplet in place toward `target` by one `step` (per channel). */
function easeTriplet(
  cur: [number, number, number],
  target: RgbTriplet,
  step: number,
): void {
  cur[0] = approach(cur[0], target[0], step);
  cur[1] = approach(cur[1], target[1], step);
  cur[2] = approach(cur[2], target[2], step);
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    console.warn("SignalSky: shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

interface SkyScene {
  readonly program: WebGLProgram;
  readonly buffer: WebGLBuffer;
  readonly uRes: WebGLUniformLocation | null;
  readonly uTime: WebGLUniformLocation | null;
  readonly uIntensity: WebGLUniformLocation | null;
  readonly uInk: WebGLUniformLocation | null;
  readonly uSoft: WebGLUniformLocation | null;
  readonly uDeep: WebGLUniformLocation | null;
  readonly uBright: WebGLUniformLocation | null;
}

/** Compile + link the sky program and leave it fully bound (program in use,
 * triangle buffer bound, attrib pointer set) — the draw loop never has to
 * re-bind anything. Returns null (with everything created so far released)
 * on any GL failure. */
function buildSkyScene(gl: WebGLRenderingContext): SkyScene | null {
  const vert = compileShader(gl, gl.VERTEX_SHADER, SKY_VERTEX_SHADER);
  if (vert === null) return null;
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, SKY_FRAGMENT_SHADER);
  if (frag === null) {
    gl.deleteShader(vert);
    return null;
  }
  const program = gl.createProgram();
  if (program === null) {
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return null;
  }
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  // The linked program owns the shaders now; flagging them for deletion here
  // means deleteProgram() later releases everything in one call.
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    console.warn("SignalSky: program link failed:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  if (buffer === null) {
    gl.deleteProgram(program);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // ONE oversized triangle covering the viewport — the only geometry, and the
  // only typed-array allocation, both at setup time.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const attrib = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(attrib);
  gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0);

  return {
    program,
    buffer,
    uRes: gl.getUniformLocation(program, "u_res"),
    uTime: gl.getUniformLocation(program, "u_time"),
    uIntensity: gl.getUniformLocation(program, "u_intensity"),
    uInk: gl.getUniformLocation(program, "u_ink"),
    uSoft: gl.getUniformLocation(program, "u_soft"),
    uDeep: gl.getUniformLocation(program, "u_deep"),
    uBright: gl.getUniformLocation(program, "u_bright"),
  };
}

export function SignalSky({
  intensity = 1,
  theme = "vex",
}: SignalSkyProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  /** Ease target — the clamped prop; read by the rAF loop every frame. */
  const targetRef = useRef(clampIntensity(intensity));
  /** Accent ease target — the theme's { deep, bright } pair; read every frame. */
  const accentRef = useRef(SKY_ACCENTS[theme]);
  /** Static repaint hook — non-null ONLY in reduced-motion mode, where there
   * is no loop to pick a new intensity/accent target up. */
  const staticRedrawRef = useRef<(() => void) | null>(null);

  // Declared BEFORE the GL setup effect so the mount-order is: targets synced
  // first, then exactly ONE first frame from the setup effect (the redraw
  // hook is still null on mount).
  useEffect(() => {
    targetRef.current = clampIntensity(intensity);
    staticRedrawRef.current?.();
  }, [intensity]);

  useEffect(() => {
    accentRef.current = SKY_ACCENTS[theme];
    staticRedrawRef.current?.();
  }, [theme]);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (canvasEl === null) return undefined;
    // Re-declared with the narrowed type so the hoisted closures below see a
    // non-null canvas (narrowing does not flow into them).
    const canvas: HTMLCanvasElement = canvasEl;

    // jsdom returns null (logging "not implemented"); some environments
    // throw. Both → graceful fallback. "experimental-webgl" is not probed:
    // Electron's Chromium always speaks plain "webgl".
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl");
    } catch {
      gl = null;
    }
    if (gl === null) {
      setFailed(true);
      return undefined;
    }
    const builtScene = buildSkyScene(gl);
    if (builtScene === null) {
      setFailed(true);
      return undefined;
    }
    // Re-declared with narrowed types so the hoisted closures below see
    // non-null values (post-declaration narrowing does not flow into them).
    const scene: SkyScene = builtScene;
    const ctx: WebGLRenderingContext = gl;

    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let disposed = false;
    let rafId: number | null = null;
    let lastNow = 0;
    /** Eased intensity actually written to the uniform each frame. */
    let current = targetRef.current;
    /** Eased palette channels chased toward accentRef each frame (theme flip).
     * All FOUR bands ease so a navy→bottle-green flip morphs the whole scene. */
    const startAccent = accentRef.current;
    const curInk: [number, number, number] = [
      startAccent.ink[0],
      startAccent.ink[1],
      startAccent.ink[2],
    ];
    const curSoft: [number, number, number] = [
      startAccent.soft[0],
      startAccent.soft[1],
      startAccent.soft[2],
    ];
    const curDeep: [number, number, number] = [
      startAccent.deep[0],
      startAccent.deep[1],
      startAccent.deep[2],
    ];
    const curBright: [number, number, number] = [
      startAccent.bright[0],
      startAccent.bright[1],
      startAccent.bright[2],
    ];
    const started = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);

    function resize(): void {
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.viewport(0, 0, w, h);
      }
    }

    /** Paint one frame. Uniforms + drawArrays only — no allocations, no
     * re-binds (buildSkyScene left program/buffer/attrib bound for good). */
    function drawFrame(timeSec: number): void {
      ctx.uniform2f(scene.uRes, canvas.width, canvas.height);
      ctx.uniform1f(scene.uTime, timeSec);
      ctx.uniform1f(scene.uIntensity, current);
      ctx.uniform3f(scene.uInk, curInk[0], curInk[1], curInk[2]);
      ctx.uniform3f(scene.uSoft, curSoft[0], curSoft[1], curSoft[2]);
      ctx.uniform3f(scene.uDeep, curDeep[0], curDeep[1], curDeep[2]);
      ctx.uniform3f(scene.uBright, curBright[0], curBright[1], curBright[2]);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    }

    function tick(now: number): void {
      if (disposed) return;
      // Linear approach toward the props: a full swing takes
      // INTENSITY_TRANSITION_MS; clamped so intensity and each accent channel
      // land exactly on target.
      const step = (now - lastNow) / INTENSITY_TRANSITION_MS;
      const target = targetRef.current;
      if (current !== target) current = approach(current, target, step);
      const accent = accentRef.current;
      easeTriplet(curInk, accent.ink, step);
      easeTriplet(curSoft, accent.soft, step);
      easeTriplet(curDeep, accent.deep, step);
      easeTriplet(curBright, accent.bright, step);
      lastNow = now;
      drawFrame((now - started) / 1000);
      rafId = requestAnimationFrame(tick);
    }

    function startLoop(): void {
      if (disposed || rafId !== null) return;
      // Visibility gate: never burn frames for a hidden window.
      if (document.visibilityState !== "visible") return;
      lastNow = performance.now();
      rafId = requestAnimationFrame(tick);
    }

    function stopLoop(): void {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") startLoop();
      else stopLoop();
    };

    /** Snap the eased accent to the current target (reduced-motion has no loop
     * to chase a new theme). */
    const snapAccent = (): void => {
      const accent = accentRef.current;
      curInk[0] = accent.ink[0];
      curInk[1] = accent.ink[1];
      curInk[2] = accent.ink[2];
      curSoft[0] = accent.soft[0];
      curSoft[1] = accent.soft[1];
      curSoft[2] = accent.soft[2];
      curDeep[0] = accent.deep[0];
      curDeep[1] = accent.deep[1];
      curDeep[2] = accent.deep[2];
      curBright[0] = accent.bright[0];
      curBright[1] = accent.bright[1];
      curBright[2] = accent.bright[2];
    };

    resize();
    if (prefersReducedMotion) {
      // FULL STOP under reduced motion: exactly one static frame at the
      // target intensity + accent — no rAF, no visibility listener. Intensity,
      // theme and resize changes re-draw the still frame via the hooks below.
      current = targetRef.current;
      snapAccent();
      drawFrame(0);
      staticRedrawRef.current = () => {
        if (disposed) return;
        current = targetRef.current;
        snapAccent();
        drawFrame(0);
      };
    } else {
      // Immediate first paint so the layer never flashes empty while the
      // first rAF is queued (mirrors the landing's `frame()` before-loop).
      drawFrame(0);
      startLoop();
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    // jsdom lacks ResizeObserver — the static first frame simply stays
    // (same guard as DitherHero/SessionsList). A paused (hidden) loop
    // repaints at the new size on its first resumed frame.
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        resize();
        if (prefersReducedMotion) drawFrame(0);
      });
      resizeObserver.observe(canvas);
    }

    return () => {
      disposed = true;
      stopLoop();
      staticRedrawRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver?.disconnect();
      ctx.deleteBuffer(scene.buffer);
      ctx.deleteProgram(scene.program);
      // Deliberately NO WEBGL_lose_context here: a canvas keeps one context
      // identity forever, so losing it would poison StrictMode's dev
      // mount→cleanup→mount replay (the re-run would receive the same,
      // now-lost context and needlessly fall back). The context itself is
      // reclaimed with the canvas element when the layer truly unmounts —
      // and the shell mounts exactly one SignalSky for the app's lifetime.
    };
  }, []);

  return (
    <div
      aria-hidden
      data-vex-sky-layer
      className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-hidden"
    >
      {failed ? (
        // Static fallback: the sky's memory as a CSS gradient — the active
        // accent at 12% over the ink canvas behind this layer, fading to
        // nothing. `--vex-accent` re-tints per theme, so the fallback stays
        // theme-aware (cobalt in vex, neon lime in Robinhood mode).
        <div
          data-vex-sky-fallback
          className="absolute inset-0 h-full w-full bg-[radial-gradient(120%_80%_at_50%_0%,color-mix(in_oklab,var(--vex-accent)_12%,transparent),transparent_70%)]"
        />
      ) : (
        <canvas
          ref={canvasRef}
          data-vex-sky
          className="absolute inset-0 h-full w-full"
        />
      )}
    </div>
  );
}
