/**
 * THE ONE LIVE KIMM OF THE RENDERER (VEX Cloud's `apps/web/src/components/kimm/kimm-live.ts`: PLAN WP3.5, PD-08,
 * PD-29; H3 `stage.js:95-135`; SK KIMM.md 8). The only module that reaches the embed (`kimm-embed.ts`), and only
 * through `import()`, so neither the embed, the rig nor PIXI's glue joins the first JS.
 *
 *   - One host element holds her canvas for the whole renderer: a panel seats it in its box (`attach`), and when the
 *     panel moves (the lock screen giving way to the shell's portrait card) the same model follows, never a second.
 *   - `start()` runs the GPU half of the gate first (`probeGpu`: WebGL2 and 4096 textures), then loads the libraries
 *     and the model. A failure leaves her still for the rest of the renderer's life: the page memory never retries.
 *   - Her ticker runs while her panel shows her, the window is shown and she is in view; it sleeps on a painted frame
 *     12 s after the last event, unless the pointer rests on her (`IDLE_SLEEP_MS`, H3 `stage.js:30, 120-130`).
 *   - `destroy()` frees the model's textures and the WebGL context; a later `start()` loads her again.
 *
 * DESKTOP PORT (owner decision 2026-11-15): Cloud's module without its field loader (desktop's glyph field is
 * `KimmField.tsx`, which imports its own port) and with no glances by name (desktop gives her no `talk` or `key`
 * target: she follows the pointer and drifts). Her canvas takes no click: desktop's panel is decorative and takes no
 * pointer (`poke: false`).
 */

import { KIMM_LIVE_LIBS, KIMM_LIVE_MODEL_BASE, KIMM_LIVE_MODEL_FILE } from "./kimm-assets.js";
import type { KimmEmbed, KimmEmbedOptions } from "./kimm-embed.js";
import type { KimmFitOptions } from "./kimm-fit.js";
import { KIMM_MIN_TEXTURE, probeGpu } from "./kimm-gates.js";
import type { KimmEvent, KimmLiveMood } from "./kimm-live-moods.js";

/** Her ticker sleeps this long after the last event (H3 `IDLE_MS`). */
export const IDLE_SLEEP_MS = 12_000;

/** What the live instance is doing. `gated`: the GPU half of the gate kept her still; `failed`: a file or a library. */
export type KimmLiveStatus = "idle" | "gated" | "loading" | "live" | "failed";

/** The embed, loaded on demand (a test passes a stand-in). */
export interface KimmLiveLoaders {
  readonly embed: () => Promise<{
    mountKimm: (el: HTMLElement, options: KimmEmbedOptions) => KimmEmbed;
  }>;
}

const LOADERS: KimmLiveLoaders = {
  embed: () => import("./kimm-embed.js"),
};

/** What one renderer remembers: a failed load is never retried in it. */
export interface KimmPageMemory {
  failed: boolean;
}

const PAGE: KimmPageMemory = { failed: false };

export interface KimmLiveOptions {
  readonly loaders?: KimmLiveLoaders;
  readonly page?: KimmPageMemory;
  readonly onStatus?: (status: KimmLiveStatus) => void;
  /** The GPU probe (tests pass a stand-in). */
  readonly gpu?: () => {
    readonly webgl2: boolean;
    readonly maxTextureSize: number | undefined;
  };
}

export interface KimmLive {
  readonly status: KimmLiveStatus;
  /** Seats her canvas in a panel's layer with that seat's fit. */
  attach(layer: HTMLElement, fit: KimmFitOptions): void;
  /** Takes her canvas out of `layer` (the panel unmounted) and lets her sleep. */
  detach(layer: HTMLElement): void;
  /** Loads her once (the gate's GPU half first); resolves true when she is on screen. */
  start(): Promise<boolean>;
  /** Sends an event; true when a model took it (played, or queued until she is ready). */
  on(event: KimmEvent, data?: unknown): boolean;
  mood(name: KimmLiveMood, ms?: number): void;
  /** Her panel shows her or not (not: one painted frame, the ticker stopped). */
  show(shown: boolean): void;
  /** The pointer rests on her: no sleep while it does. */
  hover(on: boolean): void;
  sleep(): void;
  wake(): void;
  destroy(): void;
}

/** One live instance (`use-kimm-live.ts` holds the renderer's). */
export function createKimmLive(options: KimmLiveOptions = {}): KimmLive {
  const loaders = options.loaders ?? LOADERS;
  const page = options.page ?? PAGE;
  let status: KimmLiveStatus = page.failed ? "failed" : "idle";
  let embed: KimmEmbed | null = null;
  let loading: Promise<boolean> | null = null;
  let host: HTMLDivElement | null = null;
  let fit: KimmFitOptions = {};
  let shown = false;
  let hovered = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /* a destroy while loading ends that load: its model never mounts */
  let generation = 0;

  const setStatus = (next: KimmLiveStatus): void => {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  };
  const hostElement = (): HTMLDivElement => {
    if (!host) {
      host = document.createElement("div");
      host.className = "vex-kimm-live__host";
      host.setAttribute("aria-hidden", "true");
    }
    return host;
  };
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const sleep = (): void => {
    clearTimer();
    embed?.sleep();
  };
  /* awake while shown: the ticker runs and sleeps again IDLE_SLEEP_MS after the last event, unless hovered */
  const touch = (): void => {
    clearTimer();
    if (!embed) return;
    if (!shown) {
      embed.sleep();
      return;
    }
    embed.wake();
    if (!hovered) timer = setTimeout(sleep, IDLE_SLEEP_MS);
  };

  const start = (): Promise<boolean> => {
    if (embed) return Promise.resolve(true);
    if (loading) return loading;
    if (page.failed || status === "gated") return Promise.resolve(false);
    const mine = generation;
    loading = (async () => {
      try {
        /* inside the try: a probe that throws leaves her still, never a rejected start nor a load stuck on */
        const gpu = (options.gpu ?? (() => probeGpu()))();
        if (!gpu.webgl2 || (gpu.maxTextureSize ?? 0) < KIMM_MIN_TEXTURE) {
          setStatus("gated");
          return false;
        }
        setStatus("loading");
        const { mountKimm } = await loaders.embed();
        if (mine !== generation) return false;
        const next = mountKimm(hostElement(), {
          base: KIMM_LIVE_MODEL_BASE,
          model: KIMM_LIVE_MODEL_FILE,
          libs: KIMM_LIVE_LIBS,
          fit,
          reducedMotion: false,
          poke: false,
          maxDpr: 2,
        });
        embed = next;
        const ok = await next.ready;
        if (embed !== next) return false;
        if (!ok) {
          next.destroy();
          embed = null;
          page.failed = true;
          setStatus("failed");
          return false;
        }
        setStatus("live");
        touch();
        return true;
      } catch {
        embed = null;
        page.failed = true;
        setStatus("failed");
        return false;
      } finally {
        if (mine === generation) loading = null;
      }
    })();
    return loading;
  };

  return {
    get status() {
      return status;
    },
    attach(layer, nextFit) {
      fit = nextFit;
      const el = hostElement();
      if (el.parentElement !== layer) layer.appendChild(el);
      embed?.refit(fit);
    },
    detach(layer) {
      if (host && host.parentElement === layer) host.remove();
      shown = false;
      sleep();
    },
    start,
    on(event, data) {
      if (!embed) return false;
      embed.on(event, data);
      if (event !== "say") touch();
      return true;
    },
    mood(name, ms) {
      embed?.mood(name, ms);
      touch();
    },
    show(next) {
      shown = next;
      touch();
    },
    hover(on) {
      hovered = on;
      touch();
    },
    sleep,
    wake: touch,
    destroy() {
      generation += 1;
      loading = null;
      clearTimer();
      embed?.destroy();
      embed = null;
      host?.remove();
      host = null;
      if (status === "live" || status === "loading") setStatus("idle");
    },
  };
}
