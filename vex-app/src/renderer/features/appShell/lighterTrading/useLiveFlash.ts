/**
 * Live feedback for streamed numbers: which way a value just moved, which
 * book levels just changed size, which trades just arrived. Each answer is a
 * render key or a data attribute; the CSS animation on the element does the
 * flashing and ends on its own, so nothing here needs a timer.
 */

import { useMemo, useRef } from "react";
import type { BookLevel } from "./book-model.js";

export type TickDirection = "up" | "down";

export interface TickFlash {
  /** Direction of the latest move; null until the value has moved once. */
  readonly direction: TickDirection | null;
  /** Bumps on every move: key the flashing element with it to restart the animation. */
  readonly tick: number;
}

/** Direction of the latest change in `value`, with a counter to restart the flash. */
export function useTickFlash(value: number | null): TickFlash {
  const state = useRef<{ value: number | null; flash: TickFlash }>({
    value: null,
    flash: { direction: null, tick: 0 },
  });
  return useMemo(() => {
    const previous = state.current;
    if (value === null || previous.value === null || value === previous.value) {
      state.current = { value: value ?? previous.value, flash: previous.flash };
    } else {
      state.current = {
        value,
        flash: { direction: value > previous.value ? "up" : "down", tick: previous.flash.tick + 1 },
      };
    }
    return state.current.flash;
  }, [value]);
}

/**
 * Per-price change counters for one book side: a level whose size differs
 * from the last render gets its counter bumped, so `${price}:${count}` as the
 * row key remounts (and re-flashes) exactly the rows that changed. Levels
 * seen for the first time count as unchanged.
 */
export function useLevelTicks(levels: readonly BookLevel[]): ReadonlyMap<string, number> {
  const seen = useRef(new Map<string, { size: string; tick: number }>());
  return useMemo(() => {
    const next = new Map<string, { size: string; tick: number }>();
    const ticks = new Map<string, number>();
    for (const level of levels) {
      const previous = seen.current.get(level.price);
      const tick = previous === undefined || previous.size === level.size ? (previous?.tick ?? 0) : previous.tick + 1;
      next.set(level.price, { size: level.size, tick });
      ticks.set(level.price, tick);
    }
    seen.current = next;
    return ticks;
  }, [levels]);
}

/** Ids that were not in the previous list. The first list counts as already seen. */
export function useNewIds(ids: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  return useMemo(() => {
    const current = new Set(ids);
    const previous = seen.current;
    seen.current = current;
    if (previous === null) return new Set<string>();
    return new Set(ids.filter((id) => !previous.has(id)));
  }, [ids]);
}
