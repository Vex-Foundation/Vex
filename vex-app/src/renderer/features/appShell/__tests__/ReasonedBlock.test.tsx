/**
 * PERSISTED REASONING block (contract C1).
 *
 * The load-bearing case is NULL vs PRESENT: until Lane ENGINE lands (and
 * forever, for legacy rows and providers that emit no reasoning) `reasoning`
 * is null, and the block must render NOTHING — an empty "Reasoned" affordance
 * that opens onto nothing is a worse lie than an absent one.
 *
 * Also pins that the stamp matches the island's post-thinking stamp, and that
 * a count we do not have is OMITTED rather than estimated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { ReasonedBlock } from "../ReasonedBlock.js";

describe("ReasonedBlock", () => {
  it.each([
    ["null (legacy row / provider emitted none)", null],
    ["undefined (row model has no field)", undefined],
    ["an empty string", ""],
  ])("renders NOTHING for %s", (_label, reasoning) => {
    const { container } = render(
      createElement(ReasonedBlock, { reasoning: reasoning as string | null }),
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the collapsed stamp plus a ONE-LINE summary when reasoning is present", () => {
    const { container } = render(
      createElement(ReasonedBlock, {
        reasoning: "I weighed the options\nthen checked the balances\nand decided",
      }),
    );
    expect(container.querySelector('[data-vex-reasoning="persisted"]')).not.toBeNull();
    const btn = screen.getByRole("button", { name: /Reasoned/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // Collapsed by default: the summary is the FIRST line and nothing more, so
    // a long trace still never buries the answer it produced.
    const summary = container.querySelector("[data-vex-reasoning-summary]");
    expect(summary?.textContent).toBe("I weighed the options");
    expect(container.textContent).not.toContain("then checked the balances");
    expect(container.textContent).not.toContain("and decided");
  });

  it("expands through aria-controls and renders the trace as MARKDOWN", () => {
    const { container } = render(
      createElement(ReasonedBlock, { reasoning: "weighed the **ledger**" }),
    );
    const btn = screen.getByRole("button", { name: /Reasoned/ });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const body = document.getElementById(btn.getAttribute("aria-controls")!);
    expect(body).not.toBeNull();
    expect(body?.querySelector("strong")?.textContent).toBe("ledger");
  });

  it("omits a token count we do not have, and prints one we do", () => {
    const bare = render(createElement(ReasonedBlock, { reasoning: "t" }));
    expect(screen.getByRole("button", { name: /Reasoned/ }).textContent).toBe(
      "Reasoned",
    );
    bare.unmount();

    render(createElement(ReasonedBlock, { reasoning: "t", tokens: 1234 }));
    // Identical grammar to the island's post-thinking stamp.
    expect(
      screen.getByRole("button", { name: /Reasoned/ }).textContent,
    ).toContain("Reasoned · 1.2K tokens");
  });

  it("never renders markup from the trace (safe React elements only)", () => {
    const { container } = render(
      createElement(ReasonedBlock, {
        reasoning: '<img src=x onerror="alert(1)">',
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Reasoned/ }));
    expect(container.querySelector("img")).toBeNull();
  });

  it("drops the moving summary once expanded", () => {
    const { container } = render(
      createElement(ReasonedBlock, {
        reasoning: "first line\nsecond line",
        running: true,
      }),
    );
    expect(container.querySelector("[data-vex-reasoning-summary]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Reasoned/ }));
    // Expanded, the full trace is in ordinary page flow — page reading must
    // never fight an internal follower.
    expect(container.querySelector("[data-vex-reasoning-summary]")).toBeNull();
  });

  it("announces a running trace in text, since the sweep is colour-only", () => {
    const running = render(
      createElement(ReasonedBlock, { reasoning: "t", running: true }),
    );
    expect(running.container.querySelector(".sr-only")?.textContent).toBe(
      "Reasoning",
    );
    expect(
      running.container.querySelector('[data-vex-sweep="running"]'),
    ).not.toBeNull();
    running.unmount();

    const settled = render(createElement(ReasonedBlock, { reasoning: "t" }));
    expect(settled.container.querySelector(".sr-only")).toBeNull();
    expect(
      settled.container.querySelector('[data-vex-sweep="running"]'),
    ).toBeNull();
  });
});

/**
 * THE ONE-LINE FOLLOWER (deepseek ReasoningRow). Deterministic through a
 * stubbed rAF map stepped by `flushAnimationFrames` — the 3-frame throttle is
 * the subject, so a wall-clock sleep would prove nothing about it.
 */
describe("ReasonedBlock streaming summary follower", () => {
  let nextFrameId = 1;
  let frames = new Map<number, FrameRequestCallback>();

  function flushAnimationFrames(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(index);
    }
  }

  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the latest streaming line to its end, then restores the settled first line", () => {
    const view = render(
      createElement(ReasonedBlock, {
        reasoning: "Inspect the session\nNewest reasoning tokens",
        running: true,
      }),
    );
    const summary = view.container.querySelector(
      "[data-vex-reasoning-summary]",
    ) as HTMLElement;
    // While running the summary is the LATEST line, not the first.
    expect(summary.textContent).toBe("Newest reasoning tokens");
    Object.defineProperties(summary, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 100 },
    });

    view.rerender(
      createElement(ReasonedBlock, {
        reasoning: "Inspect the session\nNewest reasoning tokens keep arriving",
        running: true,
      }),
    );
    // Throttled: nothing moves until the third frame.
    expect(summary.scrollLeft).toBe(0);
    flushAnimationFrames(2);
    expect(summary.scrollLeft).toBe(0);
    flushAnimationFrames(1);
    expect(summary.scrollLeft).toBe(300 - 100);
    expect(summary.getAttribute("data-follow-end")).toBe("true");
    // Clipped, not ellipsized: an ellipsis on a line being scrolled to its own
    // end claims there is more to the right than there is.
    expect(summary.className).toContain("text-clip");

    view.rerender(
      createElement(ReasonedBlock, {
        reasoning: "Inspect the session\nNewest reasoning tokens keep arriving",
        running: false,
      }),
    );
    flushAnimationFrames(3);
    expect(summary.textContent).toBe("Inspect the session");
    expect(summary.scrollLeft).toBe(0);
    expect(summary.hasAttribute("data-follow-end")).toBe(false);
    expect(summary.className).toContain("text-ellipsis");
  });

  it("cancels its pending frame on unmount", () => {
    const view = render(
      createElement(ReasonedBlock, { reasoning: "a", running: true }),
    );
    view.rerender(createElement(ReasonedBlock, { reasoning: "ab", running: true }));
    expect(frames.size).toBeGreaterThan(0);
    view.unmount();
    expect(frames.size).toBe(0);
  });
});
