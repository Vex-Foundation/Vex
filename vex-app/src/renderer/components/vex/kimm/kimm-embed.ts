/**
 * Kimm, the Live2D face of Vex, on a box (SK KIMM.md 3, 6, 8, 10; the tested `kit/kimm-embed/kimm-embed.js`, H3
 * `js/vendor/kimm-embed.mjs`). A port of the embed: the same libraries, model, rig, fit and event API, with its three
 * fixes kept (framing from `clientWidth`/`clientHeight`, springs sub-stepped at 1/60 s, her own blink) and the rig and
 * the fit moved to pure modules (`kimm-rig.ts`, `kimm-fit.ts`).
 *
 * Changes from the embed: the device gate runs before this module is even fetched (`kimm-gates.ts`, `kimm-live.ts`);
 * `sleep()` and `wake()` stop and start the ticker on a painted frame; the fit options can change while she stays
 * loaded (her stage moves between boxes); `destroy()` frees the model's textures and loses the WebGL context. Reached
 * only through `kimm-live.ts`'s `import()`, so it never joins the first JS.
 *
 * DESKTOP PORT (owner decision 2026-11-15): VEX Cloud's `apps/web/src/components/kimm/kimm-embed.ts`, unchanged but
 * for its moods' names (`KimmLiveMood`), the import suffixes and the indentation. The libraries it adds are the
 * same-origin files `kimm-assets.ts` names (`KIMM_LIVE_LIBS`), as `<script src>` elements in order, never inline, so
 * the production CSP keeps `script-src 'self'` alone. Desktop adds the lock screen's lively mode (`lively`, `KIMM_LIVELY`:
 * the rig's livelier idle and a 30 fps cap), eases her gaze home when the pointer leaves the window, and pauses her
 * model's own update with the render ticker.
 */
import { fitKimm, KM, type KimmFitOptions } from "./kimm-fit.js";
import type { KimmEvent, KimmLiveMood } from "./kimm-live-moods.js";
import {
  createKimmRig,
  KIMM_LIVELY,
  type KimmReaction,
  type KimmLookTarget,
  type KimmTargets,
} from "./kimm-rig.js";

/** The parts of PIXI 6 and pixi-live2d-display 0.4.0 this module touches (both are globals from the libraries). */
interface PixiTicker {
  readonly started: boolean;
  /** 0: no cap (PIXI 6's `Ticker.maxFPS`). */
  maxFPS: number;
  start(): void;
  stop(): void;
}
interface PixiRenderer {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly gl?: WebGLRenderingContext;
  resize(width: number, height: number): void;
}
interface PixiApp {
  readonly ticker: PixiTicker;
  readonly renderer: PixiRenderer;
  readonly stage: { addChild(child: unknown): void };
  render(): void;
  destroy(
    removeView: boolean,
    options: { children: boolean; texture: boolean; baseTexture: boolean },
  ): void;
}
interface CubismCoreModel {
  getModel(): { parameters: { ids: readonly string[] } };
  setParameterValueByIndex(index: number, value: number): void;
  getParameterValueByIndex(index: number): number;
}
interface Live2DModel {
  x: number;
  /** pixi-live2d-display updates the model on PIXI's shared ticker while this is on. */
  autoUpdate: boolean;
  y: number;
  readonly scale: { set(value: number): void };
  readonly internalModel: {
    readonly coreModel: CubismCoreModel;
    breath: unknown;
    on(event: "beforeModelUpdate", fn: () => void): void;
  };
  motion(group: string, index: number, priority: number): unknown;
  update(ms: number): void;
  destroy(options?: {
    children: boolean;
    texture: boolean;
    baseTexture: boolean;
  }): void;
}
interface PixiGlobal {
  Application: new (options: Record<string, unknown>) => PixiApp;
  /** The shared ticker pixi-live2d-display updates her model on. */
  Ticker?: { readonly shared: PixiTicker };
  live2d?: {
    Live2DModel: {
      from(url: string, options: Record<string, unknown>): Promise<Live2DModel>;
    };
  };
}

export interface KimmEmbedOptions {
  /** The model folder (with its trailing slash) and settings file. */
  readonly base: string;
  readonly model: string;
  /** The libraries in load order. */
  readonly libs: readonly string[];
  /** The fit; read again on every resize, so a function can follow the box. */
  readonly fit?: KimmFitOptions;
  /** The element placed over her head (the arc slot): its `left`, `top` and scale follow her. */
  readonly arc?: HTMLElement | null;
  readonly targets?: KimmTargets;
  readonly reducedMotion?: boolean;
  /** Idle acts, the pointer, her blink, a poke on a click (all on by default). */
  readonly idle?: boolean;
  readonly pointer?: boolean;
  readonly blink?: boolean;
  readonly poke?: boolean;
  readonly maxDpr?: number;
  /** Manual mode: no ticker, `step(ms)` advances and draws (deterministic tests). */
  readonly manual?: boolean;
  readonly clock?: () => number;
  readonly speaking?: () => boolean;
  readonly level?: () => number;
  readonly onProgress?: (share: number) => void;
  readonly onPoke?: () => void;
  /** Desktop's lock screen: the rig's lively mode and the ticker capped at `KIMM_LIVELY.fps` (`lively()` later). */
  readonly lively?: boolean;
}

export interface KimmEmbed {
  /** True when she is on screen, false when a library or the model failed (the still stays). */
  readonly ready: Promise<boolean>;
  on(event: KimmEvent, data?: unknown): void;
  mood(name: KimmLiveMood, ms?: number): void;
  look(target: KimmLookTarget | null, ms?: number): void;
  talk(ms: number): void;
  param(id: string, value: number | null): void;
  /** Changes the fit (a new box, a new arc) and refits. */
  refit(fit?: KimmFitOptions, arc?: HTMLElement | null): void;
  /** Stops the ticker on a painted frame, until `wake()`. */
  sleep(): void;
  wake(): void;
  step(ms: number): void;
  readonly awake: boolean;
  /** Desktop's lively mode on or off: the rig's (`KIMM_LIVELY`) and the ticker cap (30 fps on, none off). */
  lively(on: boolean): void;
  /** Desktop's lock screen: a reaction to a typed signal (`KIMM_REACT`); `at` is a point, never an element. */
  react(signal: KimmReaction, at?: { readonly x: number; readonly y: number }): void;
  /** The pointer rests over her panel (a smile at rest, and a head tilt when lively). */
  hover(on: boolean): void;
  destroy(): void;
}

const scripts = new Map<string, Promise<void>>();

/** Each library once per page, in order: the core and PIXI must be globals before `cubism4.min.js` runs (SK KIMM.md 11.8). */
function loadScript(src: string): Promise<void> {
  let loading = scripts.get(src);
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`failed: ${src}`));
      document.head.appendChild(script);
    });
    scripts.set(src, loading);
    loading.catch(() => scripts.delete(src));
  }
  return loading;
}

/** Mounts Kimm in `el` (a box the stage sizes). */
export function mountKimm(el: HTMLElement, o: KimmEmbedOptions): KimmEmbed {
  const now = o.clock ?? (() => performance.now());
  const RM =
    o.reducedMotion ??
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const progress = o.onProgress ?? (() => {});
  let fitOptions: KimmFitOptions = o.fit ?? {};
  let arcEl: HTMLElement | null = o.arc ?? null;
  let model: Live2DModel | null = null;
  let app: PixiApp | null = null;
  let core: CubismCoreModel | null = null;
  let canvas: HTMLCanvasElement | null = null;
  const ids: Record<string, number> = {};
  let ready = false;
  let dead = false;
  let asleep = false;
  let visible = true;
  let y0 = 0;
  let jy = 0;
  /* DESKTOP, the lock screen: her fit's scale, face line and hair, so a lean-in can zoom about her face */
  let fitS = 1;
  let fitFace = 0;
  let fitHead = 0;
  let zoom = 1;
  let sleepNow = 0;
  let blinkNow = 1;
  const place = () => {
    if (!model) return;
    model.scale.set(fitS * zoom);
    model.x = fitFace - KM.face * fitS * zoom;
    y0 = fitHead - KM.head * fitS * zoom;
    model.y = y0 + jy;
  };
  let ro: ResizeObserver | null = null;
  let io: IntersectionObserver | null = null;
  const queued: [KimmEvent, unknown][] = [];
  const rig = createKimmRig({
    now,
    reducedMotion: RM,
    idle: o.idle,
    pointer: o.pointer,
    targets: o.targets,
    speaking: o.speaking,
    level: o.level,
    lively: o.lively === true,
  });
  let lively = o.lively === true;
  let shared: PixiTicker | null = null;

  const on = (event: KimmEvent, data?: unknown) => {
    /* events before she is ready are queued and replayed, except `say` (`kimm.js:90`, SK KIMM.md 11.10) */
    if (!ready) {
      if (event !== "say") queued.push([event, data]);
      return;
    }
    rig.on(event, data);
  };

  /* framing from clientWidth/clientHeight, never a transformed rect (FIX of `kimm.js:131`) */
  const fit = () => {
    if (!model || !app) return;
    const W = Math.max(1, el.clientWidth);
    const H = Math.max(1, el.clientHeight);
    const dpr = app.renderer.resolution;
    if (
      app.renderer.width !== Math.round(W * dpr) ||
      app.renderer.height !== Math.round(H * dpr)
    )
      app.renderer.resize(W, H);
    const solved = fitKimm(W, H, fitOptions);
    fitS = solved.s;
    fitFace = solved.faceX;
    fitHead = solved.head;
    place();
    if (arcEl && solved.arc) {
      arcEl.style.left = `${solved.faceX}px`;
      arcEl.style.top = `${solved.arc.top}px`;
      arcEl.style.transform = `translateX(-50%) scale(${solved.arc.k.toFixed(3)})`;
    }
    if (!app.ticker.started) app.render();
  };

  const put = (id: string, value: number) => {
    const index = ids[id];
    if (index !== undefined && core)
      core.setParameterValueByIndex(index, value);
  };
  const apply = () => {
    if (!core || !model) return;
    const frame = rig.frame(el.getBoundingClientRect());
    for (const [id, value] of frame.params) put(id, value);
    if (frame.shut > 0.01) {
      for (const eye of ["ParamEyeLOpen", "ParamEyeROpen"]) {
        const index = ids[eye];
        if (index !== undefined)
          core.setParameterValueByIndex(
            index,
            core.getParameterValueByIndex(index) * (1 - frame.shut),
          );
      }
    }
    jy = frame.y;
    sleepNow = frame.sleep;
    blinkNow = frame.blink;
    if (frame.zoom !== zoom) {
      zoom = frame.zoom;
      place();
    } else model.y = y0 + jy;
  };

  /* the ticker runs while she is awake, in view and the tab is visible; stopping paints the last frame first.
     DESKTOP: her model's own update (pixi-live2d-display runs it on PIXI's shared ticker) pauses with the render
     ticker, so a hidden window or a sleeping figure spends nothing on her. */
  const sync = () => {
    if (!app || o.manual) return;
    const run = !asleep && visible && !document.hidden;
    if (run && !app.ticker.started) {
      if (model) model.autoUpdate = true;
      app.ticker.start();
    } else if (!run && app.ticker.started) {
      app.render();
      app.ticker.stop();
      if (model) model.autoUpdate = false;
    }
  };
  /* DESKTOP: the lively mode's cap, on her render ticker and on the shared ticker her model updates on */
  const cap = () => {
    const fps = lively ? KIMM_LIVELY.fps : 0;
    if (app) app.ticker.maxFPS = fps;
    if (shared) shared.maxFPS = fps;
  };
  const onAway = (event: Event) => {
    if (event.type === "blur" || (event as PointerEvent).relatedTarget === null) rig.pointerAway();
  };
  const onMove = (event: PointerEvent) =>
    rig.pointerMove(event.clientX, event.clientY);
  const onEnter = () => rig.hover(true);
  const onLeave = () => rig.hover(false);
  const onPoke = () => {
    rig.poke();
    o.onPoke?.();
  };

  const ready$ = (async () => {
    try {
      for (let i = 0; i < o.libs.length; i++) {
        await loadScript(o.libs[i] as string);
        progress(0.1 + (0.3 * (i + 1)) / o.libs.length);
      }
      if (dead) return false;
      const PIXI = (window as unknown as { PIXI?: PixiGlobal }).PIXI;
      if (!PIXI?.live2d) throw new Error("pixi-live2d-display missing");
      canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      el.appendChild(canvas);
      const dpr = Math.min(o.maxDpr ?? 2, window.devicePixelRatio || 1);
      shared = PIXI.Ticker?.shared ?? null;
      app = new PIXI.Application({
        view: canvas,
        backgroundAlpha: 0,
        antialias: true,
        resolution: dpr,
        autoDensity: false,
        autoStart: !o.manual,
        width: Math.max(1, el.clientWidth),
        height: Math.max(1, el.clientHeight),
      });
      const loaded = await PIXI.live2d.Live2DModel.from(`${o.base}${o.model}`, {
        autoInteract: false,
        autoUpdate: !o.manual,
        motionPreload: "IDLE",
      });
      if (dead) {
        loaded.destroy({ children: true, texture: true, baseTexture: true });
        return false;
      }
      model = loaded;
      progress(0.95);
      app.stage.addChild(model);
      const im = model.internalModel;
      core = im.coreModel;
      /* she breathes on her own 3.4 s cycle (the rig) */
      im.breath = undefined;
      const pids = core.getModel().parameters.ids;
      for (let i = 0; i < pids.length; i++) ids[pids[i] as string] = i;
      im.on("beforeModelUpdate", apply);
      /* FIX: pixi-live2d-display 0.4.0 skips its blink while any motion plays, and the idle loop always plays, so she
         never blinked in vex-home; a 150 ms close and open every 2.5 to 6.5 s on the page's own clock instead */
      if (o.blink !== false && !RM) {
        let at = now() + 2000 + Math.random() * 3000;
        im.on("beforeModelUpdate", () => {
          /* DESKTOP: sleepy, her blink is longer and comes less often */
          const u = (now() - at) / (150 * (1 + 1.5 * sleepNow));
          if (u > 1) {
            at = now() + ((2500 + Math.random() * 4000) * (1 + 0.8 * sleepNow)) / Math.max(0.25, blinkNow);
            return;
          }
          if (u < 0 || !core) return;
          const b = Math.sin(u * Math.PI);
          for (const eye of ["ParamEyeLOpen", "ParamEyeROpen"]) {
            const index = ids[eye];
            if (index !== undefined)
              core.setParameterValueByIndex(
                index,
                core.getParameterValueByIndex(index) * (1 - b),
              );
          }
        });
      }
      /* the idle loop drives the eye rings, sweat drops and tears (SK KIMM.md 2) */
      try {
        model.motion("Idle", 0, 1);
      } catch {
        /* a model without the loop still stands */
      }
      ready = true;
      fit();
      ro = new ResizeObserver(fit);
      ro.observe(el);
      io = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true;
        sync();
      });
      io.observe(el);
      document.addEventListener("visibilitychange", sync);
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerout", onAway, { passive: true });
      window.addEventListener("blur", onAway);
      cap();
      canvas.addEventListener("pointerenter", onEnter);
      canvas.addEventListener("pointerleave", onLeave);
      if (o.poke !== false) canvas.addEventListener("click", onPoke);
      for (const [event, data] of queued.splice(0)) rig.on(event, data);
      sync();
      progress(1);
      return true;
    } catch {
      progress(1);
      return false;
    }
  })();

  const destroy = () => {
    dead = true;
    ready = false;
    ro?.disconnect();
    io?.disconnect();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerout", onAway);
    window.removeEventListener("blur", onAway);
    document.removeEventListener("visibilitychange", sync);
    if (lively && shared) shared.maxFPS = 0;
    shared = null;
    if (app) {
      const gl = app.renderer.gl;
      /* the model's textures (three 4096 squares, about 160 MB of GPU memory) go with the stage */
      app.destroy(false, { children: true, texture: true, baseTexture: true });
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    }
    canvas?.remove();
    model = null;
    app = null;
    core = null;
    canvas = null;
  };

  return {
    ready: ready$,
    on,
    mood: (name, ms = 0) => {
      if (ready) rig.mood(name, ms);
    },
    look: (target, ms) => rig.look(target, ms),
    talk: (ms) => rig.talk(ms),
    param: (id, value) => rig.param(id, value),
    refit: (next, arc) => {
      if (next) fitOptions = next;
      if (arc !== undefined) arcEl = arc;
      fit();
    },
    sleep: () => {
      asleep = true;
      sync();
    },
    wake: () => {
      asleep = false;
      sync();
    },
    step: (ms) => {
      if (!model || !app) return;
      model.update(ms);
      app.render();
    },
    get awake() {
      return app?.ticker.started === true;
    },
    react: (signal, at) => {
      if (ready) rig.react(signal, at);
    },
    hover: (on) => rig.hover(on),
    lively: (on) => {
      if (on === lively) return;
      lively = on;
      rig.lively(on);
      cap();
    },
    destroy,
  };
}
