/**
 * What Vex shows on the pre-shell plate (`docs/design/R3-MINIMAL.md section 10.2`): one small
 * external store between the stage's plate (mounted once by `App`) and the screens that stand on
 * it (the gate, the unlock), so the picture never restarts while the screens change over it.
 *
 *   waking     the launch wake is playing, or the pipeline is still running: "Waking up"
 *   ready      she has woken and the desk is ready, or the vault just unlocked: "Ready"
 *   sleeping   the desk was locked: "Sleeping · Locked" (she wakes when the unlock succeeds)
 *   concerned  a wrong password, a throttle or the vault reset panel: "Concerned"
 *   a face     a first run screen (system check, Docker, services, database) says what she
 *              shows for what it is doing: "Working" with a timer, "Ready", "Concerned", "Error"
 *
 * `launching` is true from the start of the process until the plate leaves the launch (the shell,
 * or a first-run screen): only a launch plays the wake from the token. A plate that mounts later
 * (Lock Vex, then the unlock) starts with her asleep.
 *
 * The store holds no secret and no copy: flags only. `exit` is the stage to shell crossfade: the
 * plate lifts away (240 ms) when its owner (the gate or the page turn) says so.
 */

import { useSyncExternalStore } from "react";
import type { K2Emotion } from "../vex/k2/k2-emotion.js";
import type { SwatchState } from "../ui/swatch.js";

export interface StageVexState {
  /** The launch wake is still the story (true until the plate leaves the launch). */
  readonly launching: boolean;
  /** The wake episode has handed her over (or she was never asleep: the still frame). */
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
 * What the plate shows from the state: her emotion. The swatch, the word and the figure name that
 * face for the screens and the tests; the plate draws none of them (the owner, 2026-10-18).
 */
export interface StageVexView {
  readonly emotion: K2Emotion;
  readonly swatch: SwatchState;
  readonly word: string;
  /** "Locked" or a countdown, set in mono after the word. */
  readonly note: string | null;
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
 * The view for a state. Pure. Concerned wins, then a screen's face (once the launch's wake has
 * handed her over), then an unlock, then the launch, else asleep.
 */
export function stageVexView(state: StageVexState): StageVexView {
  if (state.concerned) {
    return {
      emotion: "concerned",
      swatch: "concerned",
      word: "Concerned",
      note: state.countdown === null ? null : formatCountdown(state.countdown),
    };
  }
  // A first run screen speaks for her, but the wake always finishes first: she never skips it.
  if (state.face !== null && (!state.launching || state.woken)) return state.face;
  const ready: StageVexView = { emotion: "idle", swatch: "done", word: "Ready", note: null };
  if (state.unlocked) return ready;
  if (state.launching) {
    if (state.woken && state.pipelineReady) return ready;
    return { emotion: "idle", swatch: "listening", word: "Waking up", note: null };
  }
  return { emotion: "sleeping", swatch: "sleeping", word: "Sleeping", note: "Locked" };
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
  return (
    a.emotion === b.emotion && a.swatch === b.swatch && a.word === b.word && a.note === b.note
  );
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

/** The stage to shell crossfade starts: the plate lifts away. */
export function stageVexExit(): void {
  update({ exit: "reveal" });
}

/** The plate left the launch or the screens: the next plate starts from a locked desk. */
export function stageVexEnd(): void {
  update(AFTER_LAUNCH);
}

/** Back to the start of the process (tests). */
export function resetStageVex(): void {
  update(INITIAL);
}
