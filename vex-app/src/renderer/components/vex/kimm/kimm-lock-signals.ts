/**
 * THE LOCK SCREEN'S SIGNALS TO KIMM (owner decision 2026-11-15; MOTION-POLICY.md "The lock screen's lively Kimm").
 * The vault screen tells her figure what happens beside her so she can react, and this is the only way it does:
 * five fixed words, no payload.
 *
 *   - `typing`: a key went into the master password field (nothing about which key, how many, or the value);
 *   - `shown` / `hidden`: the field's Show key revealed or hid the password;
 *   - `failed`: an unlock attempt was refused;
 *   - `unlocked`: the vault opened.
 *
 * THE BOUNDARY. `emit` takes one argument and passes on only the canonical word from `KIMM_LOCK_SIGNALS`, never the
 * value it was handed: anything that is not one of the five words is dropped, and extra arguments never reach a
 * listener. So no password, no length and no field element can travel from `UnlockScreen` into Kimm's code, and her
 * code never logs what it hears (`UnlockScreen-kimm-signals.test.tsx` proves it end to end). Renderer only: nothing
 * here crosses into preload or main.
 */

export const KIMM_LOCK_SIGNALS = ["typing", "shown", "hidden", "failed", "unlocked"] as const;

export type KimmLockSignal = (typeof KIMM_LOCK_SIGNALS)[number];

export interface KimmLockSignals {
  /** Tells her one of the five words; anything else is dropped. */
  emit(signal: KimmLockSignal): void;
  /** Hears each word; the returned function stops it. */
  subscribe(listener: (signal: KimmLockSignal) => void): () => void;
}

export function createKimmLockSignals(): KimmLockSignals {
  const listeners = new Set<(signal: KimmLockSignal) => void>();
  return {
    emit(signal) {
      const word = KIMM_LOCK_SIGNALS.find((candidate) => candidate === signal);
      if (word === undefined) return;
      for (const listener of [...listeners]) listener(word);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
