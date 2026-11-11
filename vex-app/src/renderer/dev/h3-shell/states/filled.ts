/**
 * STATE: FILLED RECEIPT - the swap after the approval: executed, confirmed on
 * Base, and Vex's closing line.
 *
 * The swap chat at its `filled` stage (`fixtures/swap-chat.ts`): the approval
 * resolved as approved and succeeded, the execute call's result persisted
 * with `success: true`, its measured 6.21 s and its explorer reference, and
 * the run finished. Nothing waits, so the head and the Vex column are quiet
 * again.
 *
 * The receipt is H3's filled card (`ToolLedger/ReceiptCard.tsx`, S6b-08),
 * drawn under the execute call's step from the ACTIVITY LEDGER's entry for
 * the same transaction: the chat reads the session's activity feed
 * (`portfolio.listAgentScan`, narrowed to the session), answered here with
 * the Portfolio fixture's confirmed swap, whose hash is the execute call's.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { portfolioAnswers } from "../fixtures/portfolio.js";
import { CHATS, chatById, SWAP_CHAT } from "../fixtures/sessions.js";
import { swapChatAnswers } from "../fixtures/swap-chat.js";
import type { HarnessState } from "./types.js";

/** The activity feed, as Portfolio's fixture answers it: the confirmed swap. */
const activity = portfolioAnswers().portfolio?.listAgentScan;

export const filled: HarnessState = {
  id: "filled",
  title: "Filled receipt: the swap executed on Base",
  answers: () =>
    mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: [] }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      swapChatAnswers("filled"),
      activity === undefined ? {} : { portfolio: { listAgentScan: activity } },
    ),
  ui: { activeSessionId: SWAP_CHAT.id, shellRoute: { kind: "none" } },
  ready: '[data-vex-area="chat-transcript"] [data-vex-receipt]',
};
