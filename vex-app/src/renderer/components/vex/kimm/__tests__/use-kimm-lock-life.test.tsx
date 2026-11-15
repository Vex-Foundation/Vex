/**
 * The lock screen's life, the wiring (`use-kimm-lock-life.ts`; owner decision 2026-11-15), with a recording `react`
 * and a mocked local clock.
 *
 * Regressions this catches:
 *   - a greeting on every lock screen (it is once a launch), or none after a long hide (10 minutes or more);
 *   - sleepiness before 45 s alone, or a pointer or key that does not wake her;
 *   - the night read wrongly from the local clock, or not followed across 22:00;
 *   - the field's focus forgotten while she is not yet live;
 *   - the screen's words told to her while she is not live, or with anything but a point for typing and focus.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKimmLockSignals } from "../kimm-lock-signals.js";
import {
  KIMM_GREET_AFTER_HIDDEN_MS,
  KIMM_SLEEP_AFTER_MS,
  kimmIsNight,
  resetKimmLockLifeMemory,
  useKimmLockLife,
} from "../use-kimm-lock-life.js";

let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 15, 12, 0, 0));
  resetKimmLockLifeMemory();
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(active = true) {
  const calls: Array<{ signal: string; at: unknown }> = [];
  const react = (signal: string, at?: unknown) => {
    calls.push({ signal, at });
  };
  const layer = document.createElement("div");
  const signals = createKimmLockSignals();
  const view = renderHook(
    ({ on }: { on: boolean }) => useKimmLockLife({ active: on, signals, react, layerRef: { current: layer } }),
    { initialProps: { on: active } },
  );
  const said = () => calls.map((call) => call.signal);
  return { view, calls, said, signals };
}

describe("the night by the local clock", () => {
  it("is 22:00 to 06:00", () => {
    expect(kimmIsNight(new Date(2026, 10, 15, 21, 59))).toBe(false);
    expect(kimmIsNight(new Date(2026, 10, 15, 22, 0))).toBe(true);
    expect(kimmIsNight(new Date(2026, 10, 16, 5, 59))).toBe(true);
    expect(kimmIsNight(new Date(2026, 10, 16, 6, 0))).toBe(false);
  });
});

describe("useKimmLockLife", () => {
  it("greets once a launch, never on a later lock screen", () => {
    const first = mount();
    expect(first.said()).toEqual(["day", "greet"]);
    first.view.unmount();
    const second = mount();
    expect(second.said()).toEqual(["day"]);
  });

  it("greets again when shown after 10 minutes hidden, not after 5", () => {
    const { said } = mount();
    const greets = () => said().filter((word) => word === "greet").length;
    expect(greets()).toBe(1);
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(greets()).toBe(1);
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => {
      vi.advanceTimersByTime(KIMM_GREET_AFTER_HIDDEN_MS);
    });
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(greets()).toBe(2);
  });

  it("becomes sleepy after 45 s alone, and a pointer or a key wakes her", () => {
    const { view, said } = mount();
    act(() => {
      vi.advanceTimersByTime(KIMM_SLEEP_AFTER_MS - 2000);
    });
    expect(view.result.current.sleepy).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.result.current.sleepy).toBe(true);
    expect(said()).toContain("sleep");
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
    });
    expect(view.result.current.sleepy).toBe(false);
    expect(said().at(-1)).toBe("wake");
    act(() => {
      vi.advanceTimersByTime(KIMM_SLEEP_AFTER_MS);
    });
    expect(view.result.current.sleepy).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });
    expect(view.result.current.sleepy).toBe(false);
  });

  it("measures her time alone on the monotonic clock: a wall clock that stands still or jumps changes nothing", () => {
    // the wall clock pinned (as the H3 harness pins it) while time passes
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 10, 15, 12, 0, 0).getTime());
    const { view } = mount();
    act(() => {
      vi.advanceTimersByTime(KIMM_SLEEP_AFTER_MS);
    });
    expect(view.result.current.sleepy).toBe(true);
  });

  it("keeps her awake while keys go in", () => {
    const { view, signals } = mount();
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        vi.advanceTimersByTime(10_000);
        signals.emit("typing");
      });
    }
    expect(view.result.current.sleepy).toBe(false);
  });

  it("is calmer at night by the mocked clock, and follows the clock across 22:00", () => {
    vi.setSystemTime(new Date(2026, 10, 15, 23, 30));
    const late = mount();
    expect(late.said()[0]).toBe("night");
    expect(late.view.result.current.night).toBe(true);
    late.view.unmount();
    vi.setSystemTime(new Date(2026, 10, 15, 21, 59, 58));
    const evening = mount();
    expect(evening.view.result.current.night).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(evening.view.result.current.night).toBe(true);
    expect(evening.said()).toContain("night");
  });

  it("remembers the field's focus until she is live, and tells her the words only while she is", () => {
    const { view, calls, signals } = mount(false);
    act(() => signals.emit("focus"));
    act(() => signals.emit("failed"));
    expect(calls).toEqual([]);
    view.rerender({ on: true });
    const focus = calls.find((call) => call.signal === "focus");
    expect(focus?.at).toMatchObject({ y: window.innerHeight * 0.55 });
    act(() => signals.emit("shown"));
    expect(calls.at(-1)).toEqual({ signal: "shown", at: undefined });
    view.rerender({ on: false });
    const before = calls.length;
    act(() => signals.emit("hidden"));
    expect(calls.length).toBe(before);
    expect(view.result.current).toEqual({ sleepy: false, night: false });
  });
});
