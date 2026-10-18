/**
 * THE DIALOG'S SIZES AND BACKDROPS.
 *
 * The board size gives the wide surface its own bounded scroll region; every
 * 380px consumer renders one exact class string (the R3 chrome: a 1.5px ink
 * frame on the paper); the sheet size drops the centring and the caps; the
 * backdrop is the flat scrim unless a dialog asks for none.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeadlessHeader,
} from "../dialog.js";

function renderDialog(size?: "default" | "board" | "sheet"): HTMLDialogElement {
  const { container } = render(
    <Dialog open onOpenChange={() => {}}>
      {size === undefined ? (
        <DialogContent>
          <DialogBody data-testid="body">content</DialogBody>
        </DialogContent>
      ) : (
        <DialogContent size={size}>
          <DialogBody data-testid="body">content</DialogBody>
        </DialogContent>
      )}
    </Dialog>,
  );
  const dialog = container.querySelector("dialog");
  if (dialog === null) throw new Error("dialog did not render");
  return dialog;
}

describe("Dialog size variants", () => {
  it("the default renders the exact R3 prompt column class string", () => {
    const dialog = renderDialog();
    expect(dialog.className).toBe(
      "fixed inset-0 m-auto max-h-[85vh] w-full max-w-[380px] overflow-hidden " +
        "vex-dialog border-[1.5px] border-rule-ink bg-surface-2 p-0 " +
        "text-ink-primary open:flex open:flex-col",
    );
    expect(dialog.className).not.toMatch(/rounded|shadow|blur/);
  });

  it("the sheet size drops the centring and the caps", () => {
    const dialog = renderDialog("sheet");
    expect(dialog.classList.contains("vex-sheet")).toBe(true);
    expect(dialog.classList.contains("m-auto")).toBe(false);
    expect(dialog.classList.contains("inset-0")).toBe(false);
    expect(dialog.classList.contains("max-h-[85vh]")).toBe(false);
    expect(dialog.classList.contains("max-w-[380px]")).toBe(false);
  });

  it("omitting the prop and passing 'default' are the same render", () => {
    expect(renderDialog().className).toBe(renderDialog("default").className);
  });

  it("the board size is 90vw capped at 1280px, still bounded at 85vh", () => {
    const dialog = renderDialog("board");
    expect(dialog.classList.contains("w-[90vw]")).toBe(true);
    expect(dialog.classList.contains("max-w-[1280px]")).toBe(true);
    expect(dialog.classList.contains("max-h-[85vh]")).toBe(true);
    // The 380px column must NOT come along.
    expect(dialog.classList.contains("max-w-[380px]")).toBe(false);
    expect(dialog.classList.contains("w-full")).toBe(false);
  });

  it("the board body is still the one bounded scroll region", () => {
    renderDialog("board");
    const body = screen.getByTestId("body");
    expect(body.classList.contains("flex-1")).toBe(true);
    expect(body.classList.contains("min-h-0")).toBe(true);
    expect(body.classList.contains("overflow-y-auto")).toBe(true);
  });
});

describe("Dialog backdrop", () => {
  it("draws the flat scrim by default and none when asked", () => {
    const { container, rerender } = render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>x</DialogContent>
      </Dialog>,
    );
    expect(container.querySelector("dialog")?.hasAttribute("data-vex-backdrop")).toBe(false);
    rerender(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent backdrop="none">x</DialogContent>
      </Dialog>,
    );
    expect(container.querySelector("dialog")?.getAttribute("data-vex-backdrop")).toBe("none");
  });
});

describe("DialogHeadlessHeader", () => {
  it("still names the dialog for a screen reader while painting nothing", () => {
    const { container } = render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent size="board">
          <DialogHeadlessHeader
            title="Top movers"
            description="Market figures. Press Escape to close."
          />
        </DialogContent>
      </Dialog>,
    );
    const dialog = container.querySelector("dialog");
    const heading = screen.getByRole("heading", { name: "Top movers" });
    expect(dialog?.getAttribute("aria-labelledby")).toBe(heading.id);
    const description = screen.getByText("Market figures. Press Escape to close.");
    expect(dialog?.getAttribute("aria-describedby")).toBe(description.id);
    // Visually hidden, NOT display:none - a hidden element cannot name a
    // dialog, so `sr-only` is the mechanism and `hidden` is forbidden here.
    const wrapper = heading.parentElement;
    expect(wrapper?.className).toBe("sr-only");
    expect(wrapper?.hasAttribute("hidden")).toBe(false);
  });
});
