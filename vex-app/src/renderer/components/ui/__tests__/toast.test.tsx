/**
 * Toast + ToastHost tests: timed lifecycle, the CSS/TSX timing invariant
 * (HOLD_MS/FADE_MS must equal the stylesheet's fade delay/duration), tones,
 * and the store's replace/clear semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { FADE_MS, HOLD_MS, Toast } from "../toast.js";
import { ToastHost } from "../toast-host.js";
import { clearToast, getToastSnapshot, showToast } from "../../../lib/toast.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain any live toast so store state never leaks between tests.
  const current = getToastSnapshot();
  if (current !== null) clearToast(current.id);
  cleanup();
  vi.useRealTimers();
});

describe("Toast", () => {
  it("renders an alert and reports done after HOLD_MS + FADE_MS", () => {
    const onDone = vi.fn();
    render(<Toast text="Saved" onDone={onDone} />);
    expect(screen.getByRole("alert").textContent).toBe("Saved");
    act(() => vi.advanceTimersByTime(HOLD_MS + FADE_MS - 1));
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("marks the tone and shows the leading glyph only for non-neutral tones", () => {
    const { rerender } = render(
      <Toast text="x" tone="warning" onDone={() => {}} />,
    );
    const warning = screen.getByRole("alert");
    expect(warning.getAttribute("data-tone")).toBe("warning");
    expect(warning.querySelector(".vex-toast-icon")).not.toBeNull();
    rerender(<Toast text="x" onDone={() => {}} />);
    const neutral = screen.getByRole("alert");
    expect(neutral.getAttribute("data-tone")).toBe("neutral");
    expect(neutral.querySelector(".vex-toast-icon")).toBeNull();
  });

  it("pins the timing constants the stylesheet fade must mirror", () => {
    // The CSS side (ui-primitives.css: `vex-toast-fade 1000ms ease 3000ms
    // forwards`) cannot be read here - the renderer test pipeline empties
    // .css imports, including ?raw - so this pin plus the INVARIANT
    // comments on both sides is the guard: changing either constant fails
    // here and points at the stylesheet.
    expect(HOLD_MS).toBe(3000);
    expect(FADE_MS).toBe(1000);
  });
});

describe("ToastHost + store", () => {
  it("shows, replaces, and clears toasts from the store", () => {
    render(<ToastHost />);
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => showToast("first"));
    expect(screen.getByRole("alert").textContent).toBe("first");

    act(() => showToast("second", { tone: "error" }));
    const replaced = screen.getByRole("alert");
    expect(replaced.textContent).toBe("second");
    expect(replaced.getAttribute("data-tone")).toBe("error");

    act(() => vi.advanceTimersByTime(HOLD_MS + FADE_MS));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getToastSnapshot()).toBeNull();
  });

  it("ignores a stale clear for an already-replaced toast", () => {
    render(<ToastHost />);
    act(() => showToast("first"));
    const first = getToastSnapshot()!;
    act(() => showToast("second"));
    act(() => clearToast(first.id));
    expect(screen.getByRole("alert").textContent).toBe("second");
  });
});
