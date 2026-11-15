/**
 * Where her live figure stands (`kimm-live-stage.ts`): one model for the renderer, held by the newest seat, playing
 * that seat's mood, freed 30 s after the last seat leaves. Driven with a stand-in embed and GPU.
 *
 * Regressions this catches:
 *   - a second model for a second panel (the lock screen and the card are both mounted during the curtain);
 *   - her canvas left in a panel that left, or not handed back to the one that stayed;
 *   - a model that arrives at rest when her still shows another mood, or plays a panel's mood that does not hold her;
 *   - her model kept with no panel (160 MB of GPU memory), or freed while a panel came back within the 30 s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKimmLiveStage, KIMM_RELEASE_MS } from "../kimm-live-stage.js";
import { fakeEmbedKit, flush, GOOD_GPU } from "./fake-kimm-embed.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function stageWith() {
  const kit = fakeEmbedKit();
  const stage = createKimmLiveStage({ live: { loaders: kit.loaders, page: kit.page, gpu: GOOD_GPU } });
  return { kit, stage };
}

describe("the live stage", () => {
  it("does not load her without a seat", async () => {
    const { kit, stage } = stageWith();
    stage.start();
    await flush();
    expect(kit.loads).toBe(0);
    expect(stage.status).toBe("idle");
  });

  it("goes live in the seat's mood: the cue's event, then the mood held with no end", async () => {
    const { kit, stage } = stageWith();
    const layer = document.createElement("div");
    const seat = stage.seat(layer, {}, "hi");
    expect(seat.holds).toBe(true);
    expect(stage.holds(layer)).toBe(true);
    stage.start();
    await flush();
    expect(stage.status).toBe("live");
    const embed = kit.mounts[0];
    expect(embed?.el.parentElement).toBe(layer);
    expect(embed?.events).toEqual(["hi"]);
    expect(embed?.moods).toEqual([{ name: "hi", ms: 0 }]);
    seat.mood("signed");
    expect(embed?.events.at(-1)).toBe("done");
    expect(embed?.moods.at(-1)).toEqual({ name: "v", ms: 0 });
    seat.mood("held");
    expect(embed?.events.at(-1)).toBe("wait");
    expect(embed?.moods.at(-1)).toEqual({ name: "offer", ms: 0 });
    // the same mood again plays nothing
    const count = embed?.events.length;
    seat.mood("held");
    expect(embed?.events.length).toBe(count);
  });

  it("one model for two panels: the newest holds her, and she goes back when it leaves", async () => {
    const { kit, stage } = stageWith();
    const lock = document.createElement("div");
    const card = document.createElement("div");
    const lockSeat = stage.seat(lock, {}, "rest");
    stage.start();
    await flush();
    const cardSeat = stage.seat(card, { headroom: 48 }, "think");
    expect(kit.mounts).toHaveLength(1);
    const embed = kit.mounts[0];
    expect(embed?.el.parentElement).toBe(card);
    expect(lockSeat.holds).toBe(false);
    expect(cardSeat.holds).toBe(true);
    expect(embed?.moods.at(-1)).toEqual({ name: "think", ms: 0 });
    // a panel that does not hold her plays nothing
    const count = embed?.events.length;
    lockSeat.mood("refused");
    expect(embed?.events.length).toBe(count);
    cardSeat.release();
    expect(embed?.el.parentElement).toBe(lock);
    expect(lockSeat.holds).toBe(true);
    expect(embed?.moods.at(-1)).toEqual({ name: "no", ms: 0 });
    lockSeat.release();
    expect(embed?.el.parentElement).toBeNull();
    expect(embed?.destroyed).toBe(false);
    vi.advanceTimersByTime(KIMM_RELEASE_MS);
    expect(embed?.destroyed).toBe(true);
    expect(stage.status).toBe("idle");
  });

  it("a seat taken within 30 s keeps her model", async () => {
    const { kit, stage } = stageWith();
    const first = stage.seat(document.createElement("div"), {}, "rest");
    stage.start();
    await flush();
    first.release();
    vi.advanceTimersByTime(KIMM_RELEASE_MS - 1);
    const next = document.createElement("div");
    stage.seat(next, {}, "rest");
    vi.advanceTimersByTime(KIMM_RELEASE_MS * 2);
    expect(kit.mounts[0]?.destroyed).toBe(false);
    expect(kit.mounts[0]?.el.parentElement).toBe(next);
    expect(kit.mounts).toHaveLength(1);
  });

  it("tells its listeners when her status or her holder changes", async () => {
    const { stage } = stageWith();
    const heard = vi.fn();
    const stop = stage.subscribe(heard);
    const seat = stage.seat(document.createElement("div"), {}, "rest");
    expect(heard).toHaveBeenCalled();
    heard.mockClear();
    stage.start();
    await flush();
    expect(heard).toHaveBeenCalled();
    heard.mockClear();
    seat.release();
    expect(heard).toHaveBeenCalled();
    stop();
    heard.mockClear();
    stage.destroy();
    expect(heard).not.toHaveBeenCalled();
  });

  it("a failure stays: every later start is refused and no seat makes her live", async () => {
    const { kit, stage } = stageWith();
    kit.autoReady = false;
    const seat = stage.seat(document.createElement("div"), {}, "rest");
    stage.start();
    await flush();
    expect(stage.status).toBe("failed");
    seat.release();
    stage.seat(document.createElement("div"), {}, "rest");
    stage.start();
    await flush();
    expect(kit.loads).toBe(1);
    expect(stage.status).toBe("failed");
  });
});
