/**
 * Her embed (`kimm-embed.ts`) on stand-in libraries: jsdom runs no script file and has no WebGL, so a fake PIXI
 * global stands in for PIXI 6 and pixi-live2d-display, and each library "loads" when appended. What is under test is
 * the embed's own wiring of desktop's lock-screen lively mode and of her pause.
 *
 * Regressions this catches:
 *   - the lively cap missing from her render ticker or from the shared ticker her model updates on (30 fps on the
 *     lock screen), or left on after lively ends or after she is destroyed;
 *   - the card (calm) capped;
 *   - a hidden or minimised window, or a panel out of view, that keeps her ticker or her model's update running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountKimm, type KimmEmbedOptions } from "../kimm-embed.js";
import { KIMM_LIVELY } from "../kimm-rig.js";

class FakeTicker {
  started = false;
  maxFPS = 0;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
}

interface FakeModel {
  autoUpdate: boolean;
  destroyed: boolean;
}

let shared: FakeTicker;
let apps: Array<{ ticker: FakeTicker }>;
let models: FakeModel[];
let intersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | null;
let hidden = false;

function fakePixi(): unknown {
  return {
    Ticker: { shared },
    Application: class {
      readonly ticker = new FakeTicker();
      readonly renderer = { width: 1, height: 1, resolution: 1, resize: () => undefined, gl: undefined };
      readonly stage = { addChild: () => undefined };
      constructor(options: { autoStart: boolean }) {
        if (options.autoStart) this.ticker.start();
        apps.push(this);
      }
      render(): void {}
      destroy(): void {}
    },
    live2d: {
      Live2DModel: {
        from: async (): Promise<unknown> => {
          const model = {
            x: 0,
            y: 0,
            autoUpdate: true,
            destroyed: false,
            scale: { set: () => undefined },
            internalModel: {
              coreModel: {
                getModel: () => ({ parameters: { ids: ["ParamEyeLOpen", "ParamAngleX"] } }),
                setParameterValueByIndex: () => undefined,
                getParameterValueByIndex: () => 1,
              },
              breath: {},
              on: () => undefined,
            },
            motion: () => undefined,
            update: () => undefined,
            destroy() {
              this.destroyed = true;
            },
          };
          models.push(model);
          return model;
        },
      },
    },
  };
}

const OPTIONS: KimmEmbedOptions = {
  base: "/art/kimm/live/model/",
  model: "kimm.model3.json",
  libs: ["/art/kimm/live/lib/a.js", "/art/kimm/live/lib/b.js"],
  reducedMotion: false,
  poke: false,
};

beforeEach(() => {
  shared = new FakeTicker();
  apps = [];
  models = [];
  intersect = null;
  hidden = false;
  vi.stubGlobal("PIXI", fakePixi());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        intersect = callback;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const append = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    const result = append(node);
    if (node instanceof HTMLScriptElement) queueMicrotask(() => node.onload?.(new Event("load")));
    return result;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mountKimm on desktop", () => {
  it("caps her render ticker and the shared ticker her model updates on at 30 fps in lively mode", async () => {
    const embed = mountKimm(document.createElement("div"), { ...OPTIONS, lively: true });
    expect(await embed.ready).toBe(true);
    expect(apps[0]?.ticker.maxFPS).toBe(KIMM_LIVELY.fps);
    expect(shared.maxFPS).toBe(30);
    embed.lively(false);
    expect(apps[0]?.ticker.maxFPS).toBe(0);
    expect(shared.maxFPS).toBe(0);
    embed.lively(true);
    expect(shared.maxFPS).toBe(30);
    embed.destroy();
    expect(shared.maxFPS).toBe(0);
  });

  it("leaves the card's calm figure uncapped", async () => {
    const embed = mountKimm(document.createElement("div"), OPTIONS);
    expect(await embed.ready).toBe(true);
    expect(apps[0]?.ticker.maxFPS).toBe(0);
    expect(shared.maxFPS).toBe(0);
    embed.destroy();
  });

  it("pauses her ticker and her model's update while the window is hidden, and resumes when shown", async () => {
    const embed = mountKimm(document.createElement("div"), { ...OPTIONS, lively: true });
    await embed.ready;
    const ticker = apps[0]?.ticker;
    const model = models[0];
    expect(ticker?.started).toBe(true);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ticker?.started).toBe(false);
    expect(model?.autoUpdate).toBe(false);
    expect(embed.awake).toBe(false);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ticker?.started).toBe(true);
    expect(model?.autoUpdate).toBe(true);
    embed.destroy();
  });

  it("pauses when her panel is out of view, and while asleep", async () => {
    const embed = mountKimm(document.createElement("div"), OPTIONS);
    await embed.ready;
    const ticker = apps[0]?.ticker;
    intersect?.([{ isIntersecting: false }]);
    expect(ticker?.started).toBe(false);
    expect(models[0]?.autoUpdate).toBe(false);
    intersect?.([{ isIntersecting: true }]);
    expect(ticker?.started).toBe(true);
    embed.sleep();
    expect(ticker?.started).toBe(false);
    embed.wake();
    expect(ticker?.started).toBe(true);
    // the pointer leaving the window is heard (the rig eases her gaze home; kimm-rig-lively.test.ts)
    window.dispatchEvent(new MouseEvent("pointerout", { relatedTarget: null }));
    window.dispatchEvent(new Event("blur"));
    embed.destroy();
  });
});
