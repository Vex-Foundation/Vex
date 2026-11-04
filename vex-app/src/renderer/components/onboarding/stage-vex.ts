/**
 * What Vex shows on the pre-shell stage (`docs/design/H3-DESKTOP.md section 4.9`): one small
 * external store between her column on the stage (mounted once by `App`, `StagePlate`) and the
 * screens that stand beside it (the gate, the unlock, the first run), so she never restarts while
 * the screens change beside her. The Vex key over her column says the state's word; her section
 * shows its mood.
 *
 *   waking     the launch wake is playing, or the pipeline is still running: "Waking up"
 *   ready      she has woken and the desk is ready, or the vault just unlocked: "Ready"
 *   sleeping   the desk was locked: "Sleeping · Locked" (she wakes when the unlock succeeds)
 *   concerned  a wrong password, a throttle or the vault reset panel: "Concerned"
 *   a face     a first run screen (system check, local runtime, database) says what she
 *              shows for what it is doing: "Working" with a timer, "Ready", "Concerned", "Error"
 *
 * `launching` is true from the start of the process until the plate leaves the launch (the shell,
 * or a first-run screen): only a launch plays the wake from the token. A plate that mounts later
 * (Lock Vex, then the unlock) starts with her asleep.
 *
 * The store holds no secret and no copy: flags only. `exit` is the stage to shell crossfade: the
 * plate lifts away (240 ms) when its owner (the gate or the page turn) says so.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { kimmMoodOf } from "../../features/vex/kimm-mood.js";
import type { VexState } from "../../features/vex/vex-state.js";
import type { K2Emotion } from "../vex/k2/k2-emotion.js";
import type { KimmMood } from "../vex/kimm/kimm-assets.js";
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
 * What she shows from the state. On H3's stage (docs/design/H3-DESKTOP.md section 4.9) the Vex key
 * over her column says her `state` and its `word` (the screen's own word; nothing stands under
 * her), and her section shows her `mood`: `kimmMoodOf(state)`, the shell's own map
 * (`features/vex/kimm-mood.ts`), unless the approved plate names the moment's own (`moodFace`,
 * `FirstRunStage.tsx`). `emotion` and `swatch` are K2's, for the R3 plate that the screens not yet
 * on the H3 stage still stand on.
 */
export interface StageVexView {
  readonly emotion: K2Emotion;
  readonly swatch: SwatchState;
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
 * The view for a state. Pure. Concerned wins, then a screen's face (once the launch's wake has
 * handed her over), then an unlock, then the launch, else asleep.
 */
export function stageVexView(state: StageVexState): StageVexView {
  if (state.concerned) {
    return {
      emotion: "concerned",
      swatch: "concerned",
      state: "concerned",
      word: "Concerned",
      note: state.countdown === null ? null : formatCountdown(state.countdown),
      mood: kimmMoodOf("concerned"),
    };
  }
  // A first run screen speaks for her, but the wake always finishes first: she never skips it.
  if (state.face !== null && (!state.launching || state.woken)) return state.face;
  // Ready: the unlock after a launch says hi (the plate `stage-unlock`).
  const ready: StageVexView = {
    emotion: "idle",
    swatch: "done",
    state: "ready",
    word: "Ready",
    note: null,
    mood: kimmMoodOf("ready"),
  };
  if (state.unlocked) return ready;
  if (state.launching) {
    if (state.woken && state.pipelineReady) return ready;
    // The wake: she rests while the desk starts (the plate `stage-wake`).
    return {
      emotion: "idle",
      swatch: "listening",
      state: "waking",
      word: "Waking up",
      note: null,
      mood: kimmMoodOf("waking"),
    };
  }
  // After Lock Vex she sleeps and rests (the plate `stage-unlock-locked`, approved as drawn), so
  // the map's held for a locked vault (`kimmMoodOf`'s `locked`) is not asked for on the stage. The
  // lock is the title cell's word ("Local vault · Locked"), so nothing follows hers.
  return {
    emotion: "sleeping",
    swatch: "sleeping",
    state: "sleeping",
    word: "Sleeping",
    note: null,
    mood: kimmMoodOf("sleeping"),
  };
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
    a.emotion === b.emotion
    && a.swatch === b.swatch
    && a.state === b.state
    && a.word === b.word
    && a.note === b.note
    && a.mood === b.mood
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

/**
 * A screen says what she shows while it stands (the first run, the wizard): the face is set when
 * it changes and cleared once, when the screen leaves, so a crossfade between two screens never
 * flickers through the launch's own words.
 */
export function useStageFace(face: StageVexView): void {
  const { emotion, swatch, state: vexState, word, note, mood } = face;
  const mine = useRef<StageVexView | null>(null);
  useEffect(() => {
    const next: StageVexView = { emotion, swatch, state: vexState, word, note, mood };
    mine.current = next;
    stageVexFace(next);
  }, [emotion, swatch, vexState, word, note, mood]);
  useEffect(
    () => () => {
      if (mine.current !== null) stageVexFaceClear(mine.current);
    },
    [],
  );
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
