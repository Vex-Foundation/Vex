/**
 * The first run on the H3 stage (docs/design/H3-DESKTOP.md section 4.9; the plates
 * `stage-system-check` and `stage-system-check-blocked`, approved as drawn): where you are in the
 * left column (System check, Local runtime, Database, Setup) and what Vex shows for what the
 * screen is doing.
 *
 * A screen names its step and its mood to `SetupFrame`. The mood says three things: the square of
 * the left column's current step, the Vex key's word over her column ("Working" with a timer,
 * "Ready", "Concerned", "Error"), and her mood on her stage. The timer is the real time since the
 * screen began its work, never a loop.
 *
 *   working    the screen is doing something now (probing, starting, applying): the grey square
 *   ready      nothing is in flight and nothing is wrong: the ink square
 *   concerned  the screen needs the person to look (the network offline, a data move waiting on
 *              its source): the ink square
 *   error      something failed: the red square
 *   blocked    a failure holds Continue until the person acts (a disk with no room for setup):
 *              the red square, and Kimm offers the next move (the plate's "held", her open palm)
 */

import { useEffect, useRef, useState } from "react";
import { kimmMoodOf } from "../../features/vex/kimm-mood.js";
import type { StageSquareKind, StageStep, StageWhere } from "./StageFrame.js";
import {
  formatCountdown,
  stageVexFace,
  stageVexFaceClear,
  type StageVexView,
} from "./stage-vex.js";

/**
 * The first run's steps. `runtime` covers the bundled local runtime's start
 * and, before it on an upgrade, the move of the previous release's data.
 */
export type FirstRunStep = "systemCheck" | "runtime" | "database";
export type FirstRunMood = "working" | "ready" | "concerned" | "error" | "blocked";

/** The four stages of the first run, in order. The wizard is the last. */
export const FIRST_RUN_STAGES: readonly { readonly id: FirstRunStep | "setup"; readonly label: string }[] = [
  { id: "systemCheck", label: "System check" },
  { id: "runtime", label: "Local runtime" },
  { id: "database", label: "Database" },
  { id: "setup", label: "Setup" },
];

/** The left column's name for the first run. */
export const FIRST_RUN_LABEL = "First run";

/**
 * What Vex shows for a mood: the Vex key's state and word, and her mood, through the shell's own
 * map (`kimmMoodOf`) but for the blocked check, where the approved plate draws her offering the
 * way on (`offer`) beside the word Error.
 */
export function moodFace(mood: FirstRunMood, timer: string | null): StageVexView {
  switch (mood) {
    case "working":
      return {
        emotion: "working",
        swatch: "done",
        state: "working",
        word: "Working",
        note: timer,
        mood: kimmMoodOf("working"),
      };
    case "ready":
      return {
        emotion: "idle",
        swatch: "idle",
        state: "ready",
        word: "Ready",
        note: null,
        mood: kimmMoodOf("ready"),
      };
    case "concerned":
      return {
        emotion: "concerned",
        swatch: "concerned",
        state: "concerned",
        word: "Concerned",
        note: null,
        mood: kimmMoodOf("concerned"),
      };
    case "error":
      return {
        emotion: "error",
        swatch: "error",
        state: "error",
        word: "Error",
        note: null,
        mood: kimmMoodOf("error"),
      };
    case "blocked":
      return {
        emotion: "concerned",
        swatch: "error",
        state: "error",
        word: "Error",
        note: null,
        mood: "offer",
      };
  }
}

/** The square of the left column's current step for a mood. */
export function moodSquare(mood: FirstRunMood): StageSquareKind {
  switch (mood) {
    case "working":
      return "running";
    case "ready":
    case "concerned":
      return "ink";
    case "error":
    case "blocked":
      return "failed";
  }
}

/** The first run's left column: the steps behind you done, the one you are on, the ones ahead. */
export function firstRunWhere(step: FirstRunStep, mood: FirstRunMood): StageWhere {
  const at = FIRST_RUN_STAGES.findIndex((stage) => stage.id === step);
  const steps: StageStep[] = FIRST_RUN_STAGES.map((stage, index) => {
    if (index < at) return { id: stage.id, label: stage.label, at: "done" };
    if (index === at) return { id: stage.id, label: stage.label, at: "now", square: moodSquare(mood) };
    return { id: stage.id, label: stage.label, at: "next" };
  });
  return { label: FIRST_RUN_LABEL, steps };
}

/** The title cell's second line: "First run · Step 1 of 4". */
export function firstRunSub(step: FirstRunStep): string {
  const at = FIRST_RUN_STAGES.findIndex((stage) => stage.id === step);
  return `${FIRST_RUN_LABEL} · Step ${String(at + 1)} of ${String(FIRST_RUN_STAGES.length)}`;
}

/**
 * The real time since `active` became true, as m:ss, or null while idle. One tick a second, in
 * its own component so only the face re-renders.
 */
function useElapsedNote(active: boolean): string | null {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSeconds(0);
    const id = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return active ? formatCountdown(seconds) : null;
}

/**
 * Says what Vex shows while this screen stands on the stage (renders nothing). The face is set
 * when it changes and cleared once, when the screen leaves, so a crossfade between two screens
 * never flickers through the launch's own words.
 */
export function StageFace({ mood }: { readonly mood: FirstRunMood }): null {
  const timer = useElapsedNote(mood === "working");
  const face = moodFace(mood, timer);
  const { emotion, swatch, state, word, note } = face;
  const herMood = face.mood;
  const mine = useRef<StageVexView | null>(null);
  useEffect(() => {
    const next: StageVexView = { emotion, swatch, state, word, note, mood: herMood };
    mine.current = next;
    stageVexFace(next);
  }, [emotion, swatch, state, word, note, herMood]);
  useEffect(
    () => () => {
      if (mine.current !== null) stageVexFaceClear(mine.current);
    },
    [],
  );
  return null;
}
