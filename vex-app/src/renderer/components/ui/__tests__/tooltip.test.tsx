/**
 * Tooltip tests: sided rendering, hover/focus trigger independence, hover
 * delay, and the disabled prop dropping a visible bubble.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tooltip } from "../tooltip.js";

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom rects are all zero, which the viewport-fit pass reads as "no room
  // above" and flips top -> bottom; give every element a real mid-viewport
  // rect so the requested side survives the fit.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    top: 100,
    bottom: 120,
    left: 100,
    right: 140,
    width: 40,
    height: 20,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function anchorButton(): HTMLElement {
  return screen.getByRole("button", { name: "anchor" });
}

describe("Tooltip", () => {
  it.each(["top", "bottom", "left", "right"] as const)(
    "renders the bubble on side %s with the side stamped",
    (side) => {
      render(
        <Tooltip label="hint" side={side}>
          <button type="button">anchor</button>
        </Tooltip>,
      );
      fireEvent.mouseEnter(anchorButton());
      const bubble = screen.getByRole("tooltip");
      expect(bubble.textContent).toBe("hint");
      expect(bubble.getAttribute("data-side")).toBe(side);
      fireEvent.mouseLeave(anchorButton());
      expect(screen.queryByRole("tooltip")).toBeNull();
    },
  );

  it("delays hover show but keeps keyboard focus immediate", () => {
    render(
      <Tooltip label="hint" delayMs={300}>
        <button type="button">anchor</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(anchorButton());
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("tooltip")).not.toBeNull();
    fireEvent.mouseLeave(anchorButton());
    fireEvent.focus(anchorButton());
    expect(screen.getByRole("tooltip")).not.toBeNull();
  });

  it("hides only after both hover and focus clear", () => {
    render(
      <Tooltip label="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    );
    fireEvent.focus(anchorButton());
    fireEvent.mouseEnter(anchorButton());
    fireEvent.mouseLeave(anchorButton());
    // mouseLeave drops the bubble outright; a still-focused anchor re-shows
    // on the next focus event, but hide-on-blur must respect focus state.
    fireEvent.focus(anchorButton());
    expect(screen.getByRole("tooltip")).not.toBeNull();
    fireEvent.blur(anchorButton());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("drops a visible bubble when disabled flips true", () => {
    const { rerender } = render(
      <Tooltip label="hint">
        <button type="button">anchor</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(anchorButton());
    expect(screen.getByRole("tooltip")).not.toBeNull();
    rerender(
      <Tooltip label="hint" disabled>
        <button type="button">anchor</button>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
