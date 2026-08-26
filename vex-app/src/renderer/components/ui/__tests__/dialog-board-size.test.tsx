/**
 * THE DIALOG'S ADDITIVE BOARD MODE.
 *
 * Two claims, and the second is the one that protects the rest of the app:
 * the board size gives the wide surface its own bounded scroll region, and
 * every existing 380px consumer renders the byte-identical class string it
 * rendered before the size prop existed.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeadlessHeader,
} from "../dialog.js";

beforeAll(() => {
  // jsdom ships HTMLDialogElement without showModal/close; lib.dom already
  // types both, so the polyfill assigns real methods with no cast.
  const proto = HTMLDialogElement.prototype;
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModalPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function closePolyfill(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    };
  }
});

function renderDialog(size?: "default" | "board"): HTMLDialogElement {
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
  it("the default is byte-identical to the pre-variant class string", () => {
    const dialog = renderDialog();
    expect(dialog.className).toBe(
      "fixed inset-0 m-auto max-h-[85vh] w-full max-w-[380px] overflow-hidden " +
        "vex-dialog rounded-[24px] border border-line-1 bg-surface-2 p-0 " +
        "text-ink-primary shadow-lv3 open:flex open:flex-col",
    );
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
