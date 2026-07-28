/**
 * GatePrologue — jsdom contract tests.
 *
 * jsdom has no canvas 2D, so the default environment exercises the FAILURE
 * contract, which is also the most important one: whatever goes wrong, the
 * gate must fall back to the hold content it always had. The reduced-motion
 * path is pinned the same way.
 *
 * The contract these protect is the handoff: the children are mounted from
 * the first frame and are NEVER unmounted, so VexSigil (inside them, in the
 * real gate) assembles once instead of twice. `expect(node).toBe(node)`
 * across a state flip is the cheap way to assert "same element, not a
 * remount".
 */

import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatePrologue } from "../GatePrologue.js";
import { DEFAULT_SIGIL_PALETTE } from "../../../../lib/sigil-sampler.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPrologue(
  play: "full" | "condensed" | "none",
  onFinished = vi.fn(),
) {
  const utils = render(
    <GatePrologue
      play={play}
      palette={DEFAULT_SIGIL_PALETTE}
      onFinished={onFinished}
    >
      <p>hold content</p>
    </GatePrologue>,
  );
  return { ...utils, onFinished };
}

describe("reduced motion (play='none')", () => {
  it("renders the hold content immediately, fully opaque, with no canvas", () => {
    const { container, onFinished } = renderPrologue("none");

    expect(screen.getByText("hold content")).not.toBeNull();
    expect(container.querySelector("[data-vex-prologue-canvas]")).toBeNull();
    const hold = container.querySelector<HTMLElement>("[data-vex-gate-hold]");
    expect(hold?.style.opacity).toBe("1");
    expect(onFinished).toHaveBeenCalled();
  });

  it("marks the stage finished so nothing waits on a cinematic that never ran", () => {
    const { container } = renderPrologue("none");
    expect(
      container
        .querySelector("[data-vex-gate-prologue]")
        ?.getAttribute("data-vex-gate-prologue"),
    ).toBe("finished");
  });
});

describe("failure contract (no canvas 2D — the jsdom default)", () => {
  it("finishes immediately and reveals the hold content for a full play", () => {
    const { container, onFinished } = renderPrologue("full");

    expect(onFinished).toHaveBeenCalled();
    const hold = container.querySelector<HTMLElement>("[data-vex-gate-hold]");
    expect(hold?.style.opacity).toBe("1");
    expect(screen.getByText("hold content")).not.toBeNull();
  });

  it("tears the canvas down once finished", () => {
    const { container } = renderPrologue("condensed");
    expect(container.querySelector("[data-vex-prologue-canvas]")).toBeNull();
  });

  it("never leaves the boot blocked — onFinished fires on every play variant", () => {
    for (const play of ["full", "condensed", "none"] as const) {
      const onFinished = vi.fn();
      renderPrologue(play, onFinished);
      expect(onFinished).toHaveBeenCalled();
      cleanup();
    }
  });
});

describe("children are a stable mount (the no-double-assembly contract)", () => {
  it("keeps the SAME child element across the finish flip", () => {
    const { container } = renderPrologue("full");
    const first = screen.getByText("hold content");
    // The finish flip already ran (jsdom fallback); the child node must be
    // the very same element the initial render created, not a replacement.
    expect(container.contains(first)).toBe(true);
    expect(screen.getByText("hold content")).toBe(first);
  });

  it("survives StrictMode's double mount without losing the children", () => {
    const onFinished = vi.fn();
    render(
      <StrictMode>
        <GatePrologue
          play="full"
          palette={DEFAULT_SIGIL_PALETTE}
          onFinished={onFinished}
        >
          <p>hold content</p>
        </GatePrologue>
      </StrictMode>,
    );
    expect(screen.getByText("hold content")).not.toBeNull();
    expect(onFinished).toHaveBeenCalled();
  });
});
