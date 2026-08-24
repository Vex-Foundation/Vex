/**
 * Pre-shell token scope reaches PORTALED surfaces.
 *
 * The bug: `[data-vex-gate]` lived only on the SetupFrame `<main>`, while
 * toasts, hover cards and menus portal to `document.body` - outside that
 * subtree. A surface opened from a pre-shell screen therefore silently
 * reverted to shell values: shell hairlines, no `--vex-accent-text`, the
 * shell type scale and no pre-shell micro-label weight. SetupFrame now stamps the scope on
 * documentElement for its own lifetime, which every portal target inherits.
 *
 * These assertions are about SCOPE REACH (which nodes the selector can
 * match), not about resolved colour: jsdom applies no Tailwind cascade, so
 * a computed-style read here would prove nothing. The lifetime contract -
 * stamped on mount, retracted only after the LAST frame unmounts - is the
 * part that regresses silently, so it is asserted directly.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createPortal } from "react-dom";
import { SetupFrame } from "../SetupFrame.js";

const GATE_SELECTOR = '[data-vex-gate="true"]';

/** A stand-in for any body-portaled surface (toast, hover card, menu). */
function PortaledSurface(): React.ReactPortal {
  return createPortal(
    <div data-testid="portaled">Open logs folder</div>,
    document.body,
  );
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset["vexGate"];
});

describe("pre-shell gate scope", () => {
  it("stamps documentElement while a pre-shell screen is mounted", () => {
    expect(document.documentElement.matches(GATE_SELECTOR)).toBe(false);
    render(<SetupFrame screen="unlock">body</SetupFrame>);
    expect(document.documentElement.matches(GATE_SELECTOR)).toBe(true);
  });

  it("a body-portaled surface resolves the gate scope from an ancestor", () => {
    const { getByTestId } = render(
      <SetupFrame screen="unlock">
        <PortaledSurface />
      </SetupFrame>,
    );
    const portaled = getByTestId("portaled");
    // The whole point: the node is NOT inside the frame...
    expect(portaled.closest('main[data-vex-gate="true"]')).toBeNull();
    // ...yet the scope still reaches it, because the root carries it.
    expect(portaled.closest(GATE_SELECTOR)).toBe(document.documentElement);
  });

  it("retracts the scope on unmount", () => {
    const { unmount } = render(<SetupFrame screen="unlock">body</SetupFrame>);
    unmount();
    expect(document.documentElement.matches(GATE_SELECTOR)).toBe(false);
  });

  it("survives a crossfade: two frames mounted, the outgoing one leaving", () => {
    // AnimatePresence keeps the outgoing screen mounted while the incoming
    // one enters. An unguarded cleanup would retract the scope right here.
    const outgoing = render(<SetupFrame screen="migrations">a</SetupFrame>);
    const incoming = render(<SetupFrame screen="unlock">b</SetupFrame>);
    outgoing.unmount();
    expect(document.documentElement.matches(GATE_SELECTOR)).toBe(true);
    incoming.unmount();
    expect(document.documentElement.matches(GATE_SELECTOR)).toBe(false);
  });

  it("keeps the scope on the frame itself for in-tree consumers", () => {
    const { container } = render(<SetupFrame screen="unlock">body</SetupFrame>);
    expect(container.querySelector(`main${GATE_SELECTOR}`)).not.toBeNull();
  });
});
