/**
 * Dialog primitive scroll-chain test (core-chat-loop slice).
 *
 * Pins the layout contract that keeps a tall dialog usable: the body is the
 * single bounded, scrollable region (`flex-1 min-h-0 overflow-y-auto`) while
 * the header and footer never compress (`shrink-0`), so a long form's footer
 * actions (e.g. the New-session "Create" button) stay pinned and reachable.
 * jsdom has no layout engine, so this asserts the structural classes; the
 * real small-viewport scroll behaviour is a manual/Playwright check.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import {
  Dialog,
  DialogBody,
  DialogConsequence,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../dialog.js";

beforeAll(() => {
  // jsdom does not implement the native <dialog> modal methods.
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
  };
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

describe("Dialog scroll chain", () => {
  it("body is the bounded scroll region; header + footer are pinned", () => {
    const { container } = render(
      createElement(
        Dialog,
        { open: true, onOpenChange: () => {} },
        createElement(
          DialogContent,
          {},
          createElement(
            DialogHeader,
            { "data-testid": "header" },
            createElement(DialogTitle, {}, "Title"),
          ),
          createElement(DialogBody, { "data-testid": "body" }, "body content"),
          createElement(DialogFooter, { "data-testid": "footer" }, "actions"),
        ),
      ),
    );

    const body = container.querySelector('[data-testid="body"]');
    const header = container.querySelector('[data-testid="header"]');
    const footer = container.querySelector('[data-testid="footer"]');
    expect(body).not.toBeNull();
    expect(header).not.toBeNull();
    expect(footer).not.toBeNull();

    // Body flexes + scrolls, bounded by the dialog's max-h-[85vh].
    expect(body!.classList.contains("flex-1")).toBe(true);
    expect(body!.classList.contains("min-h-0")).toBe(true);
    expect(body!.classList.contains("overflow-y-auto")).toBe(true);

    // Header + footer never compress → footer actions stay reachable.
    expect(header!.classList.contains("shrink-0")).toBe(true);
    expect(footer!.classList.contains("shrink-0")).toBe(true);
  });
});

describe("DialogConsequence", () => {
  /**
   * JSX rather than this file's older `createElement` idiom: the varargs form
   * does not satisfy `DialogProps["children"]` under the renderer tsconfig and
   * every existing use of it is a standing TS2769 in the type baseline. New
   * cases do not inherit that.
   */
  function mount(tone?: "warning" | "notice") {
    return render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
          </DialogHeader>
          {tone === undefined ? (
            <DialogConsequence>Ends 3 running terminals</DialogConsequence>
          ) : (
            <DialogConsequence tone={tone}>Ends 3 running terminals</DialogConsequence>
          )}
          <DialogBody>body</DialogBody>
          <DialogFooter>footer</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
  }

  it("sits outside the body's scroll region and cannot compress", () => {
    const { container } = mount();
    const strip = container.querySelector("[data-vex-dialog-consequence]");
    const body = container.querySelector("[data-vex-dialog-body]");
    expect(strip).not.toBeNull();
    // The property the strip exists for: a consequence inside the one
    // scrolling region is a consequence the user can scroll away from the
    // button that performs it.
    expect(body?.contains(strip as Node)).toBe(false);
    expect(strip?.classList.contains("shrink-0")).toBe(true);
  });

  it("defaults to the warning register and takes the notice one on request", () => {
    const warning = mount();
    expect(
      warning.container
        .querySelector("[data-vex-dialog-consequence]")
        ?.getAttribute("data-vex-dialog-consequence"),
    ).toBe("warning");
    warning.unmount();

    const notice = mount("notice");
    expect(
      notice.container
        .querySelector("[data-vex-dialog-consequence]")
        ?.getAttribute("data-vex-dialog-consequence"),
    ).toBe("notice");
  });

  it("keeps its glyph out of the accessible name", () => {
    const { container } = mount();
    const svg = container.querySelector("[data-vex-dialog-consequence] svg");
    // The strip's text carries the whole meaning; a screen reader that also
    // announced the glyph would be reading the decoration.
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});
