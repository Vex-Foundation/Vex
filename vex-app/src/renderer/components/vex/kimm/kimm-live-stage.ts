/**
 * WHERE HER LIVE FIGURE STANDS (desktop's stand-in for VEX Cloud's `KimmProvider`, `kimm-provider.tsx`; owner decision
 * 2026-11-15). Cloud's frame mounts one provider that holds the page's one live Kimm and seats it in whichever stage
 * shows her. Desktop mounts no provider: `KimmPanel` stands in two places (the lock screen, D2's portrait card), and
 * this module is the one owner they share.
 *
 *   - ONE MODEL. One `KimmLive` for the renderer. A panel that may show her live takes a seat; the last seat taken
 *     holds her canvas, so when the lock screen gives way to the shell (both mounted for the curtain's crossfade)
 *     her figure moves to the card without a second model, and back if the card leaves first.
 *   - HER MOOD. The seat that holds her plays its mood: the cue's event, then the mood pinned with no end
 *     (`KIMM_LIVE_CUE`), so she shows what her still would show for as long as desktop's clock holds it. A model
 *     that arrives late arrives in the holder's mood, as Cloud replays its last moment.
 *   - LIVELY. A seat may ask for the lock screen's lively mode (`KimmLive.lively`: no idle sleep, a livelier rig, a
 *     30 fps cap). The holder's ask applies, so the card, which never asks, keeps Cloud's calm behaviour even when
 *     the lock screen hands her over.
 *   - LETTING GO. With no seat, she sleeps at once and her model is freed 30 s later (`KIMM_RELEASE_MS`, Cloud's
 *     `PHONE_DISPOSE_MS`): the textures and the WebGL context go. A seat taken within the 30 s keeps her.
 *   - A FAILURE STAYS A FAILURE. A load that fails, or a GPU the probe refuses, leaves every panel on its still for the
 *     renderer's life (`kimm-live.ts`, the page memory).
 *
 * No React here beyond the context that hands a stage to the panels (tests hand one with stand-in loaders); the hook
 * is `use-kimm-live.ts`.
 */

import { createContext } from "react";
import type { KimmMood } from "./kimm-assets.js";
import type { KimmFitOptions } from "./kimm-fit.js";
import { createKimmLive, type KimmLive, type KimmLiveOptions, type KimmLiveStatus } from "./kimm-live.js";
import { KIMM_LIVE_CUE } from "./kimm-live-moods.js";
import type { KimmReaction } from "./kimm-rig.js";

/** She lets her model go this long after the last seat is given up (Cloud's `PHONE_DISPOSE_MS`). */
export const KIMM_RELEASE_MS = 30_000;

/** A panel's seat: update its fit or mood, give it up. */
export interface KimmLiveSeat {
  /** This seat holds her canvas. */
  readonly holds: boolean;
  fit(next: KimmFitOptions): void;
  mood(next: KimmMood): void;
  /** The pointer is over this seat's box (it keeps her awake while it rests there). */
  hover(on: boolean): void;
  /** This seat asks for the lock screen's lively mode (`KimmLive.lively`); it applies while the seat holds her. */
  lively(on: boolean): void;
  /** A reaction (`KIMM_REACT`), played only while this seat holds her in its lively mode. */
  react(signal: KimmReaction, at?: { readonly x: number; readonly y: number }): void;
  release(): void;
}

export interface KimmLiveStage {
  /** The live instance's status. */
  readonly status: KimmLiveStatus;
  /** Hears every change of status or of which seat holds her. */
  subscribe(listener: () => void): () => void;
  /** Takes a seat in `layer`; the newest seat holds her canvas, in its own lively mode (off by default). */
  seat(layer: HTMLElement, fit: KimmFitOptions, mood: KimmMood, lively?: boolean): KimmLiveSeat;
  /** Whether the seat in `layer` holds her canvas. */
  holds(layer: HTMLElement | null): boolean;
  /** Loads her (no-op without a seat, while loading, or once she failed or the GPU refused her). */
  start(): void;
  /** The window was shown again: her ticker runs again (and sleeps after the idle time). */
  wake(): void;
  /** Frees her at once (tests). */
  destroy(): void;
}

export interface KimmLiveStageOptions {
  readonly live?: Pick<KimmLiveOptions, "loaders" | "page" | "gpu">;
  readonly releaseMs?: number;
}

interface SeatEntry {
  readonly layer: HTMLElement;
  fit: KimmFitOptions;
  mood: KimmMood;
  lively: boolean;
}

export function createKimmLiveStage(options: KimmLiveStageOptions = {}): KimmLiveStage {
  const releaseMs = options.releaseMs ?? KIMM_RELEASE_MS;
  const listeners = new Set<() => void>();
  const seats: SeatEntry[] = [];
  let live: KimmLive | null = null;
  let status: KimmLiveStatus = "idle";
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const holder = (): SeatEntry | null => seats[seats.length - 1] ?? null;
  const getLive = (): KimmLive => {
    if (live === null) {
      live = createKimmLive({
        ...options.live,
        onStatus: (next) => {
          status = next;
          if (next === "live") play();
          notify();
        },
      });
      status = live.status;
    }
    return live;
  };
  /* the holder's mood: the cue's gesture, then the mood held until the next */
  const play = (): void => {
    const top = holder();
    if (live === null || top === null || status !== "live") return;
    const cue = KIMM_LIVE_CUE[top.mood];
    live.on(cue.event);
    live.mood(cue.mood, 0);
  };
  const cancelRelease = (): void => {
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseTimer = null;
  };
  const free = (): void => {
    cancelRelease();
    live?.destroy();
    live = null;
    if (status !== "failed" && status !== "gated") status = "idle";
    notify();
  };
  /* the holder takes her canvas; with no seat she sleeps and is freed after `releaseMs` */
  const reseat = (left: HTMLElement | null): void => {
    const top = holder();
    if (top === null) {
      if (live !== null && left !== null) live.detach(left);
      if (live !== null) {
        cancelRelease();
        releaseTimer = setTimeout(free, releaseMs);
      }
      notify();
      return;
    }
    cancelRelease();
    const instance = getLive();
    instance.attach(top.layer, top.fit);
    instance.lively(top.lively);
    instance.show(true);
    play();
    notify();
  };

  return {
    get status() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    seat(layer, fit, mood, lively = false) {
      const entry: SeatEntry = { layer, fit, mood, lively };
      seats.push(entry);
      reseat(null);
      let released = false;
      return {
        get holds() {
          return !released && holder() === entry;
        },
        fit(next) {
          entry.fit = next;
          if (holder() === entry) live?.attach(layer, next);
        },
        mood(next) {
          if (entry.mood === next) return;
          entry.mood = next;
          if (holder() === entry) play();
        },
        hover(on) {
          if (holder() === entry) live?.hover(on);
        },
        react(signal, at) {
          if (holder() === entry && entry.lively) live?.react(signal, at);
        },
        lively(on) {
          if (entry.lively === on) return;
          entry.lively = on;
          if (holder() === entry) live?.lively(on);
        },
        release() {
          if (released) return;
          released = true;
          const wasHolder = holder() === entry;
          const index = seats.indexOf(entry);
          if (index >= 0) seats.splice(index, 1);
          if (wasHolder) {
            live?.hover(false);
            reseat(layer);
          } else notify();
        },
      };
    },
    holds(layer) {
      return layer !== null && holder()?.layer === layer;
    },
    start() {
      if (holder() === null) return;
      void getLive().start();
    },
    wake() {
      if (holder() !== null) live?.wake();
    },
    destroy() {
      seats.length = 0;
      free();
    },
  };
}

let shared: KimmLiveStage | null = null;

/** The renderer's one stage (created on first use). */
export function sharedKimmLiveStage(): KimmLiveStage {
  shared ??= createKimmLiveStage();
  return shared;
}

/**
 * The stage a `KimmPanel` seats her on: the renderer's shared one, unless a provider hands another (tests, with
 * stand-in loaders and GPU). `null` reads as the shared stage.
 */
export const KimmLiveStageContext = createContext<KimmLiveStage | null>(null);
