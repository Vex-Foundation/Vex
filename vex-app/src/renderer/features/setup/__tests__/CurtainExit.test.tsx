/**
 * CurtainExit: the unlock's handoff to the shell, a 240ms crossfade of the stage's plate
 * (`docs/design/R3-MINIMAL.md section 10.2`).
 *
 * jsdom pins the REDUCED-MOTION contract (the animated path is visual):
 *   - `onCovered` fires exactly once, on mount, while the turn is rendered (the caller flips the
 *     view machine here),
 *   - `onDone` fires after the 240ms crossfade, never before `onCovered`,
 *   - the plate is asked to lift away (`stageVexExit`) only when the unlock returns to the
 *     shell; back into the wizard its screens stand on the same print and nothing lifts,
 *   - the turn carries its seams and paints nothing else: the plate itself is the stage's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";

beforeEach(() => {
  // Force the reduced-motion (instant swap) path, deterministic in jsdom.
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
  resetStageVex();
});

const { CurtainExit } = await import("../CurtainExit.js");
const { getStageVex, resetStageVex } = await import(
  "../../../components/onboarding/stage-vex.js"
);

describe("CurtainExit (reduced motion)", () => {
  it("fires onCovered once on mount, then onDone after the crossfade", async () => {
    const calls: string[] = [];
    const onCovered = vi.fn(() => calls.push("covered"));
    const onDone = vi.fn(() => calls.push("done"));

    const { container } = render(
      <CurtainExit onCovered={onCovered} onDone={onDone} />,
    );

    const turn = container.querySelector('[data-vex-screen="exit-curtain"]');
    expect(turn).not.toBeNull();
    expect(turn?.getAttribute("data-vex-turn-target")).toBe("appShell");
    // The turn is a shield: no print, no leaf, no eagle of its own.
    expect(turn?.childElementCount).toBe(0);
    // Opacity only under reduced motion: base.css's documented opt-out.
    expect(turn?.hasAttribute("data-vex-motion-opacity")).toBe(true);
    expect(onCovered).toHaveBeenCalledTimes(1);

    // Generous timeout: if the reduced-motion stub were ever missed, the
    // animated path (~0.25s) must still resolve rather than flake.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    // The view flip always precedes the unmount signal.
    expect(calls).toEqual(["covered", "done"]);
    expect(onCovered).toHaveBeenCalledTimes(1);
  });

  it("lifts the plate away when the unlock returns to the shell", async () => {
    const { container } = render(
      <CurtainExit onCovered={vi.fn()} onDone={vi.fn()} target="appShell" />,
    );
    expect(getStageVex().exit).toBe("idle");
    await waitFor(() => expect(getStageVex().exit).toBe("reveal"));
    expect(
      container
        .querySelector('[data-vex-screen="exit-curtain"]')
        ?.getAttribute("data-vex-curtain-phase"),
    ).toBe("reveal");
  });

  it("leaves the plate alone when the unlock returns to the wizard", async () => {
    const onDone = vi.fn();
    render(<CurtainExit onCovered={vi.fn()} onDone={onDone} target="wizard" />);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(getStageVex().exit).toBe("idle");
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
