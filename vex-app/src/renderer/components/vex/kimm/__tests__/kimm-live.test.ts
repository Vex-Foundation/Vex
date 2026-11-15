/**
 * The one live Kimm (`kimm-live.ts`, VEX Cloud's `kimm-live.ts` ported, owner decision 2026-11-15), driven with a
 * stand-in embed and GPU (jsdom has no WebGL and runs no script file).
 *
 * Regressions this catches:
 *   - a load that starts on a GPU without WebGL2 or 4096 textures (her textures are 4096; she must stay still);
 *   - her files named anywhere but `kimm-assets.ts`, out of order, or off the app's own origin;
 *   - her canvas taking a click on desktop's decorative panel (`poke`);
 *   - a failed load retried, or leaving her in `loading`;
 *   - a destroy during a load that still mounts the model;
 *   - her ticker running on: it must sleep 12 s after the last event, never while the pointer rests on her, and at
 *     once when her panel no longer shows her.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIMM_LIVE_LIBS, KIMM_LIVE_MODEL_BASE, KIMM_LIVE_MODEL_FILE } from "../kimm-assets.js";
import { createKimmLive, IDLE_SLEEP_MS, type KimmLiveStatus } from "../kimm-live.js";
import { fakeEmbedKit, flush, GOOD_GPU } from "./fake-kimm-embed.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createKimmLive", () => {
  it("stays still on a GPU without WebGL2 or with textures under 4096, and never loads the embed", async () => {
    for (const gpu of [
      () => ({ webgl2: false, maxTextureSize: undefined }),
      () => ({ webgl2: true, maxTextureSize: 2048 }),
      () => {
        throw new Error("probe failed");
      },
    ]) {
      const kit = fakeEmbedKit();
      const statuses: KimmLiveStatus[] = [];
      const live = createKimmLive({ loaders: kit.loaders, page: kit.page, gpu, onStatus: (s) => statuses.push(s) });
      expect(await live.start()).toBe(false);
      expect(kit.loads).toBe(0);
      expect(live.status === "gated" || live.status === "failed").toBe(true);
    }
  });

  it("loads her from the app's own origin, the libraries in order, with no poke, and goes live", async () => {
    const kit = fakeEmbedKit();
    const statuses: KimmLiveStatus[] = [];
    const live = createKimmLive({ loaders: kit.loaders, page: kit.page, gpu: GOOD_GPU, onStatus: (s) => statuses.push(s) });
    const layer = document.createElement("div");
    const fit = { headroom: 10 };
    live.attach(layer, fit);
    live.show(true);
    expect(await live.start()).toBe(true);
    expect(statuses).toEqual(["loading", "live"]);
    const [embed] = kit.mounts;
    expect(embed?.options.base).toBe(KIMM_LIVE_MODEL_BASE);
    expect(embed?.options.base).toBe("/art/kimm/live/model/");
    expect(embed?.options.model).toBe(KIMM_LIVE_MODEL_FILE);
    expect(embed?.options.libs).toEqual([...KIMM_LIVE_LIBS]);
    expect(KIMM_LIVE_LIBS.map((url) => url.split("/").pop())).toEqual([
      "live2dcubismcore.min.js",
      "pixi.min.js",
      "unsafe-eval.min.js",
      "cubism4.min.js",
    ]);
    for (const url of [...KIMM_LIVE_LIBS, KIMM_LIVE_MODEL_BASE]) expect(url.startsWith("/art/kimm/live/")).toBe(true);
    expect(embed?.options.poke).toBe(false);
    expect(embed?.options.reducedMotion).toBe(false);
    expect(embed?.options.fit).toBe(fit);
    // her host sits in the layer, decorative
    expect(embed?.el.parentElement).toBe(layer);
    expect(embed?.el.getAttribute("aria-hidden")).toBe("true");
    expect(embed?.awake).toBe(true);
    // a second start reuses her
    expect(await live.start()).toBe(true);
    expect(kit.loads).toBe(1);
  });

  it("a model that fails leaves her still for the renderer's life, freed and never retried", async () => {
    const kit = fakeEmbedKit();
    kit.autoReady = false;
    const live = createKimmLive({ loaders: kit.loaders, page: kit.page, gpu: GOOD_GPU });
    expect(await live.start()).toBe(false);
    expect(live.status).toBe("failed");
    expect(kit.mounts[0]?.destroyed).toBe(true);
    expect(kit.page.failed).toBe(true);
    const again = createKimmLive({ loaders: kit.loaders, page: kit.page, gpu: GOOD_GPU });
    expect(again.status).toBe("failed");
    expect(await again.start()).toBe(false);
    expect(kit.loads).toBe(1);
  });

  it("a chunk that fails to load is a failure, not a load stuck on", async () => {
    const kit = fakeEmbedKit();
    kit.failLoad = true;
    const live = createKimmLive({ loaders: kit.loaders, page: kit.page, gpu: GOOD_GPU });
    expect(await live.start()).toBe(false);
    expect(live.status).toBe("failed");
  });

  it("a destroy during the load ends it: that model never mounts", async () => {
    const kit = fakeEmbedKit();
    const live = createKimmLive({ loaders: kit.loaders, page: kit.page, gpu: GOOD_GPU });
    const started = live.start();
    live.destroy();
    expect(await started).toBe(false);
    expect(kit.mounts).toHaveLength(0);
    expect(live.status).toBe("idle");
  });

  it("sleeps 12 s after the last event, never while hovered, and at once when not shown", async () => {
    const kit = fakeEmbedKit();
    const live = createKimmLive({ loaders: kit.loaders, page: kit.page, gpu: GOOD_GPU });
    live.attach(document.createElement("div"), {});
    live.show(true);
    await live.start();
    const embed = kit.mounts[0];
    expect(embed?.awake).toBe(true);
    vi.advanceTimersByTime(IDLE_SLEEP_MS - 1);
    expect(embed?.awake).toBe(true);
    vi.advanceTimersByTime(1);
    expect(embed?.awake).toBe(false);
    // an event wakes her and restarts the clock
    expect(live.on("hi")).toBe(true);
    expect(embed?.events).toEqual(["hi"]);
    expect(embed?.awake).toBe(true);
    // hovered, she stays awake
    live.hover(true);
    vi.advanceTimersByTime(IDLE_SLEEP_MS * 3);
    expect(embed?.awake).toBe(true);
    live.hover(false);
    vi.advanceTimersByTime(IDLE_SLEEP_MS);
    expect(embed?.awake).toBe(false);
    live.wake();
    expect(embed?.awake).toBe(true);
    live.show(false);
    expect(embed?.awake).toBe(false);
  });

  it("follows her panel: attach moves her host and refits, detach takes it out and lets her sleep", async () => {
    const kit = fakeEmbedKit();
    const live = createKimmLive({ loaders: kit.loaders, page: kit.page, gpu: GOOD_GPU });
    const first = document.createElement("div");
    const second = document.createElement("div");
    live.attach(first, {});
    live.show(true);
    await live.start();
    const embed = kit.mounts[0];
    const card = { headroom: 48 };
    live.attach(second, card);
    expect(embed?.el.parentElement).toBe(second);
    expect(embed?.fits.at(-1)).toBe(card);
    live.detach(first);
    expect(embed?.el.parentElement).toBe(second);
    live.detach(second);
    expect(embed?.el.parentElement).toBeNull();
    expect(embed?.awake).toBe(false);
    live.destroy();
    expect(embed?.destroyed).toBe(true);
    expect(live.status).toBe("idle");
    await flush();
  });
});
