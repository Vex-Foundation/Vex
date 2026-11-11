/**
 * The plates' money cards: the product's own `ApprovalCard`, mounted on two
 * pending approvals typed by the real DTO, so the gate drawn is the gate the
 * product has (H3-DESKTOP.md section 4.3), not a drawing of it:
 *
 *   - the desk's own Review order: a resting limit buy from the ticket
 *     (`origin: "desk"`, `lighter.order.create`, an `external_post`, so risk
 *     medium: ONE press decides, as today, and its consequence line has no
 *     "It cannot be undone.");
 *   - Vex's proposal in the desk chat: a Lighter deposit
 *     (`user_wallet_broadcast`, risk high: TWO presses, the first arming the
 *     key for 4 s).
 *
 * The harness's stand-in bridge answers `approve` and `reject` with a
 * refusal, so nothing pressed on a plate decides anything. The figures are
 * the plate's.
 */

import { useState, type JSX } from "react";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { ApprovalCard } from "../../../../features/appShell/ApprovalCard.js";
import { isoAt, MINUTE } from "../../clock.js";
import { EVM_WALLET } from "../../fixtures/base.js";

/** The desk's chat session the cards belong to (a plate's id, never a real one). */
export const DESK_SESSION_ID = "h3-plate-lighter-desk-session";

const DAY = 24 * 60 * MINUTE;

export const DESK_ORDER: ApprovalSummaryDto = {
  id: "h3-plate-desk-order",
  sessionId: DESK_SESSION_ID,
  toolCallId: null,
  toolName: "lighter:order.create",
  status: "pending",
  permissionAtEnqueue: "restricted",
  createdAt: isoAt(-12_000),
  resolvedAt: null,
  reasoningPreview: "",
  actionKind: "external_post",
  riskLevel: "medium",
  preview: {
    toolName: "order.create",
    namespace: "lighter",
    criticalArgs: {
      toolId: "lighter.order.create",
      environment: "core",
      side: "buy",
      baseAmountDisplay: "0.0200",
      marketSymbol: "BTC",
      marketType: "perp",
      orderType: "limit",
      timeInForce: "good-till-time",
      reduceOnly: false,
      priceDisplay: "64000.0",
      notionalDisplay: "1280.0000000",
      orderExpiryIso: isoAt(28 * DAY),
    },
  },
  expiresAt: isoAt(9 * MINUTE),
  decision: null,
  decisionReason: null,
  executionStatus: "not_started",
  origin: "desk",
  projectId: null,
  requestedByClient: null,
};

export const DESK_DEPOSIT: ApprovalSummaryDto = {
  id: "h3-plate-desk-deposit",
  sessionId: DESK_SESSION_ID,
  toolCallId: "call_h3-plate-desk-deposit",
  toolName: "lighter:deposit",
  status: "pending",
  permissionAtEnqueue: "restricted",
  createdAt: isoAt(-30_000),
  resolvedAt: null,
  reasoningPreview: "Top up the Lighter account so the stop has margin room.",
  actionKind: "user_wallet_broadcast",
  riskLevel: "high",
  preview: {
    toolName: "deposit",
    namespace: "lighter",
    criticalArgs: {
      toolId: "lighter.deposit",
      summary: "Deposit 250 USDC from your wallet into your Lighter account",
      walletAddress: EVM_WALLET.address,
      depositTo: "Lighter Core, account 4821",
      settlementNetworkName: "Arbitrum",
      amountDisplay: "250 USDC",
      approvalRequired: "No: the allowance already covers this deposit",
      scopeNote: "One deposit of exactly this amount, sent once.",
      gatewayAddress: "0x3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f",
    },
  },
  expiresAt: isoAt(9 * MINUTE),
  decision: null,
  decisionReason: null,
  executionStatus: "not_started",
  origin: "agent",
  projectId: null,
  requestedByClient: null,
};

/**
 * "Review order" in the ticket's column, as the desk draws it today
 * (`DeskApprovalDialog.tsx`): the review's head, then the card with its own
 * footer, Reject and the approve key, kept inside the card. Reject has the
 * first focus.
 */
export function DeskReview(): JSX.Element {
  return (
    <section className="lp-ticket lp-review" aria-label="Order ticket">
      <dialog
        open
        className="lit-order-review"
        data-vex-area="lighter-desk-approval"
        data-placement="ticket"
        aria-labelledby="lp-review-title"
      >
        <header className="lit-order-review-head">
          <h2 id="lp-review-title">Review order</h2>
          <p>Nothing signs until you confirm.</p>
        </header>
        <ApprovalCard summary={DESK_ORDER} sessionId={DESK_SESSION_ID} focusOnMount idVariant="lighter-desk" />
      </dialog>
    </section>
  );
}

/**
 * Vex's proposal waiting in the desk chat, in H3's chat form: the card in
 * the transcript and its decision row docked at the column's foot, where the
 * composer stood (`ApprovalCard/approval-dock.tsx`).
 */
export function useDockedChatCard(): { readonly card: JSX.Element; readonly dock: JSX.Element } {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  return {
    card: (
      <div className="lp-chat lp-chat--card" aria-label="Desk chat">
        <ApprovalCard summary={DESK_DEPOSIT} sessionId={DESK_SESSION_ID} focusOnMount decisionDock={dock} />
      </div>
    ),
    dock: <div ref={setDock} className="vex-appr-dock lp-vex__dock" />,
  };
}
