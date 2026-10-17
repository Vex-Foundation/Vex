/**
 * What Vex shows on the pre-shell plate (`stage-vex.ts`): the view for each state, and the store
 * that carries it between the plate `App` mounts once and the screens that stand on it.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  formatCountdown,
  getStageVex,
  resetStageVex,
  stageVexConcerned,
  stageVexEnd,
  stageVexExit,
  stageVexFace,
  stageVexFaceClear,
  stageVexPipelineReady,
  stageVexUnlocked,
  stageVexView,
  stageVexWoken,
} from "../stage-vex.js";

afterEach(() => {
  resetStageVex();
});

describe("stageVexView", () => {
  it("wakes on a launch: the dot screen and 'Waking up' until she has woken and the desk is ready", () => {
    expect(stageVexView(getStageVex())).toEqual({
      emotion: "idle",
      swatch: "listening",
      word: "Waking up",
      note: null,
    });
    stageVexWoken();
    // Woken but the pipeline is still running: the desk is not ready yet.
    expect(stageVexView(getStageVex()).word).toBe("Waking up");
    stageVexPipelineReady();
    expect(stageVexView(getStageVex())).toEqual({
      emotion: "idle",
      swatch: "done",
      word: "Ready",
      note: null,
    });
  });

  it("does not call the desk ready while the pipeline is done but she is still waking", () => {
    stageVexPipelineReady();
    expect(stageVexView(getStageVex()).word).toBe("Waking up");
  });

  it("sleeps on a locked desk, with 'Locked' set beside the word", () => {
    stageVexEnd();
    expect(stageVexView(getStageVex())).toEqual({
      emotion: "sleeping",
      swatch: "sleeping",
      word: "Sleeping",
      note: "Locked",
    });
  });

  it("wakes the locked desk and looks at you once the vault unlocks", () => {
    stageVexEnd();
    stageVexUnlocked();
    expect(stageVexView(getStageVex())).toMatchObject({ emotion: "idle", word: "Ready" });
  });

  it("is concerned over everything else, with the throttle's seconds beside it", () => {
    stageVexEnd();
    stageVexConcerned(true);
    expect(stageVexView(getStageVex())).toEqual({
      emotion: "concerned",
      swatch: "concerned",
      word: "Concerned",
      note: null,
    });
    stageVexConcerned(true, 28);
    expect(stageVexView(getStageVex()).note).toBe("0:28");
    stageVexConcerned(false);
    expect(getStageVex().countdown).toBeNull();
    expect(stageVexView(getStageVex()).word).toBe("Sleeping");
  });
});

describe("formatCountdown", () => {
  it("sets seconds as minutes and two digits", () => {
    expect(formatCountdown(28)).toBe("0:28");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(61)).toBe("1:01");
    expect(formatCountdown(-3)).toBe("0:00");
    expect(formatCountdown(27.2)).toBe("0:28");
  });
});

describe("the stage store", () => {
  it("starts on a launch and a plate that ends it starts the next one from a locked desk", () => {
    expect(getStageVex().launching).toBe(true);
    stageVexWoken();
    stageVexPipelineReady();
    stageVexConcerned(true, 3);
    stageVexExit();
    stageVexEnd();
    expect(getStageVex()).toEqual({
      launching: false,
      woken: false,
      pipelineReady: false,
      unlocked: false,
      concerned: false,
      face: null,
      countdown: null,
      exit: "idle",
    });
  });

  it("keeps one state object while nothing changes", () => {
    const before = getStageVex();
    stageVexConcerned(false);
    expect(getStageVex()).toBe(before);
  });
});

describe("a first run screen's face", () => {
  const working = { emotion: "working", swatch: "done", word: "Working", note: "0:14" } as const;
  const ready = { emotion: "idle", swatch: "idle", word: "Ready", note: null } as const;

  it("waits for the launch's wake: she never skips it", () => {
    stageVexFace(working);
    expect(stageVexView(getStageVex()).word).toBe("Waking up");
    stageVexWoken();
    expect(stageVexView(getStageVex())).toEqual(working);
  });

  it("speaks as soon as the launch is over, with no wake to wait for", () => {
    stageVexEnd();
    stageVexFace(ready);
    expect(stageVexView(getStageVex())).toEqual(ready);
  });

  it("is concerned over the face when the unlock is", () => {
    stageVexEnd();
    stageVexFace(ready);
    stageVexConcerned(true);
    expect(stageVexView(getStageVex()).word).toBe("Concerned");
  });

  it("is a value: setting the same face again changes nothing", () => {
    stageVexEnd();
    stageVexFace(ready);
    const held = getStageVex();
    stageVexFace({ ...ready });
    expect(getStageVex()).toBe(held);
  });

  it("clears only the face its own screen set, and the launch's end clears it", () => {
    stageVexEnd();
    stageVexFace(working);
    stageVexFaceClear(ready);
    expect(getStageVex().face).toEqual(working);
    stageVexFaceClear({ ...working });
    expect(getStageVex().face).toBeNull();
    stageVexFace(ready);
    stageVexEnd();
    expect(getStageVex().face).toBeNull();
  });
});
