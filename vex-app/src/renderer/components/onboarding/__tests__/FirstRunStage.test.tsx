/**
 * The first run on H3's stage (`FirstRunStage.tsx`, docs/design/H3-DESKTOP.md section 4.9): what
 * Vex shows for each mood (the Vex key's state and word, her mood through the shell's map), the
 * left column's steps and the current step's square, and the face a screen sets on the stage
 * store and clears when it leaves. The timer beside "Working" is the real time since the work
 * began.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_STAGES,
  StageFace,
  firstRunSub,
  firstRunWhere,
  moodFace,
  moodSquare,
  type FirstRunMood,
  type FirstRunStep,
} from "../FirstRunStage.js";
import { StageFrame } from "../StageFrame.js";
import { getStageVex, resetStageVex, stageVexEnd, stageVexView } from "../stage-vex.js";

beforeEach(() => {
  resetStageVex();
  // The launch is over: a face is the screen's, with no wake to wait for.
  stageVexEnd();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetStageVex();
});

describe("moodFace", () => {
  it.each<[FirstRunMood, string, string, string]>([
    ["working", "working", "Working", "think"],
    ["ready", "ready", "Ready", "hi"],
    ["concerned", "concerned", "Concerned", "rest"],
    ["error", "error", "Error", "rest"],
  ])("says what Vex shows for %s through the shell's mood map", (mood, state, word, herMood) => {
    expect(moodFace(mood, null)).toMatchObject({ state, word, note: null, mood: herMood });
  });

  it("offers the way on when a failure holds Continue, as the approved plate draws it", () => {
    expect(moodFace("blocked", null)).toMatchObject({ state: "error", word: "Error", mood: "offer" });
  });

  it("sets the real timer beside Working and nowhere else", () => {
    expect(moodFace("working", "0:14").note).toBe("0:14");
    expect(moodFace("ready", "0:14").note).toBeNull();
  });

  it("squares the current step: grey at work, ink when ready or concerned, red on a failure", () => {
    expect(moodSquare("working")).toBe("running");
    expect(moodSquare("ready")).toBe("ink");
    expect(moodSquare("concerned")).toBe("ink");
    expect(moodSquare("error")).toBe("failed");
    expect(moodSquare("blocked")).toBe("failed");
  });
});

describe("the first run's left column", () => {
  it("names the four stages in order", () => {
    expect(FIRST_RUN_STAGES.map((stage) => stage.label)).toEqual([
      "System check",
      "Local runtime",
      "Database",
      "Setup",
    ]);
  });

  it.each<[FirstRunStep, number]>([
    ["systemCheck", 0],
    ["runtime", 1],
    ["database", 2],
  ])("marks %s as current, the earlier stages done and the later ones next", (step, at) => {
    const { container, getByRole } = render(
      <StageFrame screen="t" title="T" sub={firstRunSub(step)} where={firstRunWhere(step, "working")}>
        {null}
      </StageFrame>,
    );
    const items = Array.from(container.querySelectorAll("nav li"));
    expect(items).toHaveLength(4);
    items.forEach((li, index) => {
      expect(li.getAttribute("data-state")).toBe(
        index < at ? "done" : index === at ? "now" : "next",
      );
    });
    expect(getByRole("navigation", { name: "First run" })).toBeTruthy();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      FIRST_RUN_STAGES[at]?.label ?? "",
    );
    // The column's head counts the step, as the title cell's second line says it.
    expect(container.querySelector(".vex-pre__count")?.textContent).toBe(`${String(at + 1)}/4`);
    expect(firstRunSub(step)).toBe(`First run · Step ${String(at + 1)} of 4`);
  });

  it("draws the steps behind you green and DONE, the current one by its mood, the rest an outline", () => {
    const { container } = render(
      <StageFrame screen="t" title="T" sub="" where={firstRunWhere("database", "error")}>
        {null}
      </StageFrame>,
    );
    const squares = Array.from(container.querySelectorAll("nav li .vex-pre-sq")).map((sq) =>
      sq.getAttribute("data-sq"),
    );
    expect(squares).toEqual(["done", "done", "failed", "none"]);
    const words = Array.from(container.querySelectorAll("nav li")).map(
      (li) => li.querySelector(".vex-pre__step-word")?.textContent ?? null,
    );
    expect(words).toEqual(["Done", "Done", null, null]);
  });
});

describe("StageFace", () => {
  it("sets the face on the stage store and the stage's view follows it", () => {
    render(<StageFace mood="concerned" />);
    expect(stageVexView(getStageVex())).toMatchObject({
      state: "concerned",
      word: "Concerned",
      mood: "rest",
    });
  });

  it("changes the face when the mood changes, and clears it once when the screen leaves", () => {
    const view = render(<StageFace mood="ready" />);
    expect(getStageVex().face?.word).toBe("Ready");
    view.rerender(<StageFace mood="error" />);
    expect(getStageVex().face?.word).toBe("Error");
    view.unmount();
    expect(getStageVex().face).toBeNull();
  });

  it("does not clear a face another screen has already set", () => {
    const first = render(<StageFace mood="working" />);
    const second = render(<StageFace mood="ready" />);
    first.unmount();
    expect(getStageVex().face?.word).toBe("Ready");
    second.unmount();
    expect(getStageVex().face).toBeNull();
  });

  it("counts the real time while the screen works, and starts over when it works again", () => {
    vi.useFakeTimers();
    const view = render(<StageFace mood="working" />);
    expect(getStageVex().face?.note).toBe("0:00");
    act(() => {
      vi.advanceTimersByTime(14_000);
    });
    expect(getStageVex().face?.note).toBe("0:14");
    view.rerender(<StageFace mood="ready" />);
    expect(getStageVex().face).toMatchObject({ word: "Ready", note: null });
    view.rerender(<StageFace mood="working" />);
    expect(getStageVex().face?.note).toBe("0:00");
  });
});
