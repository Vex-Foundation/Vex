/**
 * Her live figure in her panel (`KimmPanel.tsx` over `useKimmLive` and `kimm-live-stage.ts`; owner decision
 * 2026-11-15), with a stand-in embed and GPU handed through `KimmLiveStageContext` (jsdom has no WebGL and runs no
 * script file). The lock screen and D2's portrait card both draw this panel, so this is the wiring of both.
 *
 * The intent matrix, one case each:
 *   | her figure | reduced motion / Save-Data | device | GPU    | load   | what stands                       |
 *   | shown      | off                        | passes | passes | ok     | live, framed as the seat's still  |
 *   | hidden     | any                        | any    | any    | none   | the field alone, nothing loads    |
 *   | shown      | on                         | any    | any    | none   | the still, nothing loads          |
 *   | shown      | off                        | 2 core | any    | none   | the still, nothing loads          |
 *   | shown      | off                        | passes | refuses| none   | the still (`gated`)               |
 *   | shown      | off                        | passes | passes | fails  | the still (`failed`), no retry    |
 * and: she plays the mood her still shows; turning reduced motion on drops her to the still at once and frees her
 * 30 s later; two panels share one model, the newest holding it while the other keeps its still; the window shown
 * again wakes her.
 */

import { act, cleanup, render } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fitKimm, kimmSeatFit } from "../kimm-fit.js";
import { createKimmLiveStage, KIMM_RELEASE_MS, KimmLiveStageContext, type KimmLiveStage } from "../kimm-live-stage.js";
import { KimmPanel } from "../KimmPanel.js";
import { KIMM_IDLE_FALLBACK_MS } from "../use-kimm-live.js";
import { fakeEmbedKit, flush, GOOD_GPU, type FakeEmbedKit } from "./fake-kimm-embed.js";

const still = vi.hoisted(() => ({ current: false }));
vi.mock("../../../../lib/motion/use-still-frame.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/motion/use-still-frame.js")>()),
  useStillFrame: () => still.current,
}));

let cores = 8;

beforeEach(() => {
  vi.useFakeTimers();
  still.current = false;
  cores = 8;
  vi.spyOn(navigator, "hardwareConcurrency", "get").mockImplementation(() => cores);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(gpu: () => { webgl2: boolean; maxTextureSize: number | undefined } = GOOD_GPU): {
  readonly kit: FakeEmbedKit;
  readonly stage: KimmLiveStage;
  readonly wrap: (node: ReactNode) => JSX.Element;
} {
  const kit = fakeEmbedKit();
  const stage = createKimmLiveStage({ live: { loaders: kit.loaders, page: kit.page, gpu } });
  const wrap = (node: ReactNode): JSX.Element => (
    <KimmLiveStageContext.Provider value={stage}>{node}</KimmLiveStageContext.Provider>
  );
  return { kit, stage, wrap };
}

function panelOf(container: HTMLElement, seat = "lock"): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-vex-area='kimm-panel'][data-kimm-seat='${seat}']`);
  if (el === null) throw new Error("her panel is missing");
  return el;
}

/** The renderer goes idle (jsdom has no `requestIdleCallback`: the 2 s fallback) and her load settles. */
async function idle(): Promise<void> {
  act(() => {
    vi.advanceTimersByTime(KIMM_IDLE_FALLBACK_MS);
  });
  await act(async () => {
    await flush();
  });
}

describe("KimmPanel, her live figure", () => {
  it("goes live in the lock seat, framed as the lock screen's still, her still kept under her for the fallback", async () => {
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure />));
    const panel = panelOf(view.container);
    expect(panel.getAttribute("data-kimm-live")).toBe("idle");
    expect(kit.loads).toBe(0);
    await idle();
    expect(panel.getAttribute("data-kimm-live")).toBe("live");
    expect(kit.mounts).toHaveLength(1);
    const embed = kit.mounts[0];
    const layer = panel.querySelector("[data-vex-area='kimm-live']");
    expect(embed?.el.parentElement).toBe(layer);
    const fit = embed?.options.fit ?? {};
    expect(fitKimm(720, 900, fit).s).toBeCloseTo(fitKimm(720, 900, kimmSeatFit("lock")).s, 9);
    expect(fitKimm(720, 900, fit).head).toBeCloseTo(fitKimm(720, 900, kimmSeatFit("lock")).head, 9);
    // the still stays mounted; the sheet hides it only while she is live
    expect(panel.querySelector("img.vex-kimm-panel__figure")?.getAttribute("src")).toBe("/art/kimm/still-rest.webp");
    // still decorative: nothing to focus or press
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("plays the mood her still shows, and only on a change", async () => {
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure />));
    await idle();
    const embed = kit.mounts[0];
    expect(embed?.events).toEqual(["idle"]);
    expect(embed?.moods).toEqual([{ name: "rest", ms: 0 }]);
    view.rerender(wrap(<KimmPanel mood="hi" figure />));
    expect(embed?.events.at(-1)).toBe("hi");
    expect(embed?.moods.at(-1)).toEqual({ name: "hi", ms: 0 });
    view.rerender(wrap(<KimmPanel mood="refused" figure />));
    expect(embed?.moods.at(-1)).toEqual({ name: "no", ms: 0 });
    const count = embed?.events.length;
    view.rerender(wrap(<KimmPanel mood="refused" figure />));
    expect(embed?.events.length).toBe(count);
  });

  it("with her figure hidden keeps the field alone and loads nothing", async () => {
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure={false} />));
    await idle();
    const panel = panelOf(view.container);
    expect(panel.getAttribute("data-kimm-live")).toBe("still");
    expect(panel.querySelector("img")).toBeNull();
    expect(kit.loads).toBe(0);
  });

  it("under reduced motion or Save-Data stands her still and loads nothing", async () => {
    still.current = true;
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="hi" figure />));
    await idle();
    const panel = panelOf(view.container);
    expect(panel.getAttribute("data-kimm-live")).toBe("still");
    expect(panel.querySelector("img.vex-kimm-panel__figure")).not.toBeNull();
    expect(kit.loads).toBe(0);
  });

  it("on a device under 4 cores stands her still and loads nothing", async () => {
    cores = 2;
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="hi" figure />));
    await idle();
    expect(panelOf(view.container).getAttribute("data-kimm-live")).toBe("still");
    expect(kit.loads).toBe(0);
  });

  it("on a GPU without WebGL2 or 4096 textures stands her still (gated)", async () => {
    const { kit, wrap } = setup(() => ({ webgl2: true, maxTextureSize: 2048 }));
    const view = render(wrap(<KimmPanel mood="hi" figure />));
    await idle();
    const panel = panelOf(view.container);
    expect(panel.getAttribute("data-kimm-live")).toBe("gated");
    expect(panel.querySelector("img.vex-kimm-panel__figure")).not.toBeNull();
    expect(kit.loads).toBe(0);
  });

  it("when her model fails to load stands her still, and never retries", async () => {
    const { kit, wrap } = setup();
    kit.autoReady = false;
    const view = render(wrap(<KimmPanel mood="hi" figure />));
    await idle();
    const panel = panelOf(view.container);
    expect(panel.getAttribute("data-kimm-live")).toBe("failed");
    expect(panel.querySelector("img.vex-kimm-panel__figure")).not.toBeNull();
    view.rerender(wrap(<KimmPanel mood="think" figure />));
    await idle();
    expect(kit.loads).toBe(1);
  });

  it("reduced motion turned on drops her to the still at once and frees her model 30 s later", async () => {
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure />));
    await idle();
    const embed = kit.mounts[0];
    still.current = true;
    view.rerender(wrap(<KimmPanel mood="rest" figure />));
    expect(panelOf(view.container).getAttribute("data-kimm-live")).toBe("still");
    expect(embed?.el.parentElement).toBeNull();
    expect(embed?.awake).toBe(false);
    expect(embed?.destroyed).toBe(false);
    act(() => {
      vi.advanceTimersByTime(KIMM_RELEASE_MS);
    });
    expect(embed?.destroyed).toBe(true);
  });

  it("shares one model between the lock screen and the card: the newest holds her, the other keeps its still", async () => {
    const { kit, wrap } = setup();
    const view = render(wrap(<>{[<KimmPanel key="lock" mood="rest" figure />]}</>));
    await idle();
    view.rerender(
      wrap(<>{[<KimmPanel key="lock" mood="rest" figure />, <KimmPanel key="card" mood="think" figure seat="card" />]}</>),
    );
    await idle();
    expect(kit.mounts).toHaveLength(1);
    const lock = panelOf(view.container, "lock");
    const card = panelOf(view.container, "card");
    expect(card.getAttribute("data-kimm-live")).toBe("live");
    expect(lock.getAttribute("data-kimm-live")).toBe("idle");
    const embed = kit.mounts[0];
    expect(embed?.el.parentElement).toBe(card.querySelector("[data-vex-area='kimm-live']"));
    expect(embed?.moods.at(-1)).toEqual({ name: "think", ms: 0 });
    // the lock screen leaves: she stays in the card
    view.rerender(wrap(<>{[<KimmPanel key="card" mood="think" figure seat="card" />]}</>));
    expect(panelOf(view.container, "card").getAttribute("data-kimm-live")).toBe("live");
    expect(kit.mounts).toHaveLength(1);
    expect(embed?.el.parentElement).toBe(panelOf(view.container, "card").querySelector("[data-vex-area='kimm-live']"));
  });

  it("wakes when the window is shown again", async () => {
    const { kit, wrap } = setup();
    render(wrap(<KimmPanel mood="rest" figure />));
    await idle();
    const embed = kit.mounts[0];
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(embed?.awake).toBe(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(embed?.awake).toBe(true);
  });

  it("lively on the lock screen: she never sleeps, the field takes its lively tempo, the motes rise", async () => {
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure lively />));
    const panel = panelOf(view.container);
    expect(panel.getAttribute("data-kimm-lively")).toBe("waiting");
    // nothing lively before her live figure stands
    expect(panel.querySelector("[data-vex-area='kimm-motes']")).toBeNull();
    expect(panel.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-tempo")).toBe("calm");
    await idle();
    expect(panel.getAttribute("data-kimm-lively")).toBe("on");
    const embed = kit.mounts[0];
    expect(embed?.options.lively).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(embed?.awake).toBe(true);
    expect(panel.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-tempo")).toBe("lively");
    const motes = panel.querySelector("[data-vex-area='kimm-motes']");
    expect(motes?.getAttribute("data-kimm-motes-running")).toBe("true");
    expect(motes?.getAttribute("data-kimm-motes-fps")).toBe("30");
  });

  it("the card never asks: calm, asleep after 12 s, no motes, the calm field", async () => {
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure seat="card" />));
    await idle();
    const panel = panelOf(view.container, "card");
    expect(panel.getAttribute("data-kimm-live")).toBe("live");
    expect(panel.getAttribute("data-kimm-lively")).toBe("off");
    expect(kit.mounts[0]?.options.lively).toBe(false);
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(kit.mounts[0]?.awake).toBe(false);
    expect(panel.querySelector("[data-vex-area='kimm-motes']")).toBeNull();
    expect(panel.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-tempo")).toBe("calm");
  });

  it("reduced motion turns all of the lively mode off: her still, the calm field, no motes, nothing loaded", async () => {
    still.current = true;
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure lively />));
    await idle();
    const panel = panelOf(view.container);
    expect(panel.getAttribute("data-kimm-live")).toBe("still");
    expect(panel.getAttribute("data-kimm-lively")).toBe("waiting");
    expect(panel.querySelector("[data-vex-area='kimm-motes']")).toBeNull();
    expect(panel.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-tempo")).toBe("calm");
    expect(kit.loads).toBe(0);
  });

  it("the motes and the field stop with her: a hidden window stops them, her still standing takes them away", async () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const { wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure lively />));
    await idle();
    const panel = panelOf(view.container);
    const motes = () => panel.querySelector("[data-vex-area='kimm-motes']");
    expect(motes()?.getAttribute("data-kimm-motes-running")).toBe("true");
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(motes()?.getAttribute("data-kimm-motes-running")).toBe("false");
    expect(panel.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-running")).toBe("false");
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(motes()?.getAttribute("data-kimm-motes-running")).toBe("true");
    still.current = true;
    view.rerender(wrap(<KimmPanel mood="rest" figure lively />));
    expect(motes()).toBeNull();
    expect(panel.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-tempo")).toBe("calm");
  });

  it("unmounted, lets her go: her canvas leaves at once and her model 30 s later", async () => {
    const { kit, wrap } = setup();
    const view = render(wrap(<KimmPanel mood="rest" figure />));
    await idle();
    const embed = kit.mounts[0];
    view.unmount();
    expect(embed?.el.parentElement).toBeNull();
    act(() => {
      vi.advanceTimersByTime(KIMM_RELEASE_MS);
    });
    expect(embed?.destroyed).toBe(true);
  });
});
