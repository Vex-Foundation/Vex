/**
 * Gate prologue — public API.
 *
 * The cinematic cold open that plays inside `SetupGate` before the hold
 * state. Everything else in this folder is implementation detail:
 * `GatePrologue.tsx` renders, `prologue-phases.ts` choreographs,
 * `prologue-geometry.ts` does the globe maths, `prologue-policy.ts` decides
 * how much of it this launch earns.
 */

export { GatePrologue, type GatePrologueProps } from "./GatePrologue.js";
export {
  PROLOGUE_VERSION_KEY,
  readLastPlayedVersion,
  resolveProloguePlay,
  writeLastPlayedVersion,
  type ProloguePlay,
} from "./prologue-policy.js";
export { FULL_TIMELINE, CONDENSED_TIMELINE } from "./prologue-phases.js";
