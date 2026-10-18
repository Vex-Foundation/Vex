/**
 * ASK VEX - the Board page's question block, in the Vex sidebar under Needs
 * you (docs/design/R3-MINIMAL.md sections 5.1 and 9.4; product spec item 5).
 *
 * WHAT THE READER SEES: the head "Ask Vex about this token", the token this
 * question is about as a VISIBLE context chip ("UBERCAT · Base · snapshot
 * 11:11 UTC"), four quick questions that PRE-FILL an editable field, and a
 * Send that hands the finished question to the chat. The answer lands in the
 * main transcript, and the page may stay open while it does.
 *
 * THE CHIP IS NOT DECORATION. The same facts it shows are interpolated into
 * the message text by {@link buildBoardAskMessage} before anything is sent, so
 * the context the reader consented to is INSIDE the persisted turn: logged by
 * construction, reproducible from the transcript alone, never a hidden prompt
 * layer (rule 09, model-visible iff logged).
 *
 * FROZEN AT PRESS TIME. The context is read from the figures ON SCREEN at the
 * moment Send is pressed. A live board moves; re-reading its price on the way
 * to the engine would answer a question the reader never asked.
 *
 * NO SUBMIT LIVES HERE. The panel parks an envelope on
 * `board-ask-intent.ts`; the resident composer consumes it through the same
 * high-level dispatch path every typed message takes (mutex, mission gate,
 * steering fallback, queue, retry). This file has no chat API import, and it
 * must not grow one.
 */

import { useMemo, useState, type JSX } from "react";
import { chainDisplayBySlug } from "@shared/chains/display.js";
import {
  LineChevronRight,
  LineClose,
  LineSpark,
} from "../../../components/icons/line/index.js";
import {
  boardLiveReadout,
  isBoardLiveHeld,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import {
  nextBoardAskIntentId,
  useBoardAskIntentStore,
} from "./board-ask-intent.js";
import {
  BOARD_ASK_QUICK_QUESTIONS,
  boardKeyOf,
  buildBoardAskMessage,
  type BoardAskContext,
  type BoardAskSlotProps,
} from "./board-surface-contracts.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";
import { formatBoardUtcClock } from "./boardFormat.js";
import { buildBoardViewModel } from "./boardModel.js";

/** What the panel says after a question has been handed to the chat. */
export const BOARD_ASK_SENT_NOTICE = "Sent to the chat. The answer appears there.";

/** The block's head in the Vex sidebar, the design's words. */
export const BOARD_ASK_HEADING = "Ask Vex about this token";

/** What the chip says when the board carries no pool at this index. */
const BOARD_ASK_NO_TOKEN = "No token selected";

export function AskVexPanel({ board, poolIndex }: BoardAskSlotProps): JSX.Element {
  const spec = board.spec;
  const boardKey = boardKeyOf(board);
  const setBoardAskOpen = useBoardSurfaceStore((s) => s.setBoardAskOpen);
  const publishBoardAskIntent = useBoardAskIntentStore(
    (s) => s.publishBoardAskIntent,
  );

  const publication = useBoardLiveOverlayStore((state) =>
    selectBoardLivePublication(state, boardKey),
  );
  const readout = boardLiveReadout(publication);
  const model = useMemo(
    () =>
      buildBoardViewModel(spec, Date.now(), {
        mode: readout.mode,
        rowsByKey: publication?.rowsByKey ?? null,
        fetchedAtMs: publication?.fetchedAtMs ?? null,
      }),
    [spec, readout.mode, publication],
  );

  const card = model.cards[poolIndex] ?? null;
  const [draft, setDraft] = useState<string>("");
  const [sent, setSent] = useState<boolean>(false);

  const symbol = card?.row?.baseTokenSymbol ?? null;
  const chainName = card === null ? null : chainDisplayBySlug(card.chain).name;
  const held = isBoardLiveHeld(model.mode);
  const clock = formatBoardUtcClock(model.marketDataFetchedAt);
  // The chip's reading and the envelope's reading are the SAME derivation, so
  // the words the reader consented to cannot drift from the words the model
  // is given.
  const reading = held ? "live" : clock === null ? "snapshot" : `snapshot ${clock}`;
  const chipLabel =
    card === null || symbol === null || chainName === null
      ? BOARD_ASK_NO_TOKEN
      : `${symbol} · ${chainName} · ${reading}`;

  const question = draft.trim();
  const canSend = card !== null && question.length > 0;

  const onSend = (): void => {
    if (card === null) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    const context: BoardAskContext = {
      boardTitle: board.title,
      tokenSymbol: card.row?.baseTokenSymbol ?? null,
      tokenName: card.row?.baseTokenName ?? null,
      chain: card.chain,
      pairAddress: card.pairAddress,
      ammId: card.row?.dexId ?? null,
      priceUsd: card.row?.priceUsd ?? null,
      dataMode: model.mode,
      observedAtMs: model.marketDataFetchedAt,
    };
    publishBoardAskIntent({
      sessionId: board.sessionId,
      boardKey,
      intentId: nextBoardAskIntentId(),
      context,
      message: buildBoardAskMessage(context, trimmed),
    });
    setDraft("");
    setSent(true);
  };

  return (
    <section
      data-vex-area="board-ask-panel"
      aria-label={`Ask Vex about ${symbol ?? "this board"}`}
      className="vex-bd-ask"
    >
      <div className="vex-bd-ask__top">
        <h3 className="vex-bd-ask__h">{BOARD_ASK_HEADING}</h3>
        <button
          type="button"
          data-vex-area="board-ask-close"
          aria-label="Close Ask Vex"
          onClick={() => {
            setBoardAskOpen(false);
          }}
          className="vex-bd-key vex-bd-ask__close"
        >
          <LineClose size={14} />
        </button>
      </div>
      <p className="vex-bd-ask__note">The answer lands in the chat behind this board.</p>

      {/* THE CONTEXT CHIP. Visible, and identical in substance to the header
        * of the message that gets sent. */}
      <p
        data-vex-area="board-ask-context"
        data-live={held ? "true" : "false"}
        className="vex-bd-ask__ctx"
        title={chipLabel}
      >
        {chipLabel}
      </p>

      <div
        data-vex-area="board-ask-quick"
        className="vex-bd-ask__quick"
        role="group"
        aria-label="Quick questions"
      >
        {BOARD_ASK_QUICK_QUESTIONS.map((quick) => (
          <button
            key={quick}
            type="button"
            data-vex-area="board-ask-quick-question"
            onClick={() => {
              // PRE-FILL, never send: the reader edits before anything leaves
              // this block.
              setDraft(quick);
              setSent(false);
            }}
            className="vex-bd-ask__q"
          >
            <LineChevronRight size={14} />
            {quick}
          </button>
        ))}
      </div>

      <label data-vex-area="board-ask-field">
        <span className="sr-only">Your question</span>
        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSent(false);
          }}
          rows={2}
          placeholder="Ask about this token"
          className="vex-bd-ask__field"
        />
      </label>

      <button
        type="button"
        data-vex-area="board-ask-send"
        disabled={!canSend}
        onClick={onSend}
        className="vex-bd-ask__send"
      >
        <LineSpark size={16} />
        Send to chat
      </button>

      {/* The confirmation is spoken as well as shown: the transcript this
        * question landed in is behind the page, out of the reader's view. */}
      <p data-vex-area="board-ask-sent" aria-live="polite" className="vex-bd-ask__sent">
        {sent ? BOARD_ASK_SENT_NOTICE : ""}
      </p>
    </section>
  );
}
