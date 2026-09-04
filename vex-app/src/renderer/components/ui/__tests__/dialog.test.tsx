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

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import {
  Dialog,
  DialogBody,
  DialogConsequence,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../dialog.js";

// The native <dialog> modal methods jsdom lacks are installed for every
// renderer suite by `test/setup.ts` (`test/dialog-modal-polyfill.ts`), WITH the
// focusing steps a browser runs. That is what makes the assertions on
// `document.activeElement` below evidence: under the old per-suite stub, which
// set the `open` attribute and focused nothing, they passed for dialogs a
// browser opened on a different control.

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

/**
 * WHERE A DIALOG OPENS.
 *
 * The reproducer for the defect this suite now guards: React does not render
 * its `autoFocus` prop as the `autofocus` content attribute, and
 * `DialogContent` opens the dialog from its own effect - which runs AFTER its
 * children's - so the native focusing steps had the last word and landed on
 * the first focusable descendant. In `ProjectDeleteDialog` that was the typed
 * confirmation field that ARMS the delete.
 */
describe("DialogContent initial focus", () => {
  function mountConsent(options: {
    readonly nameCancel: boolean;
    readonly disableCancel?: boolean;
  }) {
    const focusProps = options.nameCancel ? DIALOG_INITIAL_FOCUS : {};
    return render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {/* First focusable descendant, and the control that arms the
              * destructive action: what the platform default would focus. */}
            <input aria-label="Type the project name" type="text" />
          </DialogBody>
          <DialogFooter>
            <button
              type="button"
              disabled={options.disableCancel ?? false}
              {...focusProps}
            >
              Cancel
            </button>
            <button type="button">Delete</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
  }

  it("focuses the element the dialog named, not the first focusable descendant", () => {
    mountConsent({ nameCancel: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    // The property that matters, stated as an absence: the field that arms the
    // delete never holds focus when the dialog opens.
    expect(document.activeElement).not.toBe(
      screen.getByRole("textbox", { name: "Type the project name" }),
    );
  });

  it("names its choice with an attribute a browser's focusing steps read", () => {
    mountConsent({ nameCancel: true });
    // React strips `autoFocus`; only the content attribute survives into the
    // DOM `showModal()` reads, which is why the primitive publishes this
    // spread rather than the prop.
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("autofocus"),
    ).toBe(true);
  });

  it("falls back to the dialog itself, never to a control, when nothing is named", () => {
    const { container } = mountConsent({ nameCancel: false });
    const dialog = container.querySelector("dialog");
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    // Not the first focusable descendant: no control is armed by a dialog that
    // did not say which one it wanted.
    expect(document.activeElement).not.toBe(
      screen.getByRole("textbox", { name: "Type the project name" }),
    );
  });

  it("falls back to the dialog when the named element cannot take focus", () => {
    const { container } = mountConsent({ nameCancel: true, disableCancel: true });
    expect(document.activeElement).toBe(container.querySelector("dialog"));
  });

  it("restores focus to the trigger when it closes", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const view = render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <button type="button" {...DIALOG_INITIAL_FOCUS}>
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );

    view.rerender(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <button type="button" {...DIALOG_INITIAL_FOCUS}>
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

/**
 * The harness itself, asserted once: a polyfill that focuses nothing is what
 * let the defect above ship under a green suite, so its focusing steps are a
 * contract of this repository's renderer tests, not an implementation detail.
 */
describe("the jsdom dialog polyfill's focusing steps", () => {
  function openBare(markup: string): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = markup;
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  it("focuses the autofocus element, else the first focusable one", () => {
    const named = openBare(
      '<input id="first" /><button id="named" autofocus>Cancel</button>',
    );
    expect(document.activeElement).toBe(named.querySelector("#named"));
    named.remove();

    const unnamed = openBare('<input id="first" /><button>Cancel</button>');
    expect(document.activeElement).toBe(unnamed.querySelector("#first"));
    unnamed.remove();
  });

  it("skips a disabled candidate", () => {
    const dialog = openBare(
      '<input id="first" disabled /><button id="second">Cancel</button>',
    );
    expect(document.activeElement).toBe(dialog.querySelector("#second"));
    dialog.remove();
  });
});
