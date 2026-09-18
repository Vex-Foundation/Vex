import { act, fireEvent, render, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSplitter, type SplitterOptions } from "../useSplitter.js";

function pointerElement(props: ReturnType<typeof useSplitter>["handleProps"]): HTMLElement {
  const view = render(<div {...props} />);
  const element = view.getByRole("separator");
  const captured = new Set<number>();
  Object.assign(element, {
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
  });
  return element;
}

function key(name: string): KeyboardEvent<HTMLElement> & { preventDefault: ReturnType<typeof vi.fn> } {
  return { key: name, preventDefault: vi.fn() } as KeyboardEvent<HTMLElement> & {
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
    const element = pointerElement(result.current.handleProps);

    fireEvent.pointerDown(element, { button: 0, clientX: 100, pointerId: 7 });
    expect(result.current.dragging).toBe(true);
    expect(result.current.handleProps["data-dragging"]).toBe(true);
    expect(element.hasPointerCapture(7)).toBe(true);

    fireEvent.pointerMove(element, { clientX: 150, pointerId: 7 });
    fireEvent.pointerMove(element, { clientX: 900, pointerId: 7 });
    expect(onChange.mock.calls).toEqual([[350], [500]]);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(element, { clientX: 900, pointerId: 7 });
    expect(result.current.dragging).toBe(false);
    expect(element.hasPointerCapture(7)).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(1);

    // A move without a drag in flight is inert, as is a secondary button.
    fireEvent.pointerMove(element, { clientX: 10, pointerId: 7 });
    fireEvent.pointerDown(element, { button: 2, pointerId: 7 });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(result.current.dragging).toBe(false);
  });

  it("grows toward the start edge on the y axis and drops the drag when capture is lost", () => {
    const { result, onChange, onCommit } = setup({ axis: "y", grows: "start", value: 240, min: 120, max: 480 });
    const element = pointerElement(result.current.handleProps);
    fireEvent.pointerDown(element, { button: 0, clientY: 400, pointerId: 7 });
    fireEvent.pointerMove(element, { clientY: 370, pointerId: 7 });
    expect(onChange).toHaveBeenLastCalledWith(270);
    fireEvent.lostPointerCapture(element, { pointerId: 7 });
    expect(result.current.dragging).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Ending twice never commits twice.
    fireEvent.pointerCancel(element, { pointerId: 7 });
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
