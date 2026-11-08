/**
 * HER MOOD, HELD AS CLOUD HOLDS IT (docs/design/H3-DESKTOP.md section 1.6;
 * `kimm-mood.ts`). `kimmMoodOf` names her mood for a reading; a money call's
 * end (signed after a fill, refused after a refusal or an error) shows only
 * for VEX Cloud's hold (`KIMM_MOOD_HOLD_MS`: 2.8 s and 3.4 s), then she
 * rests, as Cloud's mood clock goes back to rest when a timed mood ends
 * (`apps/web/src/components/kimm/kimm-provider.tsx`). Every other mood
 * stands as long as its reading.
 *
 * One timeout per end, armed when the end first shows and cleared when the
 * reading changes; nothing repeats.
 */

import { useEffect, useState } from "react";
import type { KimmMood } from "../../components/vex/kimm/kimm-assets.js";
import { KIMM_MOOD_HOLD_MS, kimmMoodOf, kimmOutcomeOf, type KimmMoodOptions } from "./kimm-mood.js";
import type { VexState } from "./vex-state.js";

export function useKimmMood(state: VexState, options: KimmMoodOptions = {}): KimmMood {
  const mood = kimmMoodOf(state, options);
  const outcome = kimmOutcomeOf(state, options);
  const key = outcome === null ? null : `${state}:${outcome}`;
  // Whether the end now showing has had its time (state derived from the
  // reading: a new end starts its own hold).
  const [held, setHeld] = useState<{ readonly key: string | null; readonly over: boolean }>({ key, over: false });
  if (held.key !== key) setHeld({ key, over: false });
  useEffect(() => {
    if (key === null || outcome === null) return undefined;
    const timer = window.setTimeout(() => {
      setHeld((current) => (current.key === key ? { key, over: true } : current));
    }, KIMM_MOOD_HOLD_MS[outcome]);
    return () => window.clearTimeout(timer);
  }, [key, outcome]);
  return key !== null && held.key === key && held.over ? "rest" : mood;
}
