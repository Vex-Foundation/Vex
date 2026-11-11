/**
 * STATE: SWAP WAITING - the money moment: a pending approval to swap 200 USDC
 * for ETH on Base, drawn by the real `ApprovalCard`.
 *
 * The swap chat at its `waiting` stage (`fixtures/swap-chat.ts`): the quote
 * has run, the execute call is parked, and the approval sits in BOTH reads
 * the product makes for it - the chat's own `approvals.listPending` (the card
 * in `ApprovalsRegion`, between the transcript and the composer) and the
 * app-wide `approvals.listPendingAll` (the head's Needs you count and the Vex
 * column's row). The run reports `paused_approval`.
 *
 * The card is the product's, with the product's two-step confirm; the
 * stand-in bridge answers `approve` and `reject` with a refusal like any
 * other unanswered call, so nothing pressed here is a decision. The parity
 * spec measures this card's box (`data-vex-area="approval-card"`).
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById, SWAP_CHAT } from "../fixtures/sessions.js";
import { swapChatAnswers, swapPendingAll } from "../fixtures/swap-chat.js";
import type { HarnessState } from "./types.js";

export const swapWaiting: HarnessState = {
  id: "swap-waiting",
  title: "Swap waiting: 200 USDC to ETH on Base, approval pending",
  answers: () =>
    mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: swapPendingAll("waiting") }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      swapChatAnswers("waiting"),
    ),
  ui: { activeSessionId: SWAP_CHAT.id, shellRoute: { kind: "none" } },
  ready: '[data-vex-area="approvals-region"] [data-vex-area="approval-card"]',
};
