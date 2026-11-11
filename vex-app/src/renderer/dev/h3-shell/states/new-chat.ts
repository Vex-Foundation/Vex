/**
 * STATE: NEW CHAT - the H3 sheet's opening moment: no chat selected, the
 * welcome in the centre, the chat list in the left column.
 *
 * What the product shows here is the welcome stage (`AppShell`'s
 * `welcomeStage`: no active session, no page), with the greeting, the
 * composer and the starter suggestions, over the base install and the fixture
 * chat list. Nothing waits, so the head carries no Needs you count.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById } from "../fixtures/sessions.js";
import type { HarnessState } from "./types.js";

export const newChat: HarnessState = {
  id: "new-chat",
  title: "New chat: the welcome, with the chat list",
  answers: () =>
    mergeAnswers(baseAnswers({ sessions: [...CHATS], pendingAll: [] }), {
      sessions: { get: ({ id }) => ok(chatById(id)) },
    }),
  ui: { activeSessionId: null, shellRoute: { kind: "none" } },
  // The welcome, and the left column settled: its chat rows, or - under the
  // medium tier, where the column folds - its rail, which lists none.
  ready:
    '[data-vex-screen="appShell"]:has([data-vex-area="welcome-opening"])'
    + ':is(:has([data-vex-ls-item="row"]), :has([data-vex-left-page="spine"]))',
};
