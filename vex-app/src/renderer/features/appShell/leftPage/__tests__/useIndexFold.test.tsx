/**
 * The index fold: no row is drawn across the horizon, a group head never
 * stands alone above it, and the fold counts the rows below
 * (docs/design/V10-SPREAD.md section 3: 1280 x 800 holds 5 of 7 rows and
 * shows `2 more`). jsdom has no layout, so each element reports the box its
 * `data-y` and `data-h` describe.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexFold } from "../SessionIndex.js";
import { useIndexFold } from "../useIndexFold.js";

function rectOf(el: Element): DOMRect {
  const y = Number(el.getAttribute("data-y") ?? 0);
  const h = Number(el.getAttribute("data-h") ?? 0);
  return {
    x: 0,
    y,
    top: y,
    bottom: y + h,
    left: 0,
    right: 264,
    width: 264,
    height: h,
    toJSON: () => ({}),
  };
}

/** The 1280 x 800 sky: a 191px index, the DG session list's seven rows. */
const ITEMS: ReadonlyArray<readonly ["head" | "row", string, number, number]> = [
  ["head", "Pinned", 0, 17],
  ["row", "Research TAO", 17, 26],
  ["head", "Today", 43, 17],
  ["row", "Swap ETH to USDC on Base", 60, 26],
  ["row", "Arbitrum LP Rebalance", 86, 26],
  ["row", "Agent session", 112, 26],
  ["head", "Yesterday", 138, 17],
  ["row", "Open BTC Perp Position", 155, 26],
  ["head", "Older", 181, 17],
  ["row", "Portfolio Check", 198, 26],
  ["row", "Daily gas report", 224, 26],
];

function Harness({ height }: { readonly height: number }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const fold = useIndexFold(ref, height, null);
  return (
    <>
      <div ref={ref} data-testid="scroller" data-y={0} data-h={height}>
        {ITEMS.map(([kind, text, y, h]) => (
          <div key={text} data-vex-ix-item={kind} data-y={y} data-h={h}>
            {text}
          </div>
        ))}
      </div>
      <IndexFold hidden={fold.hiddenBelow} onPageDown={fold.pageDown} />
    </>
  );
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return rectOf(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const folded = (): string[] =>
  Array.from(document.querySelectorAll("[data-vex-folded]")).map((el) => el.textContent ?? "");

describe("useIndexFold", () => {
  it("hides the rows the horizon would cut, the head above them, and counts them on the fold", () => {
    render(<Harness height={191} />);
    expect(folded()).toEqual(["Older", "Portfolio Check", "Daily gas report"]);
    const fold = screen.getByRole("button", { name: "Show 2 more sessions" });
    expect(fold.textContent).toContain("2");
    expect(fold.textContent).toContain("more");
  });

  it("draws everything and no fold when the sky holds the whole index", () => {
    render(<Harness height={270} />);
    expect(folded()).toEqual([]);
    expect(screen.queryByRole("button", { name: /more session/ })).toBeNull();
  });

  it("scrolls one page from the fold", () => {
    render(<Harness height={191} />);
    const scroller = screen.getByTestId("scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 191 });
    const scrollBy = vi.fn();
    Object.defineProperty(scroller, "scrollBy", { configurable: true, value: scrollBy });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Show 2 more sessions" }));
    });
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ top: 191 }));
  });

  it("names a single hidden row in the singular, and the spine shows the count alone", () => {
    const { rerender } = render(<IndexFold hidden={1} onPageDown={() => undefined} />);
    expect(screen.getByRole("button", { name: "Show 1 more session" })).not.toBeNull();
    rerender(<IndexFold hidden={3} onPageDown={() => undefined} compact />);
    expect(screen.getByRole("button", { name: "Show 3 more sessions" }).textContent).toBe("+3");
  });
});
