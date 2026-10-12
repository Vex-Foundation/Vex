/**
 * CurtainExit: the page turn from the unlock into the spread
 * (docs/design/V10-SPREAD.md section 10).
 *
 * jsdom pins the REDUCED-MOTION contract (the animated path is visual):
 *   - `onCovered` fires exactly once, on mount, while the turn is rendered
 *     (the caller flips the view machine here),
 *   - `onDone` fires after the 240ms crossfade, never before `onCovered`,
 *   - the turn carries the stage hooks (`data-vex-screen`, the stage print
 *     over the `.vex-gate-plate` fill, and the paper leaf already in place)
 *     so the cover is the same picture the stage showed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";

beforeEach(() => {
  // Force the reduced-motion (instant swap) path — deterministic in jsdom.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const { CurtainExit } = await import("../CurtainExit.js");

describe("CurtainExit (reduced motion)", () => {
  it("renders the print and the leaf, fires onCovered once on mount, then onDone after the crossfade", async () => {
    const calls: string[] = [];
    const onCovered = vi.fn(() => calls.push("covered"));
    const onDone = vi.fn(() => calls.push("done"));

    const { container } = render(
      <CurtainExit onCovered={onCovered} onDone={onDone} />,
    );

    expect(
      container.querySelector('[data-vex-screen="exit-curtain"]'),
    ).not.toBeNull();
    expect(container.querySelector(".vex-gate-plate")).not.toBeNull();
    expect(
      container.querySelector('.vex-turn__print [data-vex-print-plate]'),
    ).not.toBeNull();
    expect(container.querySelector(".vex-turn__leaf")).not.toBeNull();
    // Opacity only under reduced motion: base.css's documented opt-out.
    expect(
      container
        .querySelector('[data-vex-screen="exit-curtain"]')
        ?.hasAttribute("data-vex-motion-opacity"),
    ).toBe(true);
    expect(onCovered).toHaveBeenCalledTimes(1);

    // Generous timeout: if the reduced-motion stub were ever missed, the
    // animated path (~0.75s) must still resolve rather than flake.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    // The view flip always precedes the unmount signal.
    expect(calls).toEqual(["covered", "done"]);
    expect(onCovered).toHaveBeenCalledTimes(1);
  });

  it("finishes after the view flip rerenders its parent", async () => {
    const onDone = vi.fn();
    const onCovered = vi.fn();

    function Harness() {
      const [, forceRender] = useState(0);
      return (
        <CurtainExit
          onCovered={() => {
            onCovered();
            forceRender((value) => value + 1);
          }}
          onDone={() => onDone()}
        />
      );
    }

    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    expect(onCovered).toHaveBeenCalledTimes(1);
  });
});
