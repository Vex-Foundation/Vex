/**
 * THE LOCK SCREEN'S LIFE, THE WIRING (owner decision 2026-11-15; `KIMM_LIFE` in `kimm-rig.ts` for what she does;
 * MOTION-POLICY.md "The lock screen's lively Kimm"). While her live figure stands on the lock screen in its lively
 * mode (`active`), this hook tells her rig what happens around her, as reactions with no content:
 *
 *   - THE SCREEN'S WORDS (`kimm-lock-signals.ts`): typing, focus, blur, shown, hidden, failed, unlocked, with the
 *     field's place (a point, never the element) for typing and focus. The field's focus is remembered while she is
 *     not yet live, so she leans in as soon as she is.
 *   - THE GREETING: `KIMM_GREET_DELAY_MS` after the first time she stands live in an app launch (keys already going
 *     in skip it) (`KIMM_LOCK_LIFE_MEMORY`, module memory: a launch
 *     is a renderer's life), and again when the window is shown after `KIMM_GREET_AFTER_HIDDEN_MS` hidden.
 *   - SLEEPY: no pointer movement, key or focus change for `KIMM_SLEEP_AFTER_MS`; any of them wakes her.
 *   - NIGHT: the computer's local clock (`kimmIsNight`, read here and nowhere else, never sent anywhere), checked
 *     every `KIMM_LIFE_TICK_MS`.
 * Elapsed time (the 45 s, the 10 minutes) is measured on `performance.now()`, a monotonic clock, so a change of the
 * wall clock never wakes, greets or sleeps her; only the hour of day reads `Date`. It returns `sleepy` and `night` for her panel's field and motes. Inactive, nothing listens but the screen's focus.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import type { KimmLockSignal, KimmLockSignals } from "./kimm-lock-signals.js";
import type { KimmReaction } from "./kimm-rig.js";
import { kimmLockFieldPoint } from "./use-kimm-live.js";

/** No pointer, key or focus change for this long and she becomes sleepy. */
export const KIMM_SLEEP_AFTER_MS = 45_000;

/** Hidden at least this long, the window shown again greets her anew. */
export const KIMM_GREET_AFTER_HIDDEN_MS = 600_000;

/** Her greeting waits this long after she stands live, so her live figure has faded in (`--vex-duration-kimm-in`). */
export const KIMM_GREET_DELAY_MS = 700;

/** How often the sleep timer and the clock are read. */
export const KIMM_LIFE_TICK_MS = 1000;

/** Night by the local clock: from 22:00 to 06:00. */
export function kimmIsNight(date: Date): boolean {
  const hour = date.getHours();
  return hour >= 22 || hour < 6;
}

/** What a renderer remembers across lock screens: whether she greeted in this launch, when the window went hidden. */
export const KIMM_LOCK_LIFE_MEMORY: { greeted: boolean; hiddenAt: number | null } = { greeted: false, hiddenAt: null };

/** Forgets the launch (tests). */
export function resetKimmLockLifeMemory(): void {
  KIMM_LOCK_LIFE_MEMORY.greeted = false;
  KIMM_LOCK_LIFE_MEMORY.hiddenAt = null;
}

export interface UseKimmLockLifeOptions {
  readonly active: boolean;
  readonly signals?: KimmLockSignals;
  readonly react: (signal: KimmReaction, at?: { readonly x: number; readonly y: number }) => void;
  /** Her live layer, for where the field stands beside her panel. */
  readonly layerRef: RefObject<HTMLElement | null>;
}

export function useKimmLockLife({ active, signals, react, layerRef }: UseKimmLockLifeOptions): {
  readonly sleepy: boolean;
  readonly night: boolean;
} {
  const [sleepy, setSleepy] = useState(false);
  const [night, setNight] = useState(() => kimmIsNight(new Date()));
  const focusedRef = useRef(false);
  const nightRef = useRef(night);
  const activeRef = useRef(active);
  const activityRef = useRef(performance.now());
  const sleepyRef = useRef(false);
  const reactRef = useRef(react);
  useEffect(() => {
    reactRef.current = react;
    activeRef.current = active;
  });

  const fieldPoint = (): { readonly x: number; readonly y: number } | undefined => {
    const layer = layerRef.current;
    return layer === null ? undefined : kimmLockFieldPoint(layer.getBoundingClientRect(), window.innerWidth, window.innerHeight);
  };

  // Any pointer movement, key or focus change: she is not alone; sleepy, she wakes.
  const stir = (): void => {
    activityRef.current = performance.now();
    if (!sleepyRef.current) return;
    sleepyRef.current = false;
    setSleepy(false);
    if (activeRef.current) reactRef.current("wake");
  };

  // The screen's words: remembered (the field's focus) and, while she is live, told to her.
  useEffect(() => {
    if (signals === undefined) return undefined;
    return signals.subscribe((word: KimmLockSignal) => {
      if (word === "focus") focusedRef.current = true;
      if (word === "blur") focusedRef.current = false;
      stir();
      if (!activeRef.current) return;
      reactRef.current(word, word === "typing" || word === "focus" ? fieldPoint() : undefined);
    });
    // `stir` and `fieldPoint` read refs only, so the subscription follows `signals` alone
  }, [signals]);

  // She stands live: the clock's tempo, the field's focus, and her greeting once a launch.
  useEffect(() => {
    if (!active) return undefined;
    activityRef.current = performance.now();
    const isNight = kimmIsNight(new Date());
    nightRef.current = isNight;
    setNight(isNight);
    reactRef.current(isNight ? "night" : "day");
    if (focusedRef.current) reactRef.current("focus", fieldPoint());
    // her greeting, once she has faded in; keys already going in by then skip it
    let typedBeforeGreeting = false;
    const stopWatchingKeys = signals?.subscribe((word) => {
      if (word === "typing") typedBeforeGreeting = true;
    });
    const greeting = KIMM_LOCK_LIFE_MEMORY.greeted
      ? null
      : window.setTimeout(() => {
          stopWatchingKeys?.();
          if (typedBeforeGreeting) return;
          KIMM_LOCK_LIFE_MEMORY.greeted = true;
          reactRef.current("greet", fieldPoint());
        }, KIMM_GREET_DELAY_MS);

    const tick = window.setInterval(() => {
      const nowNight = kimmIsNight(new Date());
      if (nowNight !== nightRef.current) {
        nightRef.current = nowNight;
        setNight(nowNight);
        reactRef.current(nowNight ? "night" : "day");
      }
      if (!sleepyRef.current && performance.now() - activityRef.current >= KIMM_SLEEP_AFTER_MS) {
        sleepyRef.current = true;
        setSleepy(true);
        reactRef.current("sleep");
      }
    }, KIMM_LIFE_TICK_MS);
    const onVisibility = (): void => {
      if (document.hidden) {
        KIMM_LOCK_LIFE_MEMORY.hiddenAt = performance.now();
        return;
      }
      const hiddenAt = KIMM_LOCK_LIFE_MEMORY.hiddenAt;
      KIMM_LOCK_LIFE_MEMORY.hiddenAt = null;
      stir();
      if (hiddenAt !== null && performance.now() - hiddenAt >= KIMM_GREET_AFTER_HIDDEN_MS) reactRef.current("greet", fieldPoint());
    };
    window.addEventListener("pointermove", stir, { passive: true });
    window.addEventListener("pointerdown", stir, { passive: true });
    window.addEventListener("keydown", stir);
    window.addEventListener("focusin", stir);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (greeting !== null) window.clearTimeout(greeting);
      stopWatchingKeys?.();
      window.clearInterval(tick);
      window.removeEventListener("pointermove", stir);
      window.removeEventListener("pointerdown", stir);
      window.removeEventListener("keydown", stir);
      window.removeEventListener("focusin", stir);
      document.removeEventListener("visibilitychange", onVisibility);
      sleepyRef.current = false;
      setSleepy(false);
    };
    // `stir` and `fieldPoint` read refs only, so this follows `active` (and the screen's words) alone
  }, [active, signals]);

  return { sleepy: active && sleepy, night: active && night };
}
