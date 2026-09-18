import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShellDragHandle } from "../ShellDragHandle.js";

function setup() {
  const onStart = vi.fn();
  const onDrag = vi.fn();
  const onEnd = vi.fn();
  const view = render(<ShellDragHandle side="book" left={700} label="Resize Vex" value={400} min={300} max={520} onStart={onStart} onDrag={onDrag} onEnd={onEnd} />);
  const handle = view.getByRole("separator");
  const captured = new Set<number>();
  Object.assign(handle, {
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
  });
  return { handle, onStart, onDrag, onEnd };
}

describe("ShellDragHandle", () => {
  it("commits the final release position even before an animation frame paints", () => {
    const { handle, onDrag, onEnd } = setup();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 680 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 640 });
    expect(onDrag).toHaveBeenLastCalledWith(-60);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(handle.hasPointerCapture(1)).toBe(false);
    expect(handle.getAttribute("data-dragging")).toBeNull();
  });

  it("ends a canceled gesture once and allows a new gesture", () => {
    const { handle, onStart, onEnd } = setup();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 700 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(onEnd).toHaveBeenCalledOnce();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 700 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 660 });
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("offers the same resize control through the keyboard", () => {
    const { handle, onStart, onDrag, onEnd } = setup();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onDrag).toHaveBeenCalledWith(-24);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
  });
});
