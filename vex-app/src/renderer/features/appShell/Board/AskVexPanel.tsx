/**
 * ASK VEX - the board modal's right-side question panel (product spec item 5).
 *
 * WHAT THE READER SEES: the token this question is about as a VISIBLE context
 * chip ("UBERCAT · Base · snapshot 11:11 UTC"), four quick questions that
 * PRE-FILL an editable field, and a Send that hands the finished question to
 * the chat. The answer lands in the main transcript, and the modal may stay
 * open while it does.
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
import { IconClose, IconSparkle } from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";
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
      aria-label={`Ask VEX about ${symbol ?? "this board"}`}
      className="flex h-full min-h-0 flex-col gap-3 pt-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-[15px] font-bold leading-[20px] tracking-[-0.01em] text-ink-primary">
            Ask VEX
          </p>
          <p className="mt-0.5 text-[12px] leading-[16px] text-ink-tertiary">
            The answer lands in the chat behind this board.
          </p>
        </div>
        <button
          type="button"
          data-vex-area="board-ask-close"
          aria-label="Close the Ask VEX panel"
          onClick={() => {
            setBoardAskOpen(false);
          }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary hover:bg-interactive-active hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconClose size={14} />
        </button>
      </div>

      {/* THE CONTEXT CHIP. Visible, and identical in substance to the header
        * of the message that gets sent. */}
      <p
        data-vex-area="board-ask-context"
        data-live={held ? "true" : "false"}
        className="truncate rounded-lg border border-line-2 bg-surface-2 px-2.5 py-1.5 text-[12px] font-medium leading-[16px] text-ink-secondary"
        title={chipLabel}
      >
        {chipLabel}
      </p>

      <div
        data-vex-area="board-ask-quick"
        className="flex flex-col gap-1.5"
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
              // this panel.
              setDraft(quick);
              setSent(false);
            }}
            className="rounded-lg border border-line-2 px-2.5 py-1.5 text-left text-[12.5px] leading-[17px] text-ink-secondary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            {quick}
          </button>
        ))}
      </div>

      <label
        className="flex min-h-0 flex-1 flex-col gap-1.5"
        data-vex-area="board-ask-field"
      >
        <span className="vex-micro-label uppercase text-ink-secondary">
          Your question
        </span>
        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSent(false);
          }}
          rows={4}
          placeholder="Ask about this token"
          className="min-h-[96px] w-full resize-y rounded-lg border border-line-2 bg-surface-2 px-2.5 py-2 text-[13px] leading-[18px] text-ink-primary placeholder:text-ink-dimmed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <button
        type="button"
        data-vex-area="board-ask-send"
        disabled={!canSend}
        onClick={onSend}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          canSend
            ? "bg-button-accent text-ink-on-button-accent hover:bg-button-accent-hover"
            : "cursor-not-allowed border border-line-2 text-ink-dimmed",
        )}
      >
        <IconSparkle size={14} />
        Send to chat
      </button>

      {/* The confirmation is spoken as well as shown: the transcript this
        * question landed in is behind the modal, out of the reader's view. */}
      <p
        data-vex-area="board-ask-sent"
        aria-live="polite"
        className="min-h-[16px] text-[12px] leading-[16px] text-ink-tertiary"
      >
        {sent ? BOARD_ASK_SENT_NOTICE : ""}
      </p>
    </section>
  );
}
