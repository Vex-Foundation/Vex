/**
 * What Vex shows on the pre-shell stage (`docs/design/H3-DESKTOP.md section 4.9`): one small
 * external store between her column on the stage (mounted once by `App`, `StagePlate`) and the
 * screens that stand beside it (the gate, the first run), so she never restarts while the screens
 * change beside her. The Vex key over her column says the state's word; her section shows its mood.
 * The unlock stands on no stage (section 4.13): it reads the same flags for her panel's mood
 * (`stageVexLockMood`) and for which unlock it is (`launching`), and writes the concern and the
 * unlock.
 *
 *   waking     the launch pipeline is still running: "Waking up" (she rests)
 *   ready      the desk is awake, or the vault just unlocked: "Ready" (she says hi)
 *   sleeping   the desk was locked: "Sleeping" (she rests)
 *   concerned  a wrong password, a throttle or the vault reset panel: "Concerned", with the
 *              throttle's seconds
 *   a face     a screen beside her says what she shows for what it is doing (the first run:
 *              "Working" with a timer, "Ready", "Concerned", "Error"; the wizard: "Listening",
 *              "Ready")
 *
 * `launching` is true from the start of the process until the stage leaves the launch (the first
 * run, the wizard, the shell): a stage that stands after it (Lock Vex, then the unlock) starts with
 * her asleep.
 *
 * The store holds no secret and no copy: flags only. `exit` is the stage to shell crossfade: her
 * stage lifts away (240 ms) when its owner (the gate or the page turn) says so.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { kimmMoodOf } from "../../features/vex/kimm-mood.js";
import type { VexState } from "../../features/vex/vex-state.js";
import type { KimmMood } from "../vex/kimm/kimm-assets.js";

export interface StageVexState {
  /** The launch is still the story (true until the stage leaves the launch). */
  readonly launching: boolean;
  /** Her stage stands for the launch: she is awake beside the wake (`StagePlate`). */
  readonly woken: boolean;
  /** The launch pipeline has handed off, so the desk is awake. */
  readonly pipelineReady: boolean;
  /** The vault unlocked: she looks at you. */
  readonly unlocked: boolean;
  /** The unlock screen has something to be concerned about. */
  readonly concerned: boolean;
  /** What the screen standing on the plate says she shows (the first run), or null. */
  readonly face: StageVexView | null;
  /** Seconds left of a throttle window, while there is one. */
  readonly countdown: number | null;
  /** `reveal`: the plate lifts away over the shell. */
  readonly exit: "idle" | "reveal";
}

/**
 * What she shows from the state. On H3's stage (docs/design/H3-DESKTOP.md section 4.9) the Vex key
 * over her column says her `state` and its `word` (the screen's own word; nothing stands under
 * her), and her section shows her `mood`: `kimmMoodOf(state)`, the shell's own map
 * (`features/vex/kimm-mood.ts`), unless the approved plate names the moment's own (`moodFace`,
 * `FirstRunStage.tsx`; the wizard at rest, `WizardShell.tsx`).
 */
export interface StageVexView {
  /** Her presence state, as the Vex key reads it. */
  readonly state: VexState;
  readonly word: string;
  /** "Locked", a countdown or a timer, set as a figure after the word. */
  readonly note: string | null;
  /** Her mood on her stage. */
  readonly mood: KimmMood;
}

const INITIAL: StageVexState = {
  launching: true,
  woken: false,
  pipelineReady: false,
  unlocked: false,
  concerned: false,
  face: null,
  countdown: null,
  exit: "idle",
};

/** The state a plate that mounts after the launch starts from: the desk is locked. */
const AFTER_LAUNCH: StageVexState = { ...INITIAL, launching: false };

/** A throttle window as the plate shows it: `0:28`. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The view for a state. Pure. Concerned wins, then a screen's face (once her stage stands for the
 * launch), then an unlock, then the launch, else asleep.
 */
export function stageVexView(state: StageVexState): StageVexView {
  if (state.concerned) {
    return {
      state: "concerned",
      word: "Concerned",
      note: state.countdown === null ? null : formatCountdown(state.countdown),
      mood: kimmMoodOf("concerned"),
    };
  }
  // A screen speaks for her once her stage stands for the launch.
  if (state.face !== null && (!state.launching || state.woken)) return state.face;
  // Ready: the desk is awake (the wake's last words before it hands off).
  const ready: StageVexView = { state: "ready", word: "Ready", note: null, mood: kimmMoodOf("ready") };
  if (state.unlocked) return ready;
  if (state.launching) {
    if (state.woken && state.pipelineReady) return ready;
    // The wake: she rests while the desk starts (the plate `stage-wake`).
    return { state: "waking", word: "Waking up", note: null, mood: kimmMoodOf("waking") };
  }
  // After the launch, a stage that stands before the shell finds the desk asleep, and she rests,
  // so the map's held for a locked vault (`kimmMoodOf`'s `locked`) is not asked for on the stage.
  // The lock screen draws her in its own panel (`stageVexLockMood`).
  return { state: "sleeping", word: "Sleeping", note: null, mood: kimmMoodOf("sleeping") };
}

let state: StageVexState = INITIAL;
const listeners = new Set<() => void>();

function update(patch: Partial<StageVexState>): void {
  const next = { ...state, ...patch };
  if ((Object.keys(next) as (keyof StageVexState)[]).every((k) => next[k] === state[k])) return;
  state = next;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The current state, outside React. */
export function getStageVex(): StageVexState {
  return state;
}

/** The current state, in React. */
export function useStageVex(): StageVexState {
  return useSyncExternalStore(subscribe, getStageVex, getStageVex);
}

/** The wake episode has handed her over. */
export function stageVexWoken(): void {
  update({ woken: true });
}

/** The launch pipeline has handed off. */
export function stageVexPipelineReady(): void {
  update({ pipelineReady: true });
}

/** The vault unlocked: she is awake and looks at you. */
export function stageVexUnlocked(): void {
  update({ unlocked: true });
}

/** The unlock screen is concerned (or no longer), with the seconds left of a throttle window. */
export function stageVexConcerned(concerned: boolean, countdown: number | null = null): void {
  update({ concerned, countdown: concerned ? countdown : null });
}

/** The same face, by value (the store holds a flag set, never a moving object). */
function sameFace(a: StageVexView | null, b: StageVexView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.word === b.word && a.note === b.note && a.mood === b.mood;
}

/** A first run screen says what she shows; null hands her back to the launch's own story. */
export function stageVexFace(face: StageVexView | null): void {
  if (sameFace(state.face, face)) return;
  update({ face });
}

/** The screen that set `face` is leaving: clears it unless another screen has already replaced it. */
export function stageVexFaceClear(face: StageVexView): void {
  if (sameFace(state.face, face)) update({ face: null });
}

/**
 * A screen says what she shows while it stands (the first run, the wizard): the face is set when
 * it changes and cleared once, when the screen leaves, so a crossfade between two screens never
 * flickers through the launch's own words.
 */
export function useStageFace(face: StageVexView): void {
  const { state: vexState, word, note, mood } = face;
  const mine = useRef<StageVexView | null>(null);
  useEffect(() => {
    const next: StageVexView = { state: vexState, word, note, mood };
    mine.current = next;
    stageVexFace(next);
  }, [vexState, word, note, mood]);
  useEffect(
    () => () => {
      if (mine.current !== null) stageVexFaceClear(mine.current);
    },
    [],
  );
}

/**
 * Her mood on the lock screen's own panel (`UnlockScreen.tsx`, docs/design/H3-DESKTOP.md section
 * 4.13): the unlock stands on no stage and no Vex key speaks for her there, so the panel reads the
 * same flags with a simpler clock. She rests while the screen waits for the password, is concerned
 * (as the stage maps it, `kimmMoodOf("concerned")`) over a wrong password, a throttle or the vault
 * reset panel, and says hi once the vault has opened.
 */
export function stageVexLockMood(state: StageVexState): KimmMood {
  if (state.concerned) return kimmMoodOf("concerned");
  if (state.unlocked) return kimmMoodOf("ready");
  return kimmMoodOf("sleeping");
}

/** The stage to shell crossfade starts: her stage lifts away. */
export function stageVexExit(): void {
  update({ exit: "reveal" });
}

/**
 * Her stage has gone from the window without leaving the launch (the gate lifted away over the
 * unlock, which stands on no stage): the crossfade is spent, so a stage that stands again starts
 * whole, and the launch's own story is kept.
 */
export function stageVexSettle(): void {
  update({ exit: "idle" });
}

/** The stage left the launch or the screens: the next stage starts from a locked desk. */
export function stageVexEnd(): void {
  update(AFTER_LAUNCH);
}

/** Back to the start of the process (tests). */
export function resetStageVex(): void {
  update(INITIAL);
}
