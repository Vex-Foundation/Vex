/**
 * STATE: HOW VEX WORKS - the static tour page with no chat selected.
 *
 * The real `HowVexWorksScreen` through `ShellScreens`: repo markdown and its
 * contents, so it needs nothing beyond the base answers. H3 draws no plate
 * for this page; it follows the page frame with H3's cells
 * (docs/design/H3-DESKTOP.md section 4.9).
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById } from "../fixtures/sessions.js";
import type { HarnessState } from "./types.js";

export const howVexWorks: HarnessState = {
  id: "how-vex-works",
  title: "How Vex works: the tour and its contents",
  answers: () =>
    mergeAnswers(baseAnswers({ sessions: [...CHATS], pendingAll: [] }), {
      sessions: { get: ({ id }) => ok(chatById(id)) },
    }),
  ui: { activeSessionId: null, shellRoute: { kind: "howItWorks", origin: null } },
  ready: '[data-vex-area="shell-screen"] nav[aria-label="On this page"]',
};
