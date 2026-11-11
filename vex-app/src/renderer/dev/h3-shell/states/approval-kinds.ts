/**
 * STATE: APPROVAL KINDS - every other kind of money card in H3's frame, so
 * row S6b-06 can be looked at: a wallet send, a bridge, a Lighter limit
 * order, a Lighter deposit, the Lighter trading-fee authorization, a token
 * launch asked for over MCP, a call to the user's own MCP tool, and a generic
 * signed transaction (`fixtures/approval-kinds.ts`).
 *
 * The swap chat at its `waiting` stage, with these cards in place of the
 * swap's in BOTH reads the product makes (the chat's `approvals.listPending`,
 * which `ApprovalsRegion` draws, and the app-wide `approvals.listPendingAll`,
 * which counts them in the head). A chat holds as many pending approvals as
 * the engine enqueued, so the product draws exactly this stack.
 *
 * Every card is the product's `ApprovalCard` with its own family's eyebrow,
 * sentence, consequence line and action-named key. The stand-in bridge
 * answers `approve` and `reject` with a refusal like any unanswered call, so
 * nothing pressed here is a decision. Not one of the parity spec's mockup
 * moments: H3 draws only the swap.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { approvalKinds, approvalKindsPendingAll } from "../fixtures/approval-kinds.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById, SWAP_CHAT } from "../fixtures/sessions.js";
import { swapChatAnswers } from "../fixtures/swap-chat.js";
import type { HarnessState } from "./types.js";

export const approvalKindsState: HarnessState = {
  id: "approval-kinds",
  title: "Approval kinds: send, bridge, Lighter, launch and MCP cards waiting",
  answers: () => {
    const kinds = approvalKinds();
    return mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: approvalKindsPendingAll() }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      swapChatAnswers("waiting"),
      {
        approvals: {
          listPending: () => ok(kinds),
          get: ({ id }) => ok(kinds.find((row) => row.id === id) ?? null),
        },
      },
    );
  },
  ui: { activeSessionId: SWAP_CHAT.id, shellRoute: { kind: "none" } },
  ready: '[data-vex-area="approvals-region"] [data-approval-id="h3-fixture-approval-signed-tx"]',
};
