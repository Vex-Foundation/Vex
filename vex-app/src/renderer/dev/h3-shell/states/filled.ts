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
 * What draws the receipt today is the product's act row for the execute call
 * (`ToolLedger/ToolActRow.tsx`: the leg line from the persisted output, the
 * duration, the transaction link) and the answer under it; H3's receipt card
 * is a later slice (S6b-08), and this state is where it will be checked.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById, SWAP_CHAT } from "../fixtures/sessions.js";
import { swapChatAnswers } from "../fixtures/swap-chat.js";
import type { HarnessState } from "./types.js";

export const filled: HarnessState = {
  id: "filled",
  title: "Filled receipt: the swap executed on Base",
  answers: () =>
    mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: [] }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      swapChatAnswers("filled"),
    ),
  ui: { activeSessionId: SWAP_CHAT.id, shellRoute: { kind: "none" } },
  ready: '[data-vex-area="chat-transcript"] [data-vex-explorer-refs]',
};
