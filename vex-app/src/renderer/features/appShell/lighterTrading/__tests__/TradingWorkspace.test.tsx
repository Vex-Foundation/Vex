import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradingWorkspace } from "../TradingWorkspace.js";

let viewportHeight = 700;
let reservedHeight = 341;
let notifyResize: () => void;

beforeEach(() => {
  viewportHeight = 700;
  reservedHeight = 341;
  const readStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = readStyle(element, pseudo);
    if (element.classList.contains("lit-workspace")) {
      return new Proxy(style, {
        get(target, key) {
          if (key === "getPropertyValue") {
            return (name: string) => name === "--lit-main-min-height"
              ? `${reservedHeight}px`
              : target.getPropertyValue(name);
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return style;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight);
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { notifyResize = () => callback([], this); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderWorkspace(): { handle: HTMLElement; workspace: HTMLElement } {
  const { container } = render(
    <TradingWorkspace account={<div>Account positions</div>} hasSession>
      <div>Market chart</div>
    </TradingWorkspace>,
  );
  const handle = screen.getByRole("separator", { name: "Resize account panel" });
  Object.defineProperties(handle, {
    setPointerCapture: { value: vi.fn() },
    hasPointerCapture: { value: () => true },
    releasePointerCapture: { value: vi.fn() },
  });
  return { handle, workspace: container.firstElementChild as HTMLElement };
}

function pointer(type: string, clientY: number): MouseEvent {
  return Object.assign(new MouseEvent(type, { bubbles: true, button: 0, clientY }), { pointerId: 1 });
}

describe("Trading workspace account resizing", () => {
  it.each([
    ["compact", 600, 502, 120],
    ["desktop", 700, 341, 359],
  ] as const)("bounds keyboard and upward dragging in a %s workspace", (_layout, height, reserved, expected) => {
    viewportHeight = height;
    reservedHeight = reserved;
    const { handle, workspace } = renderWorkspace();

    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuemax")).toBe(String(expected));
    expect(handle.getAttribute("aria-valuenow")).toBe(String(expected));
    expect(workspace.style.getPropertyValue("--lit-bottom-height")).toBe(`${expected}px`);

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("120");
    fireEvent(handle, pointer("pointerdown", 400));
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent(handle, pointer("pointermove", -1000));
    expect(handle.getAttribute("aria-valuenow")).toBe(String(expected));
    expect(workspace.style.getPropertyValue("--lit-bottom-height")).toBe(`${expected}px`);
    fireEvent(handle, pointer("pointerup", -1000));
    expect(workspace.hasAttribute("data-resizing")).toBe(false);
  });

  it("reclamps an expanded desktop account when the viewport becomes compact", () => {
    const { handle, workspace } = renderWorkspace();
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("359");

    viewportHeight = 600;
    reservedHeight = 502;
    act(() => notifyResize());

    expect(handle.getAttribute("aria-valuemax")).toBe("120");
    expect(handle.getAttribute("aria-valuenow")).toBe("120");
    expect(workspace.style.getPropertyValue("--lit-bottom-height")).toBe("120px");
  });
});
