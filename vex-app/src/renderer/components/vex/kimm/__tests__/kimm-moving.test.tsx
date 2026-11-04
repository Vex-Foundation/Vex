/**
 * While she moves (docs/design/H3-DESKTOP.md section 3.4, plan row S4-11):
 * her section's body is inert from the press until the wipe ends, her corner
 * key stays live; focus that her press is about to hide moves to the Vex key
 * in the header (or its forerunner, the token chip), focus on a key stays on
 * it; and the console reads from her phase whether she covers its rest
 * (open, opening, closing) or leaves it to the person (closed).
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DURATION_VEX_CLOSE_MS, DURATION_VEX_OPEN_MS } from "../../../../lib/motion/index.js";
import { handFocusToVexKey, vexKeyElement } from "../kimm-focus.js";
import { kimmCovers } from "../kimm-section-state.js";
import { KimmSection } from "../KimmSection.js";

function section(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='kimm-section']");
  if (el === null) throw new Error("her section is missing");
  return el;
}

function body(): HTMLElement {
  const el = section().querySelector<HTMLElement>(".vex-kimm__body");
  if (el === null) throw new Error("her body is missing");
  return el;
}

/** A rect for an element, as the browser would lay it out. */
function placeAt(el: Element, top: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, left: 248, right: 679, width: 431, height, x: 248, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** The column as the shell draws it: the header's Vex key, the column, her section and a console row under her. */
function Column({ open }: { readonly open: boolean }): JSX.Element {
  return (
    <>
      <button type="button" data-vex-area="vex-key">
        Hide Vex
      </button>
      <aside data-vex-area="vex-sidebar">
        <button type="button" data-testid="needs-you">
          Review
        </button>
        <button type="button" data-testid="activity">
          Open activity
        </button>
        <KimmSection mood="hi" open={open} onOpenChange={() => undefined} />
      </aside>
      <textarea aria-label="Session draft" />
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("while she moves, her section is inert", () => {
  it("makes her body inert from the press to the wipe's end, and keeps her corner key live", () => {
    const view = render(<Column open />);
    expect(body().hasAttribute("inert")).toBe(false);
    view.rerender(<Column open={false} />);
    expect(body().hasAttribute("inert")).toBe(true);
    const key = screen.getByRole("button", { name: "Show Vex" });
    expect(key.closest("[inert]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_CLOSE_MS);
    });
    expect(body().hasAttribute("inert")).toBe(false);
    view.rerender(<Column open />);
    expect(body().hasAttribute("inert")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_OPEN_MS);
    });
    expect(body().hasAttribute("inert")).toBe(false);
  });

  it("tells the console she covers its rest while open and until a close has ended", () => {
    const view = render(<Column open />);
    expect(kimmCovers()).toBe(true);
    view.rerender(<Column open={false} />);
    expect(kimmCovers()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DURATION_VEX_CLOSE_MS);
    });
    expect(kimmCovers()).toBe(false);
    view.rerender(<Column open />);
    expect(kimmCovers()).toBe(true);
    view.unmount();
    expect(kimmCovers()).toBe(false);
  });
});

describe("while she moves, focus lands on the Vex key", () => {
  it("moves focus her opening box will cover to the Vex key", () => {
    const view = render(<Column open={false} />);
    placeAt(section(), 224, 603);
    const activity = screen.getByTestId("activity");
    placeAt(activity, 700, 43);
    activity.focus();
    view.rerender(<Column open />);
    expect(document.activeElement?.getAttribute("data-vex-area")).toBe("vex-key");
  });

  it("leaves focus above her box, and anywhere outside her column, where it is", () => {
    const view = render(<Column open={false} />);
    placeAt(section(), 224, 603);
    const needsYou = screen.getByTestId("needs-you");
    placeAt(needsYou, 119, 64);
    needsYou.focus();
    view.rerender(<Column open />);
    expect(document.activeElement).toBe(needsYou);
    view.rerender(<Column open={false} />);
    const draft = screen.getByRole("textbox", { name: "Session draft" });
    draft.focus();
    view.rerender(<Column open />);
    expect(document.activeElement).toBe(draft);
  });

  it("keeps focus on her corner key through its own press, both ways", () => {
    const view = render(<Column open />);
    const corner = section().querySelector<HTMLElement>("[data-vex-area='kimm-key']");
    if (corner === null) throw new Error("corner key missing");
    placeAt(section(), 224, 603);
    placeAt(corner, 224, 56);
    corner.focus();
    view.rerender(<Column open={false} />);
    expect(document.activeElement).toBe(corner);
    view.rerender(<Column open />);
    expect(document.activeElement).toBe(corner);
  });

  it("keeps focus on the Vex key through its press", () => {
    const view = render(<Column open />);
    const vexKey = document.querySelector<HTMLElement>("[data-vex-area='vex-key']");
    if (vexKey === null) throw new Error("Vex key missing");
    vexKey.focus();
    view.rerender(<Column open={false} />);
    expect(document.activeElement).toBe(vexKey);
    view.rerender(<Column open />);
    expect(document.activeElement).toBe(vexKey);
  });

  it("moves focus inside her folding body to the Vex key, and falls back to the token chip", () => {
    const { container } = render(
      <>
        <button type="button" data-vex-area="vex-token-chip">
          Vex chat
        </button>
        <aside data-vex-area="vex-sidebar">
          <div data-vex-area="kimm-section">
            <div className="vex-kimm__body">
              <button type="button" data-testid="inside">
                inside
              </button>
            </div>
            <button type="button" data-vex-area="kimm-key">
              Hide Vex
            </button>
          </div>
        </aside>
      </>,
    );
    const herSection = container.querySelector<HTMLElement>("[data-vex-area='kimm-section']");
    const corner = container.querySelector<HTMLElement>("[data-vex-area='kimm-key']");
    if (herSection === null) throw new Error("no section");
    expect(vexKeyElement()?.getAttribute("data-vex-area")).toBe("vex-token-chip");
    screen.getByTestId("inside").focus();
    expect(handFocusToVexKey(herSection, corner, false)).toBe(true);
    expect(document.activeElement?.getAttribute("data-vex-area")).toBe("vex-token-chip");
    // Nothing to hand to: focus stays where it was.
    fireEvent.blur(document.activeElement as Element);
  });
});
