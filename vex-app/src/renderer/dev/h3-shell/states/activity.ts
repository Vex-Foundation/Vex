/**
 * STATE: ACTIVITY - the Agent Scan page, which the H3 nav calls Activity
 * (docs/design/H3-DESKTOP.md section 4.6), opened on the whole feed with no
 * chat selected.
 *
 * The real `AgentScanScreen` through `ShellScreens`, over the portfolio
 * fixtures' feed (`fixtures/portfolio.ts`): the confirmed swap, a bridge in a
 * mempool and yesterday's failed swap, so the page shows H3's green, grey and
 * red status squares and two day heads. H3 draws no plate for this page; it
 * follows the page frame with rows of H3 cells (section 4.9).
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { portfolioAnswers } from "../fixtures/portfolio.js";
import { CHATS, chatById } from "../fixtures/sessions.js";
import type { HarnessState } from "./types.js";

export const activity: HarnessState = {
  id: "activity",
  title: "Activity: the feed with a confirmed, a submitted and a failed row",
  answers: () =>
    mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: [] }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      portfolioAnswers(),
    ),
  ui: { activeSessionId: null, shellRoute: { kind: "agentScan", origin: null, sessionId: null } },
  ready: '[data-vex-area="shell-screen"] ul[aria-label="Activity"]',
};
