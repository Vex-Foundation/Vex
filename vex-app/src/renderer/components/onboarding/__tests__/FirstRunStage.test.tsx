/**
 * The first run's furniture on the stage plate (`FirstRunStage.tsx`): what Vex shows for each
 * mood, the crumb's current step and its fill, and the face a screen sets on the stage store and
 * clears when it leaves. The timer beside "Working" is the real time since the work began.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_STAGES,
  FirstRunCrumb,
  StageFace,
  moodCrumbFill,
  moodFace,
  type FirstRunMood,
  type FirstRunStep,
} from "../FirstRunStage.js";
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
    ["working", "working", "done", "Working"],
    ["ready", "idle", "idle", "Ready"],
    ["concerned", "concerned", "concerned", "Concerned"],
    ["error", "error", "error", "Error"],
  ])("says what Vex shows for %s: a pose, a fill and a word", (mood, emotion, swatch, word) => {
    expect(moodFace(mood, null)).toEqual({ emotion, swatch, word, note: null });
  });

  it("sets the real timer beside Working and nowhere else", () => {
    expect(moodFace("working", "0:14").note).toBe("0:14");
    expect(moodFace("ready", "0:14").note).toBeNull();
  });

  it("fills the crumb's current step: solid at work and done, a target when it waits on you, a cross on failure", () => {
    expect(moodCrumbFill("working")).toBe("done");
    expect(moodCrumbFill("ready")).toBe("done");
    expect(moodCrumbFill("concerned")).toBe("awaiting");
    expect(moodCrumbFill("error")).toBe("error");
  });
});

describe("FirstRunCrumb", () => {
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
    const { container, getByRole } = render(<FirstRunCrumb step={step} mood="working" />);
    const items = Array.from(container.querySelectorAll("li"));
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
  });

  it("draws each stage as a fill with its word: solid for done, the mood's fill for the current one, an outline for the rest", () => {
    const { container } = render(<FirstRunCrumb step="database" mood="error" />);
    const fills = Array.from(container.querySelectorAll("li .vex-swatch")).map((swatch) =>
      swatch.getAttribute("data-s"),
    );
    expect(fills).toEqual(["done", "done", "error", "idle"]);
    // A reader without the picture hears what a done stage and the failed one are.
    const spoken = Array.from(container.querySelectorAll("li .sr-only")).map((n) => n.textContent);
    expect(spoken).toEqual(["Done", "Done", "Error"]);
  });
});

describe("StageFace", () => {
  it("sets the face on the stage store and the plate's view follows it", () => {
    render(<StageFace mood="concerned" />);
    expect(stageVexView(getStageVex())).toMatchObject({
      emotion: "concerned",
      swatch: "concerned",
      word: "Concerned",
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
