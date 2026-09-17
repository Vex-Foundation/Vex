import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent, PointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSplitter, type SplitterOptions } from "../useSplitter.js";

/** A handle element with the pointer-capture surface jsdom lacks. */
function handleElement() {
  const element = document.createElement("div");
  const captured = new Set<number>();
  Object.assign(element, {
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
  });
  return element;
}

function pointer(
  element: HTMLElement,
  overrides: Partial<{ button: number; clientX: number; clientY: number }> = {},
): PointerEvent<HTMLElement> {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 7,
    currentTarget: element,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as PointerEvent<HTMLElement>;
}

function key(name: string): KeyboardEvent<HTMLElement> & { preventDefault: ReturnType<typeof vi.fn> } {
  return { key: name, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

function setup(overrides: Partial<SplitterOptions> = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const options: SplitterOptions = {
    axis: "x",
    grows: "end",
    value: 300,
    min: 200,
    max: 500,
    defaultValue: 320,
    label: "Resize the order book",
    onChange,
    onCommit,
    ...overrides,
  };
  const hook = renderHook(() => useSplitter(options));
  return { ...hook, onChange, onCommit };
}

describe("useSplitter", () => {
  it("describes itself as a separator between two columns", () => {
    const { result } = setup();
    const props = result.current.handleProps;
    expect(props.role).toBe("separator");
    expect(props["aria-orientation"]).toBe("vertical");
    expect(props["aria-valuenow"]).toBe(300);
    expect(props["aria-valuetext"]).toBe("300 pixels");
    expect(props["data-dragging"]).toBeUndefined();
    expect(setup({ axis: "y" }).result.current.handleProps["aria-orientation"]).toBe("horizontal");
  });

  it("drags with pointer capture, clamps to the range and commits once on release", () => {
    const { result, onChange, onCommit } = setup();
    const element = handleElement();

    act(() => result.current.handleProps.onPointerDown(pointer(element, { clientX: 100 })));
    expect(result.current.dragging).toBe(true);
    expect(result.current.handleProps["data-dragging"]).toBe(true);
    expect(element.hasPointerCapture(7)).toBe(true);

    act(() => result.current.handleProps.onPointerMove(pointer(element, { clientX: 150 })));
    act(() => result.current.handleProps.onPointerMove(pointer(element, { clientX: 900 })));
    expect(onChange.mock.calls).toEqual([[350], [500]]);
    expect(onCommit).not.toHaveBeenCalled();

    act(() => result.current.handleProps.onPointerUp(pointer(element, { clientX: 900 })));
    expect(result.current.dragging).toBe(false);
    expect(element.hasPointerCapture(7)).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(1);

    // A move without a drag in flight is inert, as is a secondary button.
    act(() => result.current.handleProps.onPointerMove(pointer(element, { clientX: 10 })));
    act(() => result.current.handleProps.onPointerDown(pointer(element, { button: 2 })));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(result.current.dragging).toBe(false);
  });

  it("grows toward the start edge on the y axis and drops the drag when capture is lost", () => {
    const { result, onChange, onCommit } = setup({ axis: "y", grows: "start", value: 240, min: 120, max: 480 });
    const element = handleElement();
    act(() => result.current.handleProps.onPointerDown(pointer(element, { clientY: 400 })));
    act(() => result.current.handleProps.onPointerMove(pointer(element, { clientY: 370 })));
    expect(onChange).toHaveBeenLastCalledWith(270);
    act(() => result.current.handleProps.onLostPointerCapture());
    expect(result.current.dragging).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Ending twice never commits twice.
    act(() => result.current.handleProps.onPointerCancel());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("steps with the arrow keys along its axis, jumps with Home/End and resets on double-click", () => {
    const { result, onChange, onCommit } = setup();
    const grow = key("ArrowRight");
    act(() => result.current.handleProps.onKeyDown(grow));
    expect(grow.preventDefault).toHaveBeenCalled();
    act(() => result.current.handleProps.onKeyDown(key("ArrowLeft")));
    act(() => result.current.handleProps.onKeyDown(key("Home")));
    act(() => result.current.handleProps.onKeyDown(key("End")));
    expect(onChange.mock.calls).toEqual([[324], [276], [200], [500]]);
    expect(onCommit).toHaveBeenCalledTimes(4);

    const wrongAxis = key("ArrowUp");
    act(() => result.current.handleProps.onKeyDown(wrongAxis));
    expect(wrongAxis.preventDefault).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(4);

    act(() => result.current.handleProps.onDoubleClick());
    expect(onChange).toHaveBeenLastCalledWith(320);
    expect(onCommit).toHaveBeenCalledTimes(5);
  });
});
