/**
 * ShellScreen - the shared page chrome (docs/design/R3-MINIMAL.md sections
 * 2.3, 9.2, 9.6 and 12).
 *
 * Contract pinned here:
 *   1. renders as a modal dialog named by its title, with the serif page head
 *      as its h1 (or a visually hidden h1 when the page draws none), and NO
 *      crumb or close row of its own: the title bar carries the crumb and,
 *      where a page has no other way back, its close key;
 *   2. the page is ONE paper sheet (`vex-ov`: absolute inside the centre
 *      column, under the title bar, radius 0, no glass) - never an in-flow
 *      flex child that could reflow the shell columns - and declares its FLIP
 *      morph anchor via `data-vex-morph` ("trigger" with an origin rect,
 *      "center" without, "reduced" under prefers-reduced-motion) and its
 *      column via `data-width`. Classes/attrs only - the animation frames
 *      themselves are not assertable in jsdom;
 *   3. Escape (from anywhere - the listener rides window) fires `onClose`, but
 *      ONLY while this screen owns the key: never over an already-handled
 *      event, never while a native `<dialog>` is open above it, and never
 *      twice for one instance (the host animates the screen out, so the
 *      listener outlives the close);
 *   4. reduced motion renders the final frame safely (no enter animation
 *      required for the content to be present), with or without an origin;
 *   5. the optional `header` slot replaces the serif H1 while `title` keeps
 *      naming the dialog and the close key (token-history screen contract);
 *   6. focus returns to the trigger control on unmount (and is never stolen
 *      from a control another surface focused meanwhile);
 *   7. Escape returns to the PREVIOUS route: the page the user came from, else
 *      the host's close. Going up a crumb cuts the way back; a return to the
 *      bare shell forgets it; a move within one page never counts as a step.
 */

import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "../../../../stores/uiStore.js";
import { ShellScreen } from "../ShellScreen.js";
import { goUpToPage } from "../page-trail.js";

const ORIGIN = { x: 10, y: 620, width: 240, height: 44 };

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  // A return to the bare shell also empties the way back.
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  useUiStore.setState({ shellRoute: { kind: "none" } });
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
  it("opens as a titled modal dialog with the serif head as its h1, and no crumb or close row", () => {
    render(
      <ShellScreen title="Memory" origin={ORIGIN} onClose={vi.fn()}>
        <p>screen content</p>
      </ShellScreen>,
    );

    const overlay = screen.getByRole("dialog", { name: "Memory" });
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { level: 1, name: "Memory" })).not.toBeNull();
    expect(screen.getByText("screen content")).not.toBeNull();
    // The title bar says where you are; the page starts with its content.
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is a fixed full-app overlay declaring its FLIP morph anchor - never an in-flow sheet", () => {
    const withOrigin = render(
      <ShellScreen title="Memory" origin={ORIGIN} onClose={vi.fn()}>
        <p>screen content</p>
      </ShellScreen>,
    );
    const overlay = screen.getByRole("dialog", { name: "Memory" });
    // The class contract that keeps the overlay OUT of shell flow (its rules
    // live in overlay.css). Pinned as classes: jsdom does not lay out CSS.
    expect(overlay.classList.contains("vex-ov")).toBe(true);
    for (const cls of ["fixed", "inset-2", "rounded-2xl", "backdrop-blur-xl"]) {
      expect(overlay.classList.contains(cls), `retired class: ${cls}`).toBe(false);
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

  it("leaves Escape to a native dialog open above it, and does not swallow the key", () => {
    const onClose = vi.fn();
    render(
      <ShellScreen title="Settings" origin={null} onClose={onClose}>
        <p>preferences</p>
      </ShellScreen>,
    );

    // A modal dialog opened OVER the screen. The regression this pins: the
    // screen took the key and called `preventDefault`, which suppresses the
    // platform's own close request, so the dialog stayed open with the user's
    // Escape swallowed - measured in the Studio keyboard walk, where the
    // creator opened over a Settings screen that was still animating out.
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "New project");
    document.body.append(dialog);
    dialog.showModal();

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(escape);

    expect(onClose).not.toHaveBeenCalled();
    // Not merely "did not close": the key must reach the platform untouched.
    expect(escape.defaultPrevented).toBe(false);

    dialog.close();
    dialog.remove();
    // With the dialog gone the screen owns Escape again.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks to close once per instance, so a screen animating out stops taking Escape", () => {
    const onClose = vi.fn();
    render(
      <ShellScreen title="Settings" origin={null} onClose={onClose}>
        <p>preferences</p>
      </ShellScreen>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The host (`ShellScreens`) animates the screen out, so this component and
    // its window listener outlive the close. A second Escape belongs to
    // whatever is on screen next.
    const second = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(second);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
  });

  it("never takes an Escape a nearer owner already handled", () => {
    const onClose = vi.fn();
    render(
      <ShellScreen title="Sessions" origin={null} onClose={onClose}>
        <p>ledger</p>
      </ShellScreen>,
    );

    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders the `header` slot in place of the serif H1 while `title` still names the dialog", () => {
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

    // The dialog stays named by `title` (a11y contract)…
    expect(
      screen.getByRole("dialog", { name: "USD Coin history" }),
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
    // The page claims focus on open (the dialog itself)…
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Memory" }));

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
    // Reduced motion takes the instant path - pinned on the morph attr.
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

describe("ShellScreen - the page chrome", () => {
  it("draws the column it was given, reading by default", () => {
    const reading = render(
      <ShellScreen title="Memory" origin={null} onClose={vi.fn()}>
        <p>notes</p>
      </ShellScreen>,
    );
    expect(screen.getByRole("dialog", { name: "Memory" }).getAttribute("data-width")).toBe("reading");
    reading.unmount();

    render(
      <ShellScreen title="Agent Scan" origin={null} onClose={vi.fn()} width="wide" chapter={null}>
        <p>ledger</p>
      </ShellScreen>,
    );
    expect(screen.getByRole("dialog", { name: "Agent Scan" }).getAttribute("data-width")).toBe("wide");
  });

  it("keeps an h1 for a page that draws no serif head", () => {
    render(
      <ShellScreen title="Agent Scan" origin={null} onClose={vi.fn()} chapter={null}>
        <p>ledger</p>
      </ShellScreen>,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Agent Scan" });
    expect(heading.classList.contains("sr-only")).toBe(true);
    expect(document.querySelector("[data-vex-chapter]")).toBeNull();
  });

  it("closes back to the page the user came from, without its stale trigger rect", () => {
    const onClose = vi.fn();
    render(
      <ShellScreen title="Agent Scan" origin={null} onClose={onClose}>
        <p>ledger</p>
      </ShellScreen>,
    );
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "portfolio", origin: ORIGIN });
    });
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "agentScan", origin: ORIGIN, sessionId: null });
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "portfolio", origin: null });
  });

  it("walks back one page per close, then hands the last close to the host", () => {
    const onClose = vi.fn();
    const view = render(
      <ShellScreen key="a" title="All assets" origin={null} onClose={onClose}>
        <p>register</p>
      </ShellScreen>,
    );
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "portfolio", origin: null });
    });
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "assets", origin: null, sessionId: null });
    });
    act(() => {
      useUiStore.getState().setShellRoute({
        kind: "tokenHistory",
        origin: null,
        token: { chainId: 8453, tokenAddress: "0xabc", symbol: "USDC", tokenName: "USD Coin" },
        returnTo: { kind: "assets", sessionId: null },
      });
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute.kind).toBe("assets");

    // A fresh page instance for the next step (the host remounts per route).
    view.rerender(
      <ShellScreen key="b" title="All assets" origin={null} onClose={onClose}>
        <p>register</p>
      </ShellScreen>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute.kind).toBe("portfolio");

    view.rerender(
      <ShellScreen key="c" title="Portfolio" origin={null} onClose={onClose}>
        <p>total</p>
      </ShellScreen>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("going up a crumb cuts the way back, so a later close does not walk down again", () => {
    const onClose = vi.fn();
    const view = render(
      <ShellScreen key="a" title="Agent Scan" origin={null} onClose={onClose}>
        <p>ledger</p>
      </ShellScreen>,
    );
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "portfolio", origin: null });
    });
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "agentScan", origin: null, sessionId: null });
    });
    // The title bar's crumb link goes up through the trail.
    act(() => {
      goUpToPage({ kind: "portfolio", origin: null });
    });
    expect(useUiStore.getState().shellRoute.kind).toBe("portfolio");

    view.rerender(
      <ShellScreen key="b" title="Portfolio" origin={null} onClose={onClose}>
        <p>total</p>
      </ShellScreen>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("forgets the way back on a return to the bare shell, and never counts a move within one page", () => {
    const onClose = vi.fn();
    const view = render(
      <ShellScreen key="a" title="Settings" origin={null} onClose={onClose}>
        <p>preferences</p>
      </ShellScreen>,
    );
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "portfolio", origin: null });
    });
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "settings", origin: null, section: null });
    });
    // Another section of the same page: not a step.
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "settings", origin: null, section: "wallets" });
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "portfolio", origin: null });

    // Back to the chat, then a page again: nothing to return to but the host.
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "none" });
    });
    act(() => {
      useUiStore.getState().setShellRoute({ kind: "memory", origin: null });
    });
    view.rerender(
      <ShellScreen key="b" title="Memory" origin={null} onClose={onClose}>
        <p>notes</p>
      </ShellScreen>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
