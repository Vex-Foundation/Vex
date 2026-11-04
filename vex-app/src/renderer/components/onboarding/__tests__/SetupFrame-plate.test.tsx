/**
 * The first run's layout of `SetupFrame` on H3's stage (docs/design/H3-DESKTOP.md section 4.9):
 * the frame's own cells (the mark, the title cell, where you are, the work column, the bottom-left
 * cell), the lead as the work column's first row, the screen's keys in its bottom row, the middle
 * column left to her stage; it tells the stage what Vex shows; and the leaf layout is untouched.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupFrame } from "../SetupFrame.js";
import { StageActs } from "../StageFrame.js";
import { getStageVex, resetStageVex, stageVexEnd } from "../stage-vex.js";

beforeEach(() => {
  resetStageVex();
  stageVexEnd();
});

afterEach(() => {
  cleanup();
  resetStageVex();
});

describe("SetupFrame, stage layout", () => {
  it("stands the page in the stage frame: title cell, where you are, the lead row, body, keys and version", () => {
    const { container, getByRole } = render(
      <SetupFrame
        layout="stage"
        screen="runtimeBootstrap"
        step="runtime"
        mood="concerned"
        title="Preparing local runtime"
        subline="Vex runs its database and embeddings locally, on this machine."
        foot={<a href="#logs">Logs</a>}
        acts={
          <StageActs>
            <button type="button">Go</button>
          </StageActs>
        }
      >
        <p>body</p>
      </SetupFrame>,
    );
    const main = container.querySelector('main[data-vex-screen="runtimeBootstrap"]');
    expect(main?.className).toBe("vex-pre");
    expect(main?.getAttribute("data-vex-onboarding")).toBe("true");
    expect(main?.getAttribute("data-vex-gate")).toBe("true");
    // The title cell: the screen's name over where it is.
    const title = main?.querySelector(".vex-pre__title");
    expect(title?.querySelector("h1")?.textContent).toBe("Preparing local runtime");
    expect(title?.querySelector(".vex-pre__sub")?.textContent).toBe("First run · Step 2 of 4");
    // The lead is the work column's first row; the body and the keys follow it.
    const work = main?.querySelector(".vex-pre__work");
    expect(work?.querySelector(".vex-pre-row--first")?.textContent).toContain("embeddings locally");
    expect(work?.querySelector(".vex-pre__body")?.textContent).toContain("body");
    expect(work?.querySelector(".vex-pre-acts")?.textContent).toBe("Go");
    // Where you are, in the left column.
    expect(getByRole("navigation", { name: "First run" }).textContent).toContain("Local runtime");
    // The bottom-left cell: the link beside the version.
    const foot = main?.querySelector(".vex-pre__foot");
    expect(foot?.textContent).toContain("Logs");
    expect(foot?.querySelector("[data-vex-version-stamp]")).not.toBeNull();
    // Her column is the stage's, not the screen's: nothing of hers is drawn here.
    expect(main?.querySelector("[data-vex-area='vex-key']")).toBeNull();
    expect(main?.querySelector("[data-vex-area='kimm-section']")).toBeNull();
    // No R3 side, leaf, sky counter or ground row.
    expect(main?.querySelector(".vex-stage-side")).toBeNull();
    expect(main?.querySelector(".vex-stage-leaf")).toBeNull();
    expect(main?.querySelector(".vex-stage-sky")).toBeNull();
    expect(main?.querySelector(".vex-stage-ground")).toBeNull();
  });

  it("tells the stage what Vex shows, and hands her back when the screen leaves", () => {
    const view = render(
      <SetupFrame layout="stage" screen="migrations" step="database" mood="working" title="Database">
        x
      </SetupFrame>,
    );
    expect(getStageVex().face).toMatchObject({ state: "working", word: "Working", mood: "think" });
    view.unmount();
    expect(getStageVex().face).toBeNull();
  });

  it("says nothing to the stage without a mood", () => {
    render(
      <SetupFrame layout="stage" screen="migrations" step="database" title="Database">
        x
      </SetupFrame>,
    );
    expect(getStageVex().face).toBeNull();
  });

  it("keeps the leaf: the sky counter, the leaf and the ground row", () => {
    const { container } = render(
      <SetupFrame screen="wizard" title="Step">
        x
      </SetupFrame>,
    );
    expect(container.querySelector(".vex-stage-sky")).not.toBeNull();
    expect(container.querySelector(".vex-stage-leaf")).not.toBeNull();
    expect(container.querySelector(".vex-stage-ground")).not.toBeNull();
    expect(container.querySelector(".vex-pre")).toBeNull();
  });
});
