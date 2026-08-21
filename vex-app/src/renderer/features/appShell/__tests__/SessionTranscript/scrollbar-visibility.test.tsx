/**
 * The auto-hide overlay scrollbar's JS half.
 *
 * Only the HANDSHAKE is testable here — jsdom paints nothing, so whether the
 * thumb actually fades is a browser question. What this suite owes is the
 * contract the stylesheet depends on: the attribute appears the moment the
 * surface scrolls, survives a burst without being rewritten per event, and is
 * gone after the idle window.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useCallback, useRef, useState, type JSX } from "react";
import { useScrollbarVisibility } from "../../../../lib/useScrollbarVisibility.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useScrollbarVisibility(ref);
  return <div ref={ref} data-testid="scroller" />;
}

function scroller(): HTMLElement {
  const el = document.querySelector("[data-testid='scroller']");
  if (el === null) throw new Error("scroller not found");
  return el as HTMLElement;
}

/**
 * A consumer whose scroll node attaches AFTER the first commit - the shape
 * `SessionTranscript` has, because it renders a node-less loading branch first.
 */
function LateHarness(): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [attached, setAttached] = useState(false);
  // Stable callback ref, exactly like `useTranscriptScroll`'s: an inline one
  // detaches and reattaches on every render.
  const setNode = useCallback((node: HTMLDivElement | null): void => {
    ref.current = node;
    setEpoch((n) => n + 1);
  }, []);
  useScrollbarVisibility(ref, epoch);
  return (
    <>
      <button type="button" onClick={() => setAttached(true)}>
        attach
      </button>
      {attached ? (
        <div ref={setNode} data-testid="scroller" />
      ) : null}
    </>
  );
}

describe("useScrollbarVisibility", () => {
  it("marks the surface while it scrolls and clears it after the idle window", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const el = scroller();
    expect(el.hasAttribute("data-vex-scrolling")).toBe(false);

    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(el.getAttribute("data-vex-scrolling")).toBe("");

    // Still scrolling → still marked.
    act(() => {
      vi.advanceTimersByTime(800);
      el.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(800);
    });
    expect(el.hasAttribute("data-vex-scrolling")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(el.hasAttribute("data-vex-scrolling")).toBe(false);
  });

  it("writes the attribute ONCE per burst, not once per event", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const el = scroller();
    const setAttribute = vi.spyOn(el, "setAttribute");

    act(() => {
      for (let i = 0; i < 50; i++) el.dispatchEvent(new Event("scroll"));
    });

    // A scroll burst is dozens of events; an attribute write per event would be
    // dozens of style invalidations on the surface that is already paying for
    // the stream's own layout reads.
    expect(setAttribute).toHaveBeenCalledTimes(1);
  });

  it("re-shows after an idle gap - a later scroll arms it again", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const el = scroller();

    act(() => {
      el.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(1100);
    });
    expect(el.hasAttribute("data-vex-scrolling")).toBe(false);

    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(el.hasAttribute("data-vex-scrolling")).toBe(true);
  });

  it("listens PASSIVELY so it can never block a scroll", () => {
    const addEventListener = vi.spyOn(
      HTMLDivElement.prototype,
      "addEventListener",
    );
    render(<Harness />);
    // React registers its own delegated scroll listener on the same node, so
    // match on OUR registration rather than the first one seen.
    const passiveScroll = addEventListener.mock.calls.filter(
      ([type, , options]) =>
        type === "scroll" &&
        typeof options === "object" &&
        options !== null &&
        options.passive === true,
    );
    expect(passiveScroll.length).toBeGreaterThan(0);
  });

  it("binds a LATE-ATTACHING node through the attachment epoch", () => {
    // The transcript renders its loading branch first, so `ref.current` is null
    // when the effect would otherwise run its only pass. Keyed on the ref
    // alone, the real scroller never got a listener at all (codex 4.5).
    vi.useFakeTimers();
    render(<LateHarness />);
    act(() => {
      document.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const el = scroller();
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(el.getAttribute("data-vex-scrolling")).toBe("");
  });

  it("cleans up its listener and its mark on unmount", () => {
    vi.useFakeTimers();
    const view = render(<Harness />);
    const el = scroller();
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(el.hasAttribute("data-vex-scrolling")).toBe(true);

    view.unmount();
    expect(el.hasAttribute("data-vex-scrolling")).toBe(false);
  });
});
