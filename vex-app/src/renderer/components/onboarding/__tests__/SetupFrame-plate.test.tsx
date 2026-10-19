/**
 * The first run's layout of `SetupFrame`: the page stands at the right of the stage plate with its
 * crumb, the serif title, the lead, the body and the small version stamp; it tells the plate what
 * Vex shows; and the leaf and the open layouts are untouched for the wizard and the unlock.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupFrame } from "../SetupFrame.js";
import { getStageVex, resetStageVex, stageVexEnd } from "../stage-vex.js";

beforeEach(() => {
  resetStageVex();
  stageVexEnd();
});

afterEach(() => {
  cleanup();
  resetStageVex();
});

describe("SetupFrame, plate layout", () => {
  it("stands the page at the right of the plate: crumb, title, lead, body and version stamp", () => {
    const { container, getByRole } = render(
      <SetupFrame
        layout="plate"
        screen="runtimeBootstrap"
        step="runtime"
        mood="concerned"
        title="Preparing local runtime"
        subline="Vex runs its database and embeddings locally, on this machine."
      >
        <p>body</p>
      </SetupFrame>,
    );
    const main = container.querySelector('main[data-vex-screen="runtimeBootstrap"]');
    expect(main?.getAttribute("data-vex-onboarding")).toBe("true");
    expect(main?.getAttribute("data-vex-gate")).toBe("true");
    const side = main?.querySelector(".vex-stage-side.vex-fr-side");
    expect(side).not.toBeNull();
    expect(side?.querySelector("h1.vex-stage-title")?.textContent).toBe("Preparing local runtime");
    expect(side?.querySelector("p.vex-stage-lead")?.textContent).toContain("embeddings locally");
    expect(side?.textContent).toContain("body");
    expect(getByRole("navigation", { name: "First run" }).textContent).toContain("Local runtime");
    expect(main?.querySelector("[data-vex-version-stamp]")).not.toBeNull();
    // No leaf, no sky counter and no ground caption row on the plate layout.
    expect(main?.querySelector(".vex-stage-leaf")).toBeNull();
    expect(main?.querySelector(".vex-stage-sky")).toBeNull();
    expect(main?.querySelector(".vex-stage-ground")).toBeNull();
  });

  it("tells the plate what Vex shows, and hands her back when the screen leaves", () => {
    const view = render(
      <SetupFrame layout="plate" screen="migrations" step="database" mood="working" title="Database">
        x
      </SetupFrame>,
    );
    expect(getStageVex().face).toMatchObject({ emotion: "working", word: "Working" });
    view.unmount();
    expect(getStageVex().face).toBeNull();
  });

  it("draws no crumb without a step and says nothing to the plate without a mood", () => {
    const { container } = render(
      <SetupFrame layout="plate" screen="migrations" title="Database">
        x
      </SetupFrame>,
    );
    expect(container.querySelector(".vex-fr-crumb")).toBeNull();
    expect(getStageVex().face).toBeNull();
  });

  it("keeps the leaf for the wizard: the sky counter, the leaf and the ground row", () => {
    const { container } = render(
      <SetupFrame screen="wizard" title="Step">
        x
      </SetupFrame>,
    );
    expect(container.querySelector(".vex-stage-sky")).not.toBeNull();
    expect(container.querySelector(".vex-stage-leaf")).not.toBeNull();
    expect(container.querySelector(".vex-stage-ground")).not.toBeNull();
    expect(container.querySelector(".vex-fr-side")).toBeNull();
  });
});
