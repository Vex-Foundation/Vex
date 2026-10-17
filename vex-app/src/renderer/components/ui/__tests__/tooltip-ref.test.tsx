// @vitest-environment jsdom
/**
 * Tooltip reads its child's ref the React 19 way (`element.props.ref`).
 *
 * Reading `element.ref` logs "Accessing element.ref was removed in React 19.
 * ref is now a regular prop." in development, once per page load, from every
 * chat that mounts a tooltip. The owner's ref must still reach the DOM node.
 *
 * React logs that warning once per module instance, so the console assertion
 * runs first in this file, before any other render can have consumed it.
 */

import { createRef, useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tooltip } from "../tooltip.js";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
  vi.restoreAllMocks();
});

function logged(): string[] {
  return errorSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));
}

describe("Tooltip child ref", () => {
  it("logs no element.ref console error, with or without a child ref", () => {
    const own = createRef<HTMLButtonElement>();
    render(
      <>
        <Tooltip label="with ref">
          <button type="button" ref={own}>
            with
          </button>
        </Tooltip>
        <Tooltip label="without ref">
          <button type="button">without</button>
        </Tooltip>
      </>,
    );
    expect(logged().filter((line) => /element\.ref|ref is now a regular prop/i.test(line))).toEqual([]);
  });

  it("hands the owner's object ref the anchor node", () => {
    const own = createRef<HTMLButtonElement>();
    render(
      <Tooltip label="hint">
        <button type="button" ref={own}>
          anchor
        </button>
      </Tooltip>,
    );
    expect(own.current).toBe(screen.getByRole("button", { name: "anchor" }));
  });

  it("hands the owner's callback ref the anchor node and null on unmount", () => {
    const seen: Array<HTMLElement | null> = [];
    const { unmount } = render(
      <Tooltip label="hint">
        <button
          type="button"
          ref={(node) => {
            seen.push(node);
          }}
        >
          anchor
        </button>
      </Tooltip>,
    );
    expect(seen[0]).toBe(screen.getByRole("button", { name: "anchor" }));
    unmount();
    expect(seen[seen.length - 1]).toBeNull();
  });

  it("still anchors the bubble on that same node", () => {
    const own = createRef<HTMLButtonElement>();
    render(
      <Tooltip label="hint">
        <button type="button" ref={own}>
          anchor
        </button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByRole("button", { name: "anchor" }));
    expect(screen.getByRole("tooltip").textContent).toBe("hint");
    expect(own.current).toBe(screen.getByRole("button", { name: "anchor" }));
  });

  it("follows a child whose ref callback changes between renders", () => {
    const a: Array<HTMLElement | null> = [];
    const b: Array<HTMLElement | null> = [];
    function Host(): React.JSX.Element {
      const [useB, setUseB] = useState(false);
      const refA = useCallback((node: HTMLElement | null) => {
        a.push(node);
      }, []);
      const refB = useCallback((node: HTMLElement | null) => {
        b.push(node);
      }, []);
      return (
        <>
          <button type="button" onClick={() => setUseB(true)}>
            swap
          </button>
          <Tooltip label="hint">
            <span ref={useB ? refB : refA}>anchor</span>
          </Tooltip>
        </>
      );
    }
    render(<Host />);
    const node = screen.getByText("anchor");
    expect(a[0]).toBe(node);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "swap" }));
    });
    expect(b[b.length - 1]).toBe(node);
    expect(logged().filter((line) => /element\.ref/i.test(line))).toEqual([]);
  });
});
