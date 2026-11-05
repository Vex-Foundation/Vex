/**
 * Web Animations for jsdom, which has none: every `element.animate` call is
 * recorded with its keyframes and timing, and a test moves a run by hand
 * (`progress`, `finish`). Enough of `Animation` for her wipe
 * (`kimm-wipe.ts`): its effect's computed progress, its play state, its
 * `finished` promise (resolved by `finish`, rejected by `cancel`) and
 * `cancel`. Her box is laid out by `layOut`, as the browser would lay it.
 */

/** One `element.animate` call, as recorded. */
export interface FakeAnimation {
  readonly target: Element;
  readonly keyframes: readonly Keyframe[];
  readonly options: KeyframeAnimationOptions;
  /** The eased progress the effect reports, 0 to 1; set by hand. */
  progress: number;
  cancelled: boolean;
  /** Run it to its end: progress 1, `finished` resolves. */
  finish(): void;
}

export interface FakeAnimations {
  readonly runs: FakeAnimation[];
  /** The runs on one element that are still in play (not cancelled). */
  live(target: Element): FakeAnimation[];
  restore(): void;
}

export function installFakeAnimations(): FakeAnimations {
  const runs: FakeAnimation[] = [];
  const proto = Element.prototype as { animate?: Element["animate"] };
  const before = proto.animate;
  proto.animate = function animate(this: Element, keyframes, options) {
    let resolve: () => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const finished = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    finished.catch(() => undefined);
    let state: AnimationPlayState = "running";
    const run: FakeAnimation = {
      target: this,
      keyframes: (keyframes ?? []) as Keyframe[],
      options: (typeof options === "number" ? { duration: options } : (options ?? {})) as KeyframeAnimationOptions,
      progress: 0,
      cancelled: false,
      finish: () => {
        run.progress = 1;
        state = "finished";
        resolve();
      },
    };
    runs.push(run);
    const animation: {
      readonly playState: AnimationPlayState;
      readonly effect: { getComputedTiming(): { progress: number } };
      finished: Promise<unknown>;
      cancel(): void;
    } = {
      get playState(): AnimationPlayState {
        return state;
      },
      effect: { getComputedTiming: () => ({ progress: run.progress }) },
      finished: Promise.resolve(),
      cancel: () => {
        if (run.cancelled) return;
        run.cancelled = true;
        state = "idle";
        reject(new DOMException("The animation was cancelled", "AbortError"));
      },
    };
    animation.finished = finished.then(() => animation);
    animation.finished.catch(() => undefined);
    return animation as unknown as Animation;
  };
  return {
    runs,
    live: (target) => runs.filter((run) => run.target === target && !run.cancelled),
    restore: () => {
      if (before === undefined) delete proto.animate;
      else proto.animate = before;
    },
  };
}

/**
 * Lay her box out as the browser would at 1440 x 900: 603 high, under a
 * 56px strip (`--vex-h3-strip-h`, which her box inherits from the root),
 * with her 32px drop (`--vex-kimm-drop`, which the sheet sets on her box).
 * `zoom` is the wide zoom her column wears from 1760 up: her rect is then in
 * the window's pixels, `height` x `zoom`, and `currentCSSZoom` says so.
 */
export function layOut(box: HTMLElement, height = 603, zoom = 1): void {
  document.documentElement.style.setProperty("--vex-h3-strip-h", "56px");
  document.documentElement.style.setProperty("--vex-kimm-drop", "32px");
  const shown = height * zoom;
  box.getBoundingClientRect = () =>
    ({ top: 224, bottom: 224 + shown, left: 248, right: 679, width: 431, height: shown, x: 248, y: 224, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(box, "currentCSSZoom", { configurable: true, value: zoom });
}

/** Undo `layOut`'s lengths on the root. */
export function clearLayout(): void {
  document.documentElement.style.removeProperty("--vex-h3-strip-h");
  document.documentElement.style.removeProperty("--vex-kimm-drop");
}
