/**
 * ShellScreen — the reusable full-app overlay chrome.
 *
 * Contract pinned here:
 *   1. renders as a modal dialog named by its title, with the serif H1 and
 *      the round close key; the close key fires `onClose`;
 *   2. the overlay is a FIXED full-app layer (`fixed inset-2 z-50
 *      rounded-2xl`) — never an in-flow flex child that could reflow the
 *      shell columns — and declares its FLIP morph anchor via
 *      `data-vex-morph` ("trigger" with an origin rect, "center" without,
 *      "reduced" under prefers-reduced-motion). Classes/attrs only — the
 *      animation frames themselves are not assertable in jsdom;
 *   3. Escape (from anywhere — the listener rides window) fires `onClose`;
 *   4. reduced motion renders the final frame safely (no enter animation
 *      required for the content to be present), with or without an origin;
 *   5. the optional `header` slot replaces the serif H1 while `title` keeps
 *      naming the dialog and the close key (token-history screen contract);
 *   6. focus returns to the trigger control on unmount (and is never stolen
 *      from a control another surface focused meanwhile).
 */

import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShellScreen } from "../ShellScreen.js";

const ORIGIN = { x: 10, y: 620, width: 240, height: 44 };

const realMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

/** Minimal MediaQueryList stub forcing prefers-reduced-motion to `matches`. */
function stubMatchMedia(matches: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

describe("ShellScreen", () => {
  it("opens as a titled modal dialog and closes via the round close key", () => {
    const onClose = vi.fn();
    render(
      <ShellScreen title="Memory" origin={ORIGIN} onClose={onClose}>
        <p>screen content</p>
      </ShellScreen>,
    );

    const overlay = screen.getByRole("dialog", { name: "Memory" });
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { level: 1, name: "Memory" })).not.toBeNull();
    expect(screen.getByText("screen content")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Memory" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is a fixed full-app overlay declaring its FLIP morph anchor — never an in-flow sheet", () => {
    const withOrigin = render(
      <ShellScreen title="Memory" origin={ORIGIN} onClose={vi.fn()}>
        <p>screen content</p>
      </ShellScreen>,
    );
    const overlay = screen.getByRole("dialog", { name: "Memory" });
    // The class contract that keeps the overlay OUT of shell flow. Pinned as
    // classes (not computed styles): jsdom does not lay out Tailwind.
    for (const cls of ["fixed", "inset-2", "z-50", "rounded-2xl"]) {
      expect(overlay.classList.contains(cls), `missing class: ${cls}`).toBe(true);
    }
    expect(overlay.getAttribute("data-vex-area")).toBe("shell-screen");
    // With a captured trigger rect the FLIP anchors on the menu row…
    expect(overlay.getAttribute("data-vex-morph")).toBe("trigger");
    withOrigin.unmount();

    // …and without one it falls back to the quiet centered expand.
    render(
      <ShellScreen title="Sessions" origin={null} onClose={vi.fn()}>
        <p>register</p>
      </ShellScreen>,
    );
    expect(
      screen.getByRole("dialog", { name: "Sessions" }).getAttribute("data-vex-morph"),
    ).toBe("center");
  });

  it("closes on Escape from anywhere in the window", () => {
    const onClose = vi.fn();
    render(
      <ShellScreen title="Sessions" origin={null} onClose={onClose}>
        <p>ledger</p>
      </ShellScreen>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Other keys never close.
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the `header` slot in place of the serif H1 while `title` still names the dialog and close key", () => {
    render(
      <ShellScreen
        title="USD Coin history"
        origin={null}
        onClose={vi.fn()}
        header={<div data-testid="custom-header">USD Coin (Base)</div>}
      >
        <p>ledger</p>
      </ShellScreen>,
    );

    // The dialog + close key stay named by `title` (a11y contract)…
    expect(
      screen.getByRole("dialog", { name: "USD Coin history" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Close USD Coin history" }),
    ).not.toBeNull();
    // …while the default serif H1 is replaced by the custom header content.
    expect(screen.getByTestId("custom-header")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("restores focus to the triggering control when the screen unmounts", () => {
    function Harness({ open }: { readonly open: boolean }): JSX.Element {
      return (
        <>
          <button type="button" data-testid="trigger">
            open history
          </button>
          {open ? (
            <ShellScreen title="Memory" origin={null} onClose={vi.fn()}>
              <p>content</p>
            </ShellScreen>
          ) : null}
        </>
      );
    }

    const view = render(<Harness open={false} />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    view.rerender(<Harness open />);
    // The chrome claims focus on open (the close key)…
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close Memory" }),
    );

    view.rerender(<Harness open={false} />);
    // …and hands it back to the trigger on close.
    expect(document.activeElement).toBe(trigger);
  });

  it("does not restore focus when the trigger is gone or another control already holds focus", () => {
    function Harness({
      open,
      showTrigger,
    }: {
      readonly open: boolean;
      readonly showTrigger: boolean;
    }): JSX.Element {
      return (
        <>
          {showTrigger ? (
            <button type="button" data-testid="trigger">
              open
            </button>
          ) : null}
          <button type="button" data-testid="other">
            other surface
          </button>
          {open ? (
            <ShellScreen title="Memory" origin={null} onClose={vi.fn()}>
              <p>content</p>
            </ShellScreen>
          ) : null}
        </>
      );
    }

    // Trigger removed while the screen is open (e.g. it lived inside a
    // replaced screen instance) → no restore, no crash.
    const view = render(<Harness open={false} showTrigger />);
    screen.getByTestId("trigger").focus();
    view.rerender(<Harness open showTrigger />);
    view.rerender(<Harness open showTrigger={false} />);
    view.rerender(<Harness open={false} showTrigger={false} />);
    expect(document.activeElement).toBe(document.body);
    view.unmount();

    // Another control claimed focus before unmount → never stolen back.
    const second = render(<Harness open={false} showTrigger />);
    screen.getByTestId("trigger").focus();
    second.rerender(<Harness open showTrigger />);
    screen.getByTestId("other").focus();
    second.rerender(<Harness open={false} showTrigger />);
    expect(document.activeElement).toBe(screen.getByTestId("other"));
  });

  it("renders the final frame safely under prefers-reduced-motion (with and without an origin)", () => {
    stubMatchMedia(true);
    const onClose = vi.fn();

    const withOrigin = render(
      <ShellScreen title="Sessions" origin={ORIGIN} onClose={onClose}>
        <p>register</p>
      </ShellScreen>,
    );
    expect(screen.getByText("register")).not.toBeNull();
    // Reduced motion takes the instant path — pinned on the morph attr.
    expect(
      screen.getByRole("dialog", { name: "Sessions" }).getAttribute("data-vex-morph"),
    ).toBe("reduced");
    withOrigin.unmount();

    render(
      <ShellScreen title="How Vex works" origin={null} onClose={onClose}>
        <p>guide</p>
      </ShellScreen>,
    );
    expect(screen.getByText("guide")).not.toBeNull();
    expect(
      screen.getByRole("dialog", { name: "How Vex works" }),
    ).not.toBeNull();
  });
});
