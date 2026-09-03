/**
 * SplitPane: the geometry, then the two input paths that must agree with it.
 *
 * The arithmetic is tested directly because that is where the risk actually
 * lives - jsdom has no layout engine, so a test that only dragged would be
 * asserting against sizes it fabricated anyway. The component tests then prove
 * the two INPUT PATHS reach that arithmetic: a pointer drag and the keyboard,
 * which is not a nicety here - a split that only resizes by dragging is a split
 * a keyboard user cannot resize at all.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resizeSplitPaneSizes, SplitPane, SPLIT_PANE_KEYBOARD_STEP } from "../split-pane.js";

/** jsdom implements neither pointer capture nor layout; both are stubbed. */
beforeEach(() => {
  for (const name of ["setPointerCapture", "releasePointerCapture"] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
  }
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    writable: true,
    value: () => true,
  });
});

/** The strip carries `className="strip"` in every test that needs a box. */
function sizeContainer(width: number): void {
  const strip = document.querySelector(".strip");
  if (strip === null) throw new Error("no strip rendered");
  Object.defineProperty(strip, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width,
      height: 400,
      left: 0,
      top: 0,
      right: width,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

describe("resizeSplitPaneSizes", () => {
  it("transfers between the dragged pane and its RIGHT neighbour only", () => {
    const next = resizeSplitPaneSizes([0.25, 0.25, 0.5], 0, 0.4);
    // The third pane is not touched: a splitter moves the two panes it sits
    // between, never content the user is not dragging.
    expect(next[0]).toBeCloseTo(0.4);
    expect(next[1]).toBeCloseTo(0.1);
    expect(next[2]).toBeCloseTo(0.5);
    expect(next.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1);
  });

  it("INVERTS at the end pane, trading with the neighbour on its LEFT", () => {
    // The end pane has no right neighbour. Without the inversion this resize
    // has no partner and either does nothing or renormalizes the whole axis -
    // and `workspace-model.ts:resizePane` applies the same inversion, so a drag
    // and a restore must not be able to disagree about the same gesture.
    const next = resizeSplitPaneSizes([0.5, 0.2, 0.3], 2, 0.5);
    expect(next).toEqual([0.5, 0, 0.5]);
    expect(next.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1);
  });

  it("CLAMPS at the pooled share rather than producing a negative one", () => {
    expect(resizeSplitPaneSizes([0.3, 0.2, 0.5], 0, 5)).toEqual([0.5, 0, 0.5]);
    expect(resizeSplitPaneSizes([0.3, 0.2, 0.5], 0, -5)).toEqual([0, 0.5, 0.5]);
  });

  it("honours the minimum on BOTH sides of the separator", () => {
    const next = resizeSplitPaneSizes([0.5, 0.5, 0], 0, 0.99, 0.1);
    expect(next[0]).toBeCloseTo(0.9);
    expect(next[1]).toBeCloseTo(0.1);
  });

  it("leaves an axis it cannot resize exactly as it was", () => {
    expect(resizeSplitPaneSizes([1], 0, 0.5)).toEqual([1]);
    expect(resizeSplitPaneSizes([0.5, 0.5], 7, 0.2)).toEqual([0.5, 0.5]);
    expect(resizeSplitPaneSizes([0.5, 0.5], 0, Number.NaN)).toEqual([0.5, 0.5]);
  });

  it("does not mutate the array it was given", () => {
    const original = [0.5, 0.5];
    resizeSplitPaneSizes(original, 0, 0.2);
    expect(original).toEqual([0.5, 0.5]);
  });
});

describe("SplitPane input paths", () => {
  it("resizes on a pointer drag, in the proportion the pointer moved", () => {
    const onResize = vi.fn();
    render(
      <SplitPane orientation="horizontal" sizes={[0.5, 0.5]} onResize={onResize} className="strip">
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );
    sizeContainer(1000);

    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 700, pointerId: 1 });

    // 200px of a 1000px axis is 0.2 of the share, taken from the right pane.
    const dragged = onResize.mock.lastCall?.[0] ?? [];
    expect(dragged[0]).toBeCloseTo(0.7);
    expect(dragged[1]).toBeCloseTo(0.3);

    fireEvent.pointerUp(separator, { pointerId: 1 });
    onResize.mockClear();
    fireEvent.pointerMove(separator, { clientX: 900, pointerId: 1 });
    // The drag ended; a stray move must not keep resizing.
    expect(onResize).not.toHaveBeenCalled();
  });

  /**
   * THE SEAM STAYS LIT FOR THE WHOLE DRAG.
   *
   * The defect this guards is invisible in a screenshot and obvious in the
   * hand: pointer capture pulls the cursor off the 8px strip within a few
   * pixels, so a `:hover`-only highlight goes dark the instant the drag starts.
   * VS Code's sash carries a separate `.active` state for exactly this, and
   * `data-dragging` is ours. Asserted on the ATTRIBUTE rather than on a
   * computed colour, because jsdom does not resolve Tailwind variants and the
   * attribute is the contract the stylesheet keys off.
   */
  it("marks the separator as dragging for the whole drag, and clears it after", () => {
    render(
      <SplitPane orientation="horizontal" sizes={[0.5, 0.5]} onResize={vi.fn()} className="strip">
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );
    sizeContainer(1000);

    const separator = screen.getByRole("separator");
    expect(separator.hasAttribute("data-dragging")).toBe(false);

    fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 1 });
    expect(separator.hasAttribute("data-dragging")).toBe(true);
    fireEvent.pointerMove(separator, { clientX: 700, pointerId: 1 });
    expect(separator.hasAttribute("data-dragging")).toBe(true);

    fireEvent.pointerUp(separator, { pointerId: 1 });
    expect(separator.hasAttribute("data-dragging")).toBe(false);
  });

  it("clears the dragging mark when the pointer is CANCELLED, not only on up", () => {
    // A cancelled pointer (the OS took it, a touch became a scroll) ends the
    // drag through the same handler; a seam left lit afterwards would advertise
    // a drag that is not happening.
    render(
      <SplitPane orientation="horizontal" sizes={[0.5, 0.5]} onResize={vi.fn()} className="strip">
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );
    sizeContainer(1000);

    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerCancel(separator, { pointerId: 1 });
    expect(separator.hasAttribute("data-dragging")).toBe(false);
  });

  it("does not mark a non-primary press as a drag", () => {
    render(
      <SplitPane orientation="horizontal" sizes={[0.5, 0.5]} onResize={vi.fn()} className="strip">
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );
    sizeContainer(1000);

    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { button: 2, clientX: 500, pointerId: 1 });
    expect(separator.hasAttribute("data-dragging")).toBe(false);
  });

  it("ignores a non-primary button, so a context menu does not resize", () => {
    const onResize = vi.fn();
    render(
      <SplitPane orientation="horizontal" sizes={[0.5, 0.5]} onResize={onResize} className="strip">
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );
    sizeContainer(1000);

    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { button: 2, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 700, pointerId: 1 });

    expect(onResize).not.toHaveBeenCalled();
  });

  it("resizes from the KEYBOARD, in both directions and to both extremes", () => {
    const onResize = vi.fn();
    render(
      <SplitPane
        orientation="horizontal"
        sizes={[0.5, 0.5]}
        onResize={onResize}
        minPaneSize={0}
      >
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );
    const separator = screen.getByRole("separator");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onResize.mock.lastCall?.[0]?.[0]).toBeCloseTo(0.5 + SPLIT_PANE_KEYBOARD_STEP);

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onResize.mock.lastCall?.[0]?.[0]).toBeCloseTo(0.5 - SPLIT_PANE_KEYBOARD_STEP);

    fireEvent.keyDown(separator, { key: "End" });
    expect(onResize.mock.lastCall?.[0]).toEqual([1, 0]);

    fireEvent.keyDown(separator, { key: "Home" });
    expect(onResize.mock.lastCall?.[0]).toEqual([0, 1]);
  });

  it("uses the VERTICAL arrow keys when the panes are stacked", () => {
    const onResize = vi.fn();
    render(
      <SplitPane orientation="vertical" sizes={[0.5, 0.5]} onResize={onResize} className="strip">
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );
    const separator = screen.getByRole("separator");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onResize).not.toHaveBeenCalled();

    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(onResize.mock.lastCall?.[0]?.[0]).toBeCloseTo(0.5 + SPLIT_PANE_KEYBOARD_STEP);
  });

  it("carries the separator semantics a screen reader needs", () => {
    render(
      <SplitPane
        orientation="horizontal"
        sizes={[0.75, 0.25]}
        onResize={() => undefined}
        separatorLabel={() => "Resize the shell"}
      >
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );

    const separator = screen.getByRole("separator", { name: "Resize the shell" });
    // Panes side by side means the separator itself is a VERTICAL bar.
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuenow")).toBe("75");
    expect(separator.tabIndex).toBe(0);
  });

  it("renders one separator BETWEEN each pair, never after the last pane", () => {
    render(
      <SplitPane
        orientation="horizontal"
        sizes={[0.4, 0.3, 0.3]}
        onResize={() => undefined}
      >
        {[<div key="a">A</div>, <div key="b">B</div>, <div key="c">C</div>]}
      </SplitPane>,
    );
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("moves nothing when the axis has no measurable length", () => {
    const onResize = vi.fn();
    render(
      <SplitPane orientation="horizontal" sizes={[0.5, 0.5]} onResize={onResize} className="strip">
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </SplitPane>,
    );
    // No stubbed box: jsdom reports 0x0, so a pixel delta has no scale to
    // convert with. Guessing one would jump the layout.
    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 400, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });
});
