/**
 * The lock screen's signals to Kimm (`kimm-lock-signals.ts`): five fixed words and nothing else cross from the vault
 * screen into her code.
 *
 * Regressions this catches:
 *   - a signal carrying a payload (a password, its length, an element) to a listener;
 *   - an unknown word, or a string that merely looks like one, reaching her;
 *   - a listener heard after it stopped.
 */

import { describe, expect, it, vi } from "vitest";
import { createKimmLockSignals, KIMM_LOCK_SIGNALS, type KimmLockSignal } from "../kimm-lock-signals.js";

describe("the lock screen's signals", () => {
  it("are five words", () => {
    expect([...KIMM_LOCK_SIGNALS]).toEqual(["typing", "shown", "hidden", "failed", "unlocked"]);
  });

  it("pass each word on alone, as the canonical constant", () => {
    const signals = createKimmLockSignals();
    const heard = vi.fn();
    signals.subscribe(heard);
    for (const word of KIMM_LOCK_SIGNALS) signals.emit(word);
    expect(heard.mock.calls).toEqual(KIMM_LOCK_SIGNALS.map((word) => [word]));
    for (const [index, call] of heard.mock.calls.entries()) {
      expect(call).toHaveLength(1);
      expect(call[0]).toBe(KIMM_LOCK_SIGNALS[index]);
    }
  });

  it("drop anything that is not one of the words, and never pass on extra arguments", () => {
    const signals = createKimmLockSignals();
    const heard = vi.fn();
    signals.subscribe(heard);
    const emit = signals.emit as (...args: unknown[]) => void;
    emit("correct horse battery staple");
    emit({ toString: () => "typing" });
    emit(new String("typing"));
    emit(14);
    emit(undefined);
    expect(heard).not.toHaveBeenCalled();
    emit("typing", "correct horse battery staple", 28);
    expect(heard.mock.calls).toEqual([["typing"]]);
  });

  it("stop telling a listener once it unsubscribes", () => {
    const signals = createKimmLockSignals();
    const heard = vi.fn<(signal: KimmLockSignal) => void>();
    const stop = signals.subscribe(heard);
    signals.emit("shown");
    stop();
    signals.emit("hidden");
    expect(heard.mock.calls).toEqual([["shown"]]);
  });
});
