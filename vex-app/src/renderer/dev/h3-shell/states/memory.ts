/**
 * STATE: MEMORY - the Memory page with no chat selected.
 *
 * The real `MemoryScreen` through `ShellScreens`. H3 draws no Memory plate;
 * the page follows the page frame with H3's cells (docs/design/H3-DESKTOP.md
 * section 4.9). The harness answers none of the register's reads (the memory
 * stats, the session list, the inspector's candidates, decisions and jobs),
 * so each section shows the state it draws when its read is refused: a real
 * state of the product, and the one a fresh install without a runtime sees.
 * What the capture is for is the frame, the lead, the advisory card, the
 * disclosure and the section heads.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById } from "../fixtures/sessions.js";
import type { HarnessState } from "./types.js";

export const memory: HarnessState = {
  id: "memory",
  title: "Memory: the page frame over a register whose reads are refused",
  answers: () =>
    mergeAnswers(baseAnswers({ sessions: [...CHATS], pendingAll: [] }), {
      sessions: { get: ({ id }) => ok(chatById(id)) },
    }),
  ui: { activeSessionId: null, shellRoute: { kind: "memory", origin: null } },
  ready: '[data-vex-area="shell-screen"] .vex-mem-card',
};
