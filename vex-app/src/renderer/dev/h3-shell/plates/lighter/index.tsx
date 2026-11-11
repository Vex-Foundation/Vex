/**
 * OUR H3 PLATES FOR THE LIGHTER DESK (row S8-02): a design proposal for the
 * owner, composed in the harness from H3-DESKTOP.md's tokens and cells. No
 * code for the desk itself is written until the owner approves them.
 *
 *   ?plate=lighter-desk          the desk with BTC perp open: the market bar,
 *                                the chart, the book, the ticket, the dock
 *                                with two positions, and the desk chat in
 *                                Vex's column at the right, her section open.
 *                                At 1000 x 720 it is the band layout.
 *   ?plate=lighter-desk-review   the ticket's Review order waiting, the
 *                                product's own card and gate, her section
 *                                closed
 *   ?plate=lighter-desk-two-step Vex's high-risk proposal in the desk chat,
 *                                its decision row docked at the column's
 *                                foot: press Approve once to see it armed
 *   ?plate=lighter-zen           Zen: the chart in the whole window
 *
 * Every figure is the plate's (`sample.ts`); nothing reads Lighter. The
 * bridge is the harness's stand-in, so the shell's own parts mounted here
 * (the rail, the account cell, the cards) read fixtures, and a press on a
 * card decides nothing.
 */

import type { JSX } from "react";
import type { BridgeAnswers } from "../../bridge.js";
import { mergeAnswers, ok } from "../../bridge.js";
import { baseAnswers } from "../../fixtures/base.js";
import { CHATS } from "../../fixtures/sessions.js";
import type { HarnessPlate } from "../types.js";
import { DESK_DEPOSIT, DESK_ORDER, DeskReview, useDockedChatCard } from "./cards.js";
import { Desk, TicketCell } from "./desk.js";
import { DeskFrame, useWindowSize } from "./frame.js";
import { VexColumn } from "./vex-column.js";
import { ZenPlate } from "./zen.js";

/** The book's rows: five a side at a full-height window, four under 800. */
function useBookRows(): number {
  const { height } = useWindowSize();
  return height < 800 ? 4 : 5;
}

function DeskPlate(): JSX.Element {
  const bookRows = useBookRows();
  return (
    <DeskFrame
      vexOpen
      vexState="ready"
      desk={<Desk ticket={<TicketCell />} bookRows={bookRows} />}
      vex={<VexColumn open needsYou={null} />}
    />
  );
}

function ReviewPlate(): JSX.Element {
  const bookRows = useBookRows();
  return (
    <DeskFrame
      vexOpen={false}
      vexState="awaiting"
      reviewing
      handle={false}
      desk={<Desk ticket={<DeskReview />} bookRows={bookRows} />}
      vex={
        <VexColumn
          open={false}
          needsYou={{
            sentence: "Buy 0.0200 BTC at 64000.0.",
            meta: (
              <>
                Lighter Core, real funds · expires <span className="vex-num">14:39 UTC</span>
              </>
            ),
          }}
        />
      }
    />
  );
}

function TwoStepPlate(): JSX.Element {
  const bookRows = useBookRows();
  const { card, dock } = useDockedChatCard();
  return (
    <DeskFrame
      vexOpen={false}
      vexState="awaiting"
      handle={false}
      desk={<Desk ticket={<TicketCell />} bookRows={bookRows} />}
      vex={
        <VexColumn
          open={false}
          needsYou={{
            sentence: "Deposit 250 USDC into Lighter.",
            meta: (
              <>
                Arbitrum, real funds · expires <span className="vex-num">14:39 UTC</span>
              </>
            ),
          }}
          chat={card}
          foot={dock}
        />
      }
    />
  );
}

/** The reads the mounted shell parts make, and the plates' two pending cards. */
function deskAnswers(): BridgeAnswers {
  const pending = [DESK_ORDER, DESK_DEPOSIT];
  return mergeAnswers(baseAnswers({ sessions: [...CHATS], pendingAll: [] }), {
    approvals: {
      listPending: () => ok(pending),
      get: ({ id }) => ok(pending.find((row) => row.id === id) ?? null),
    },
  });
}

const DESK_UI = { runtimeMode: "lighter", leftOpen: false, shellRoute: { kind: "none" } } as const;

export const LIGHTER_PLATES: readonly HarnessPlate[] = [
  {
    id: "lighter-desk",
    title: "Lighter desk: BTC perp open, two positions, the desk chat in Vex's column (band at 1000 x 720)",
    Plate: DeskPlate,
    answers: deskAnswers,
    ui: DESK_UI,
  },
  {
    id: "lighter-desk-review",
    title: "Lighter desk: Review order waiting in the ticket's place, one press decides (risk medium)",
    Plate: ReviewPlate,
    answers: deskAnswers,
    ui: DESK_UI,
  },
  {
    id: "lighter-desk-two-step",
    title: "Lighter desk: Vex's deposit in the desk chat, two presses decide (press Approve once to arm it)",
    Plate: TwoStepPlate,
    answers: deskAnswers,
    ui: DESK_UI,
  },
  {
    id: "lighter-zen",
    title: "Lighter Zen: the chart in the whole window",
    Plate: ZenPlate,
  },
];
