/**
 * Sheet: a native modal dialog over one element's box. Pins:
 *   - it is the dialog (modal, labelled by its title, focus on open) with no
 *     scrim and no centring;
 *   - it covers its anchor's box, the mount parent by default;
 *   - Escape closes it through onOpenChange and a press outside does not;
 *   - the head, the body (the one scroll region) and the foot take the
 *     spec's seats.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "../sheet.js";

afterEach(cleanup);

function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function renderSheet(onOpenChange: (next: boolean) => void, anchor?: () => Element | null) {
  return render(
    <div data-testid="column">
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent anchor={anchor}>
          <SheetHeader data-testid="head"><SheetTitle>Mission contract</SheetTitle></SheetHeader>
          <SheetBody data-testid="body">Goal</SheetBody>
          <SheetFooter data-testid="foot"><button type="button">Not now</button></SheetFooter>
        </SheetContent>
      </Sheet>
    </div>,
  );
}

describe("Sheet", () => {
  it("is a labelled modal dialog with no scrim and no centring", () => {
    renderSheet(() => {});
    const dialog = screen.getByRole("dialog", { name: "Mission contract" }) as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("data-vex-backdrop")).toBe("none");
    expect(dialog.classList.contains("vex-sheet")).toBe(true);
    expect(dialog.classList.contains("m-auto")).toBe(false);
  });

  it("covers the box of the element it is mounted in", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset["testid"] === "column" ? box(264, 44, 920, 856) : box(0, 0, 0, 0);
      });
    renderSheet(() => {});
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.top).toBe("44px");
    expect(dialog.style.left).toBe("264px");
    expect(dialog.style.width).toBe("920px");
    expect(dialog.style.height).toBe("856px");
    spy.mockRestore();
  });

  it("covers a named anchor instead when given one", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    const spy = vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(box(56, 88, 700, 600));
    renderSheet(() => {}, () => anchor);
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.left).toBe("56px");
    expect(dialog.style.top).toBe("88px");
    spy.mockRestore();
    anchor.remove();
  });

  it("closes on Escape and stays open on a press outside its box", () => {
    const onOpenChange = vi.fn();
    renderSheet(onOpenChange);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("seats the head, the scrolling body and the foot", () => {
    renderSheet(() => {});
    expect(screen.getByTestId("head").className).toContain("h-14");
    const body = screen.getByTestId("body");
    expect(body.hasAttribute("data-vex-dialog-body")).toBe(true);
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("px-7");
    expect(screen.getByTestId("foot").className).toContain("h-[68px]");
  });
});
