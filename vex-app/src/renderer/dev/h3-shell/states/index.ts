/**
 * THE STATE INDEX - every harness state by its `?state=` id, in the order the
 * parity spec captures them.
 *
 * `shell` is the bare install: the real shell over the base fixtures with no
 * chat and nothing waiting. It is what the harness renders without a
 * `?state=`, and the proof that the shell mounts on the stand-in bridge
 * alone. Every mockup moment is a state of its own below it.
 */

import { baseAnswers } from "../fixtures/base.js";
import { newChat } from "./new-chat.js";
import { swapWaiting } from "./swap-waiting.js";
import { thinking } from "./thinking.js";
import type { HarnessState } from "./types.js";

const shell: HarnessState = {
  id: "shell",
  title: "The bare install",
  answers: () => baseAnswers({ sessions: [], pendingAll: [] }),
  ui: { activeSessionId: null, shellRoute: { kind: "none" } },
  ready: '[data-vex-screen="appShell"]',
};

export const HARNESS_STATES: readonly HarnessState[] = [shell, newChat, thinking, swapWaiting];

export const DEFAULT_STATE = shell;

export function stateById(id: string | null): HarnessState | null {
  if (id === null) return DEFAULT_STATE;
  return HARNESS_STATES.find((state) => state.id === id) ?? null;
}
