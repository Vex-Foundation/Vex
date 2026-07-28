/**
 * PROLOGUE PLAY POLICY — how much cold open this launch earns.
 *
 * The cinematic prologue is a first-impression, not a loading screen: it
 * plays in FULL on a fresh install and on the first launch after an app
 * update, and CONDENSES to roughly the pre-existing assembly on every other
 * launch. `prefers-reduced-motion` opts out entirely — that path keeps the
 * gate's original contract (a static assembled mark, dismissed when the boot
 * pipeline resolves).
 *
 * This module is PURE — decision table + input sanitiser, no storage.
 *
 * Storage lives in `stores/uiStore.ts` (`prologueVersion`, persisted via the
 * Zustand persist whitelist — the ONLY sanctioned localStorage path in the
 * renderer, enforced by `scripts/check-build-artifacts.mjs`). The flag is
 * COSMETIC — it gates an animation, nothing else — so it must not cross IPC
 * into the privileged main process, whose storage is for secrets, wallet
 * state and setup truth. A missing, unreadable or hand-edited value degrades
 * to "play the full prologue" — the worst case is one extra animation, never
 * a broken boot.
 */

/** Play variants. `none` is the reduced-motion / failure path. */
export type ProloguePlay = "full" | "condensed" | "none";

export interface ProloguePolicyInput {
  /** Build version of the running app (`__VEX_APP_VERSION__`). */
  readonly appVersion: string;
  /** Version recorded the last time a prologue finished, or null if never. */
  readonly lastPlayedVersion: string | null;
  readonly reducedMotion: boolean;
}

/**
 * Fresh install (null) and version bump (mismatch) both earn the full
 * sequence; a repeat launch on the same version condenses.
 */
export function resolveProloguePlay(input: ProloguePolicyInput): ProloguePlay {
  if (input.reducedMotion) return "none";
  return input.lastPlayedVersion === input.appVersion ? "condensed" : "full";
}

/** Longest value we will believe — the persisted payload is user-writable. */
const MAX_VERSION_LENGTH = 64;

/**
 * Sanitise a rehydrated `prologueVersion` value. localStorage is untrusted
 * input even through the persist layer (a hand-edited current-version payload
 * skips `migrate`), so every failure mode — a non-string, an empty or
 * absurdly long value — answers null, which resolves to the full prologue.
 */
export function sanitizeStoredPrologueVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_VERSION_LENGTH) return null;
  return raw;
}
