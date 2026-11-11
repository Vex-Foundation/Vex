/**
 * A Hide Vex press guards what it reveals (`kimm-guard.ts`, docs/design/
 * H3-DESKTOP.md section 3.4): after a close pressed with a pointer, on her
 * corner key or the Vex key, the console's rest takes no pointer until the
 * close has ended, 500ms have passed since the press and the pointer has left
 * the pressed key's box, whichever comes last. A keyboard close stands no
 * guard; an open drops one; a touch or a pen is out of the key once lifted,
 * as Cloud's built guard has it. And a turned leg lasts max(140, base x
 * distance left / distance) (`kimm-wipe.ts`).
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DURATION_VEX_CLOSE_MS,
  DURATION_VEX_GUARD_MS,
  DURATION_VEX_OPEN_MS,
  DURATION_VEX_TURN_MIN_MS,
} from "../../../../lib/motion/index.js";
import { insidePress, kimmGuardLifts } from "../kimm-guard.js";
import { kimmLegMs } from "../kimm-wipe.js";
import { KimmSection } from "../KimmSection.js";
import { clearLayout, installFakeAnimations, layOut, type FakeAnimations } from "./fake-animations.js";


/** Give an element the box the browser would lay it out in. */
function placeAt(el: Element, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** The column as the shell draws it: the header's Vex key, her section and the console's rest after it. */
function Column({ startOpen = true }: { readonly startOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button type="button" data-vex-area="vex-key" onClick={() => setOpen(!open)}>
        {open ? "Hide Vex" : "Show Vex"}
      </button>
      <aside>
        <KimmSection mood="hi" open={open} onOpenChange={setOpen} />
        <div className="vex-vs__rest" data-testid="rest" />
      </aside>
    </>
  );
}

function section(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='kimm-section']");
  if (el === null) throw new Error("her section is missing");
  return el;
}

function cornerKey(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='kimm-key']");
  if (el === null) throw new Error("her corner key is missing");
  return el;
}

const guarded = (): boolean => section().hasAttribute("data-kimm-guard");

/** A pointer moving to a point of the window. */
function pointerTo(x: number, y: number): void {
  act(() => {
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
  });
}

/** A click made by a pointer of `pointerType` (Chromium's click is a PointerEvent that names it). */
function clickWith(el: Element, pointerType: string): void {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  act(() => {
    el.dispatchEvent(event);
  });
}

/** A pointer of `pointerType` lifted (or cancelled) at a point of the window. */
function liftAt(type: "pointerup" | "pointercancel", pointerType: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  act(() => {
    window.dispatchEvent(event);
  });
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("the guard's rule", () => {
  it("lifts only when the close has ended, its 500ms are up and the pointer is out of the key", () => {
    expect(DURATION_VEX_GUARD_MS).toBe(500);
    for (const waited of [false, true]) {
      for (const closed of [false, true]) {
        for (const inside of [false, true]) {
          expect(kimmGuardLifts({ waited, closed, inside }), JSON.stringify({ waited, closed, inside })).toBe(
            waited && closed && !inside,
          );
        }
      }
    }
  });

  it("counts the key box's edges as inside", () => {
    const press = { left: 541, top: 224, right: 679, bottom: 280 };
    expect(insidePress(press, 541, 224)).toBe(true);
    expect(insidePress(press, 679, 280)).toBe(true);
    expect(insidePress(press, 540, 250)).toBe(false);
    expect(insidePress(press, 600, 281)).toBe(false);
  });

});

describe("a Hide Vex press guards what it reveals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("holds through the close and its 500ms while the pointer rests on the corner key, and lifts when it leaves", () => {
    render(<Column />);
    placeAt(cornerKey(), 541, 224, 138, 56);
    fireEvent.click(cornerKey(), { detail: 1 });
    expect(cornerKey().textContent).toBe("Show Vex");
    expect(guarded()).toBe(true);
    // The close ends at 420ms; the guard still stands.
    wait(DURATION_VEX_CLOSE_MS);
    expect(section().getAttribute("data-kimm-phase")).toBe("closed");
    expect(guarded()).toBe(true);
    // Past 500ms with the pointer still where Hide Vex was: it stands.
    wait(DURATION_VEX_GUARD_MS - DURATION_VEX_CLOSE_MS + 300);
    expect(guarded()).toBe(true);
    // A move inside the key's box changes nothing; leaving it lifts the guard.
    pointerTo(600, 250);
    expect(guarded()).toBe(true);
    pointerTo(400, 500);
    expect(guarded()).toBe(false);
  });

  it("waits out the 500ms when the pointer leaves at once", () => {
    render(<Column />);
    placeAt(cornerKey(), 541, 224, 138, 56);
    fireEvent.click(cornerKey(), { detail: 1 });
    wait(100);
    pointerTo(400, 500);
    expect(guarded()).toBe(true);
    wait(DURATION_VEX_CLOSE_MS - 100);
    expect(guarded()).toBe(true);
    wait(DURATION_VEX_GUARD_MS - DURATION_VEX_CLOSE_MS);
    expect(guarded()).toBe(false);
  });

  it("waits for the close to end when it outlasts the 500ms", () => {
    // A wipe still running past 500ms (here: one that never ends by itself).
    const engine: FakeAnimations = installFakeAnimations();
    try {
      render(<Column />);
      layOut(section());
      placeAt(cornerKey(), 541, 224, 138, 56);
      fireEvent.click(cornerKey(), { detail: 1 });
      pointerTo(400, 500);
      wait(DURATION_VEX_GUARD_MS + 200);
      expect(section().getAttribute("data-kimm-phase")).toBe("closing");
      expect(guarded()).toBe(true);
    } finally {
      engine.restore();
      clearLayout();
    }
  });

  it("guards a close pressed on the Vex key too, from that key's box", () => {
    render(<Column />);
    const vexKey = document.querySelector<HTMLElement>("[data-vex-area='vex-key']");
    if (vexKey === null) throw new Error("the Vex key is missing");
    placeAt(vexKey, 248, 0, 432, 76);
    fireEvent.click(vexKey, { detail: 1 });
    expect(guarded()).toBe(true);
    wait(DURATION_VEX_GUARD_MS);
    // Still on the Vex key: it stands; down onto the console's rest, it lifts.
    expect(guarded()).toBe(true);
    pointerTo(400, 500);
    expect(guarded()).toBe(false);
  });

  it("lets a touch or a pen go at its lift: no move ever comes, so it lifts on its time and its close alone", () => {
    for (const pointerType of ["touch", "pen"]) {
      render(<Column />);
      placeAt(cornerKey(), 541, 224, 138, 56);
      clickWith(cornerKey(), pointerType);
      expect(cornerKey().textContent).toBe("Show Vex");
      expect(guarded()).toBe(true);
      wait(DURATION_VEX_GUARD_MS - 1);
      expect(guarded()).toBe(true);
      wait(1);
      expect(guarded(), pointerType).toBe(false);
      cleanup();
    }
  });

  it("keeps a mouse that rests on the key waiting, and lets it go when a later touch lifts", () => {
    render(<Column />);
    placeAt(cornerKey(), 541, 224, 138, 56);
    clickWith(cornerKey(), "mouse");
    wait(DURATION_VEX_GUARD_MS + 300);
    expect(guarded()).toBe(true);
    // A mouse button let go over the key is still over it.
    liftAt("pointerup", "mouse", 600, 250);
    expect(guarded()).toBe(true);
    // A finger lifted, even over the key's box, rests over nothing.
    liftAt("pointercancel", "touch", 600, 250);
    expect(guarded()).toBe(false);
  });

  it("stands no guard for a close from the keyboard", () => {
    render(<Column />);
    fireEvent.click(cornerKey(), { detail: 0 });
    expect(section().getAttribute("data-kimm-open")).toBe("false");
    expect(guarded()).toBe(false);
  });

  it("drops a standing guard when she opens again", () => {
    render(<Column />);
    placeAt(cornerKey(), 541, 224, 138, 56);
    fireEvent.click(cornerKey(), { detail: 1 });
    expect(guarded()).toBe(true);
    fireEvent.click(cornerKey(), { detail: 1 });
    expect(section().getAttribute("data-kimm-open")).toBe("true");
    expect(guarded()).toBe(false);
  });

  it("never guards on an open", () => {
    render(<Column startOpen={false} />);
    placeAt(cornerKey(), 530, 224, 149, 56);
    fireEvent.click(cornerKey(), { detail: 1 });
    expect(section().getAttribute("data-kimm-open")).toBe("true");
    expect(guarded()).toBe(false);
  });
});

describe("a turned-around leg", () => {
  it("lasts max(140, base x distance left / distance), base being the new direction's", () => {
    expect(DURATION_VEX_TURN_MIN_MS).toBe(140);
    // A whole leg is its base.
    expect(kimmLegMs(true, 547, 0, 547)).toBe(DURATION_VEX_OPEN_MS);
    expect(kimmLegMs(false, 0, 547, 547)).toBe(DURATION_VEX_CLOSE_MS);
    // A close turned 40% up opens over 40% of 720.
    expect(kimmLegMs(true, 218.8, 0, 547)).toBeCloseTo(288, 6);
    // An open turned 40% down closes over 60% of 420.
    expect(kimmLegMs(false, 218.8, 547, 547)).toBeCloseTo(252, 6);
    // A turn near the end is floored at 140.
    expect(kimmLegMs(false, 5.47, 0, 547)).toBe(140);
    expect(kimmLegMs(true, 1, 0, 547)).toBe(140);
  });

  it("starts from the edge where it stands, over that share of the new direction's duration", () => {
    const engine = installFakeAnimations();
    try {
      const view = render(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
      layOut(section());
      view.rerender(<KimmSection mood="hi" open={false} onOpenChange={() => undefined} />);
      const [close] = engine.live(section());
      if (close === undefined) throw new Error("no close");
      close.progress = 0.4;
      view.rerender(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
      const [open] = engine.live(section());
      expect(open?.options.duration).toBeCloseTo(288, 6);
      // Every part of the turned leg shares its duration.
      for (const run of engine.runs.filter((r) => !r.cancelled)) expect(run.options.duration).toBeCloseTo(288, 6);
    } finally {
      engine.restore();
      clearLayout();
      cleanup();
    }
  });

  it("is never shorter than 140: an open turned back a hair after it starts", () => {
    const engine = installFakeAnimations();
    try {
      const view = render(<KimmSection mood="hi" open={false} onOpenChange={() => undefined} />);
      layOut(section());
      view.rerender(<KimmSection mood="hi" open onOpenChange={() => undefined} />);
      const [open] = engine.live(section());
      if (open === undefined) throw new Error("no open");
      // 1% down: the close has 5.47 of 547 left, 4.2ms of its 420.
      open.progress = 0.01;
      view.rerender(<KimmSection mood="hi" open={false} onOpenChange={() => undefined} />);
      const [close] = engine.live(section());
      expect(close?.options.duration).toBe(DURATION_VEX_TURN_MIN_MS);
      expect(close?.keyframes[1]).toEqual({ clipPath: "inset(0px 0px 547px 0px)" });
    } finally {
      engine.restore();
      clearLayout();
      cleanup();
    }
  });
});
