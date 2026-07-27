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
 * The decision is a pure function of three inputs so it is testable without a
 * DOM; the localStorage adapter below is the only impure part.
 *
 * Storage choice: renderer localStorage, deliberately. This is a COSMETIC
 * flag — it gates an animation, nothing else — so it must not cross IPC into
 * the privileged main process, whose storage is for secrets, wallet state and
 * setup truth. `stores/uiStore.ts` already persists cosmetic renderer state
 * (theme, rail toggles) to localStorage, so this follows an existing pattern
 * rather than inventing one. A missing, unreadable or hand-edited value
 * degrades to "play the full prologue" — the worst case is one extra
 * animation, never a broken boot.
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

/** localStorage key holding the last version whose prologue completed. */
export const PROLOGUE_VERSION_KEY = "vex-prologue-version";

/** Longest value we will believe — localStorage is user-writable. */
const MAX_VERSION_LENGTH = 64;

/**
 * Read the recorded version. Every failure mode — storage disabled or
 * throwing (private mode, blocked cookies), a non-string, an absurdly long
 * hand-edited value — answers null, which resolves to the full prologue.
 */
export function readLastPlayedVersion(): string | null {
  try {
    const raw = window.localStorage.getItem(PROLOGUE_VERSION_KEY);
    if (typeof raw !== "string") return null;
    if (raw.length === 0 || raw.length > MAX_VERSION_LENGTH) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Record the version whose prologue just finished (or was skipped). */
export function writeLastPlayedVersion(version: string): void {
  try {
    window.localStorage.setItem(PROLOGUE_VERSION_KEY, version);
  } catch {
    // A launch that cannot persist simply replays the prologue next time.
  }
}
