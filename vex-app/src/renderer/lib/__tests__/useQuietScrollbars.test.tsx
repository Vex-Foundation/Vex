import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import {
  SCROLLBAR_LINGER_MS,
  useQuietScrollbars,
} from "../useQuietScrollbars.js";

function columnRef(rect: Partial<DOMRect> = {}) {
  const el = document.createElement("aside");
  el.getBoundingClientRect = () =>
    ({ left: 0, right: 280, top: 0, bottom: 800, ...rect }) as DOMRect;
  const ref = createRef<HTMLElement>();
  (ref as { current: HTMLElement | null }).current = el;
  return ref;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useQuietScrollbars", () => {
  it("starts quiet and reveals the bars on pointer enter", () => {
    const { result } = renderHook(() => useQuietScrollbars(columnRef()));
    expect(result.current.quiet).toBe(true);
    act(() => result.current.onPointerEnter());
    expect(result.current.quiet).toBe(false);
  });

  it("leaving only ARMS a linger: the bars stay for 2s, then go quiet", () => {
    const { result } = renderHook(() => useQuietScrollbars(columnRef()));
    act(() => result.current.onPointerEnter());
    act(() => result.current.onPointerLeave());
    act(() => vi.advanceTimersByTime(SCROLLBAR_LINGER_MS - 1));
    expect(result.current.quiet).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.quiet).toBe(true);
  });

  it("returning within the linger cancels the pending hide", () => {
    const { result } = renderHook(() => useQuietScrollbars(columnRef()));
    act(() => result.current.onPointerEnter());
    act(() => result.current.onPointerLeave());
    act(() => vi.advanceTimersByTime(SCROLLBAR_LINGER_MS - 10));
    act(() => result.current.onPointerEnter());
    act(() => vi.advanceTimersByTime(SCROLLBAR_LINGER_MS * 2));
    expect(result.current.quiet).toBe(false);
  });

  it("a pointermove outside the column BOX arms the linger even without a leave event (portaled overlays swallow pointerleave)", () => {
    const ref = columnRef();
    const { result } = renderHook(() => useQuietScrollbars(ref));
    act(() => result.current.onPointerEnter());
    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 900, clientY: 100 }),
      );
    });
    act(() => vi.advanceTimersByTime(SCROLLBAR_LINGER_MS));
    expect(result.current.quiet).toBe(true);
  });

  it("a pointermove back inside the box cancels an armed linger", () => {
    const ref = columnRef();
    const { result } = renderHook(() => useQuietScrollbars(ref));
    act(() => result.current.onPointerEnter());
    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 900, clientY: 100 }),
      );
    });
    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 100, clientY: 100 }),
      );
    });
    act(() => vi.advanceTimersByTime(SCROLLBAR_LINGER_MS * 2));
    expect(result.current.quiet).toBe(false);
  });
});
