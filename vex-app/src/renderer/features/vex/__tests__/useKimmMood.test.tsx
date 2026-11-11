/**
 * Her mood, held as VEX Cloud holds it (`useKimmMood.ts`): a money call's end
 * shows signed for 2.8 s after a fill and refused for 3.4 s after a refusal
 * or an error, then she rests; every other reading stands; a new reading
 * clears the hold, and a new end starts its own.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KimmMoodOptions } from "../kimm-mood.js";
import { useKimmMood } from "../useKimmMood.js";
import type { VexState } from "../vex-state.js";

interface Reading {
  readonly state: VexState;
  readonly options?: KimmMoodOptions;
}

function mount(first: Reading) {
  return renderHook(({ state, options }: Reading) => useKimmMood(state, options), { initialProps: first });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useKimmMood", () => {
  it("shows signed for 2.8 s after a fill, then rests", () => {
    const view = mount({ state: "done", options: { outcome: "filled" } });
    expect(view.result.current).toBe("signed");
    act(() => vi.advanceTimersByTime(2799));
    expect(view.result.current).toBe("signed");
    act(() => vi.advanceTimersByTime(1));
    expect(view.result.current).toBe("rest");
  });

  it("shows refused for 3.4 s after an error or a refusal, then rests", () => {
    const view = mount({ state: "error", options: { outcome: "failed" } });
    expect(view.result.current).toBe("refused");
    act(() => vi.advanceTimersByTime(3399));
    expect(view.result.current).toBe("refused");
    act(() => vi.advanceTimersByTime(1));
    expect(view.result.current).toBe("rest");
    view.rerender({ state: "done", options: { outcome: "refused" } });
    expect(view.result.current).toBe("refused");
    act(() => vi.advanceTimersByTime(3400));
    expect(view.result.current).toBe("rest");
  });

  it("holds every other reading as long as it stands", () => {
    const view = mount({ state: "working", options: { approved: true } });
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.result.current).toBe("offer");
    view.rerender({ state: "error", options: { seat: "panel" } });
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.result.current).toBe("refused");
  });

  it("drops the hold when the reading changes, and a new end starts its own", () => {
    const view = mount({ state: "done", options: { outcome: "filled" } });
    act(() => vi.advanceTimersByTime(1000));
    view.rerender({ state: "thinking" });
    expect(view.result.current).toBe("think");
    act(() => vi.advanceTimersByTime(5000));
    expect(view.result.current).toBe("think");
    view.rerender({ state: "done", options: { outcome: "filled" } });
    expect(view.result.current).toBe("signed");
    act(() => vi.advanceTimersByTime(2800));
    expect(view.result.current).toBe("rest");
  });
});
