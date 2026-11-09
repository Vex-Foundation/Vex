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
  stageVexLockMood,
  stageVexPipelineReady,
  stageVexSettle,
  stageVexUnlocked,
  stageVexView,
  stageVexWoken,
} from "../stage-vex.js";

afterEach(() => {
  resetStageVex();
});

describe("stageVexView", () => {
  it("wakes on a launch: 'Waking up' and rest until she has woken and the desk is ready, then hi", () => {
    expect(stageVexView(getStageVex())).toEqual({
      state: "waking",
      word: "Waking up",
      note: null,
      mood: "rest",
    });
    stageVexWoken();
    // Woken but the pipeline is still running: the desk is not ready yet.
    expect(stageVexView(getStageVex()).word).toBe("Waking up");
    stageVexPipelineReady();
    expect(stageVexView(getStageVex())).toEqual({
      state: "ready",
      word: "Ready",
      note: null,
      mood: "hi",
    });
  });

  it("does not call the desk ready while the pipeline is done but she is still waking", () => {
    stageVexPipelineReady();
    expect(stageVexView(getStageVex()).word).toBe("Waking up");
  });

  it("sleeps and rests on a locked desk; the lock is the title cell's word, not hers", () => {
    stageVexEnd();
    expect(stageVexView(getStageVex())).toEqual({
      state: "sleeping",
      word: "Sleeping",
      note: null,
      mood: "rest",
    });
  });

  it("wakes the locked desk and looks at you once the vault unlocks", () => {
    stageVexEnd();
    stageVexUnlocked();
    expect(stageVexView(getStageVex())).toMatchObject({ state: "ready", word: "Ready", mood: "hi" });
  });

  it("is concerned over everything else, with the throttle's seconds beside it", () => {
    stageVexEnd();
    stageVexConcerned(true);
    expect(stageVexView(getStageVex())).toEqual({
      state: "concerned",
      word: "Concerned",
      note: null,
      mood: "rest",
    });
    stageVexConcerned(true, 28);
    expect(stageVexView(getStageVex()).note).toBe("0:28");
    stageVexConcerned(false);
    expect(getStageVex().countdown).toBeNull();
    expect(stageVexView(getStageVex()).word).toBe("Sleeping");
  });
});

describe("stageVexLockMood", () => {
  it("rests while the lock screen waits, after a launch and after Lock Vex alike", () => {
    expect(stageVexLockMood(getStageVex())).toBe("rest");
    stageVexWoken();
    stageVexPipelineReady();
    // The stage says hi beside a ready desk; her lock screen panel rests until the vault opens.
    expect(stageVexView(getStageVex()).mood).toBe("hi");
    expect(stageVexLockMood(getStageVex())).toBe("rest");
    stageVexEnd();
    expect(stageVexLockMood(getStageVex())).toBe("rest");
  });

  it("is concerned as the stage maps it, and says hi once the vault opens", () => {
    stageVexConcerned(true, 28);
    expect(stageVexLockMood(getStageVex())).toBe(stageVexView(getStageVex()).mood);
    stageVexConcerned(false);
    stageVexUnlocked();
    expect(stageVexLockMood(getStageVex())).toBe("hi");
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

  it("settles a spent crossfade without ending the launch", () => {
    stageVexWoken();
    stageVexExit();
    stageVexSettle();
    expect(getStageVex().exit).toBe("idle");
    expect(getStageVex().launching).toBe(true);
    expect(getStageVex().woken).toBe(true);
  });

  it("keeps one state object while nothing changes", () => {
    const before = getStageVex();
    stageVexConcerned(false);
    expect(getStageVex()).toBe(before);
  });
});

describe("a first run screen's face", () => {
  const working = {
    state: "working",
    word: "Working",
    note: "0:14",
    mood: "think",
  } as const;
  const ready = {
    state: "ready",
    word: "Ready",
    note: null,
    mood: "hi",
  } as const;

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
