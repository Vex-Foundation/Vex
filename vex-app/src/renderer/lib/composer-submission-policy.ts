/**
 * Composer submission policy (B13). Owns the persisted Enter-key preference
 * (a tiny Zustand persist store - the repo's one sanctioned storage path)
 * and resolves a keyboard gesture into submit / newline / pass as a pure
 * function, so the textarea handler carries no policy of its own. Lives
 * outside uiStore (F3 ownership); get/set/subscribe are the migration seam
 * if it ever moves there.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * "enter": plain Enter submits, Shift+Enter inserts a newline (the app's
 * behavior to date - the default). "mod-enter": plain Enter inserts a
 * newline; only Cmd/Ctrl+Enter submits. Cmd/Ctrl+Enter submits under BOTH
 * policies, so the accelerated chord is always safe muscle memory.
 */
export type SubmitKeyBehavior = "enter" | "mod-enter";

export const DEFAULT_SUBMIT_KEY_BEHAVIOR: SubmitKeyBehavior = "enter";

export interface ComposerKeyGesture {
  readonly key: string;
  readonly shiftKey: boolean;
  /** Cmd on macOS, Ctrl elsewhere (metaKey || ctrlKey). */
  readonly modKey: boolean;
  /** Live IME composition - the key belongs to the IME, never to us. */
  readonly isComposing: boolean;
}

export type SubmitKeyResolution = "submit" | "newline" | "pass";

/**
 * Resolve one keydown against the policy. "pass" means the textarea keeps
 * its native behavior (non-Enter keys, IME composition); "newline" callers
 * also fall through to the native insertion - it exists so a caller can
 * tell a deliberate newline from an unrelated key.
 */
export function resolveSubmitKeyGesture(
  behavior: SubmitKeyBehavior,
  gesture: ComposerKeyGesture,
): SubmitKeyResolution {
  if (gesture.key !== "Enter" || gesture.isComposing) return "pass";
  if (gesture.modKey) return "submit";
  if (gesture.shiftKey) return "newline";
  return behavior === "enter" ? "submit" : "newline";
}

function coerceBehavior(value: unknown): SubmitKeyBehavior {
  return value === "mod-enter" ? "mod-enter" : DEFAULT_SUBMIT_KEY_BEHAVIOR;
}

interface SubmitKeyState {
  readonly behavior: SubmitKeyBehavior;
  readonly setBehavior: (next: SubmitKeyBehavior) => void;
}

// True when the last rehydrate found a stored value (merge only runs then);
// the test reset uses it to fall back to the default on empty storage.
let hydratedFromStorage = false;

const useSubmitKeyStore = create<SubmitKeyState>()(
  persist(
    (set) => ({
      behavior: DEFAULT_SUBMIT_KEY_BEHAVIOR,
      setBehavior: (next) => set({ behavior: coerceBehavior(next) }),
    }),
    {
      name: "vex.composer.submit-key",
      version: 1,
      // Storage is untrusted: coerce whatever rehydrates back to the enum.
      merge: (persisted, current) => {
        hydratedFromStorage = true;
        return {
          ...current,
          behavior: coerceBehavior(
            (persisted as Partial<SubmitKeyState> | undefined)?.behavior,
          ),
        };
      },
    },
  ),
);

export function getSubmitKeyBehavior(): SubmitKeyBehavior {
  return useSubmitKeyStore.getState().behavior;
}

export function setSubmitKeyBehavior(next: SubmitKeyBehavior): void {
  useSubmitKeyStore.getState().setBehavior(next);
}

export function subscribeSubmitKeyBehavior(listener: () => void): () => void {
  return useSubmitKeyStore.subscribe(listener);
}

/** Test-only: re-read persisted storage; empty storage means the default. */
export async function resetSubmitKeyBehaviorForTest(): Promise<void> {
  hydratedFromStorage = false;
  await useSubmitKeyStore.persist.rehydrate();
  if (!hydratedFromStorage) {
    useSubmitKeyStore.setState({ behavior: DEFAULT_SUBMIT_KEY_BEHAVIOR });
  }
}

export function useSubmitKeyBehavior(): SubmitKeyBehavior {
  return useSubmitKeyStore((state) => state.behavior);
}
