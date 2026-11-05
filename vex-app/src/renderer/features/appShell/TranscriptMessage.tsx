/**
 * One transcript row - presentational only (S5 act ledger), drawn as the H3
 * chat (docs/design/H3-DESKTOP.md section 1.7) where H3 has restyled a part,
 * and as the R3 conversation (docs/design/R3-MINIMAL.md section 6) elsewhere.
 *
 * Switches on the pure `TranscriptEntry.variant`. USER rows are H3's bubble
 * at the right of the column beside the person's round avatar cell, their
 * clock and keys hover-revealed at the bubble's left; VEX's turn runs on the
 * column's own left edge with no token beside it (her presence is the Vex key
 * in the header), her answer in the sans at 16 / 1.6, her clock and message
 * keys in a tail row BELOW the body. Tool calls read as step rows; several
 * finished steps
 * fold into one quiet row. Assistant prose renders through `MarkdownContent`
 * (stage 8-2a) - safe React elements, never an HTML string; user/tool/notice
 * rows + the `compaction`/`recall` markers (stage 8-4) render as plain React
 * text nodes. Either way model/tool output cannot inject markup.
 */

import { memo, type JSX, type ReactNode } from "react";
import { Swatch } from "../../components/ui/swatch.js";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import {
  BranchMessageAction,
  CopyMessageAction,
  EditMessageAction,
  FeedbackMessageAction,
  type MessageFeedbackContext,
} from "./TranscriptMessage/MessageIconActions.js";
import { CompactionMarker } from "./CompactionMarker.js";
import { deskMessageForDisplay } from "./lighterTrading/desk-context.js";
import { MemoryMarker } from "./MemoryMarker.js";
import { ReasonedBlock } from "./ReasonedBlock.js";
import { BoardRowCard } from "./Board/BoardRowCard.js";
import type { BoardArrival } from "./Board/board-surface-contracts.js";
import { ToolActRow } from "./ToolLedger/ToolActRow.js";
import { ActReceipt, receiptTxRef } from "./ToolLedger/ReceiptCard.js";
import {
  MissionStopResult,
  readMissionStopResult,
} from "./ToolLedger/MissionStopResult.js";
import {
  TechnicalAnalysisResult,
  readTechnicalAnalysisResult,
} from "./ToolLedger/TechnicalAnalysisResult.js";
import { ExplorerRefLinks } from "./ToolLedger/ExplorerRefLinks.js";
import { ToolGroupRow } from "./ToolLedger/ToolGroupRow.js";
import { ToolDisclosure } from "./ToolDisclosure.js";
import type { OperatorInterruptDispositionDto } from "@shared/schemas/messages.js";
import type {
  ToolCallActView,
  ToolGroupRowModel,
  TranscriptEntry,
  TranscriptRowModel,
} from "./transcriptRowModel.js";

/**
 * HH:MM in the user's local time — the register caption is a clock entry,
 * not a full date. Returns null for an unparseable timestamp so the caption
 * degrades to the speaker name alone instead of printing "NaN:NaN".
 */
function formatClock(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The clock readout for one entry - HH:MM, or nothing for an unparseable
 * timestamp. It trails "You" in the user caption and leads Vex's tail row.
 */
function TapeClock({
  createdAt,
  className,
}: {
  readonly createdAt: string;
  readonly className?: string;
}): JSX.Element | null {
  const clock = formatClock(createdAt);
  return clock === null ? null : <span className={className}>{clock}</span>;
}

/**
 * Vex's turn on the column's own edge (docs/design/H3-DESKTOP.md section 1.7).
 * H3 draws no token beside her rows: her presence is the Vex key in the
 * header, and the thinking row, the steps, her answer and the receipt run the
 * full width of the column, level with the person's bubble on the right. So
 * the R3 token and its 40px gutter are gone, and the two facts the token
 * carried stay as seams on the row itself:
 *
 *   data-vex-turn-head    this row opens her turn (`turnMarks.ts`): the
 *                         first row she writes after the person's message;
 *   data-vex-agent-state  `working` for the newest row of the turn in flight
 *                         (`findWorkingAgentEntryKey`), else `settled`. What
 *                         a reader sees of a live turn is the live row's word
 *                         and timer; this is a seam, never a visible mark.
 *
 * The row's sr-only speaker label still names the turn for assistive
 * technology.
 */
interface TurnSeams {
  readonly "data-vex-turn-head"?: "";
  readonly "data-vex-agent-state": "working" | "settled";
}

function turnSeams(turnHead: boolean, working: boolean): TurnSeams {
  return {
    ...(turnHead ? { "data-vex-turn-head": "" as const } : {}),
    "data-vex-agent-state": working ? "working" : "settled",
  };
}

/**
 * The person's avatar cell beside their bubble (docs/design/H3-DESKTOP.md
 * section 1.7): a 36px disc on a 1px chosen rule with the person glyph in ink,
 * as H3 draws it at the right of the message and in the account cell.
 *
 * Drawn as ONE SVG, as `VxToken` draws its disc, so the disc is a circle while
 * every box keeps radius 0 (base.css's shape law). Desktop has no profile
 * picture, so the glyph is the only honest face: the same person for every
 * message, never initials or a stand-in portrait. The disc's measured fill
 * (#151718) has no token of its own; `.vex-you__disc` paints the nearest
 * raised step. Decorative: the caption's sr-only "You" names the speaker.
 */
function YouAvatar(): JSX.Element {
  return (
    <span aria-hidden data-vex-you-avatar="" className="vex-you__avatar">
      <svg width={36} height={36} viewBox="0 0 36 36" focusable="false">
        <circle className="vex-you__disc" cx="18" cy="18" r="17.5" strokeWidth="1" />
        <g className="vex-you__glyph">
          <circle cx="18" cy="14.5" r="3.5" />
          <path d="M11 25c0-3.9 3.1-6.2 7-6.2s7 2.3 7 6.2z" />
        </g>
      </svg>
    </span>
  );
}

/**
 * The speaker label, for assistive technology only. The visual wordmark is
 * gone (owner QA round 2, item 5 - "REMOVE the VEX name text"), but a screen
 * reader still has to be told whose turn this is, and the mark carries no
 * accessible name. Mirrors `SidebarHomeSigil`: the mark alone, never a
 * wordmark, plus a text equivalent.
 */
function AssistantSpeakerLabel(): JSX.Element {
  return <span className="sr-only">Vex</span>;
}

// Caption action buttons (copy A13, feedback G7, branch A14, edit A18) live
// in `TranscriptMessage/MessageIconActions.tsx`; the context type is
// re-exported so existing consumers keep their import path.
export type { MessageFeedbackContext };

/**
 * The assistant turn's TAIL chrome: clock + per-message actions, below the
 * body rather than above it.
 *
 * It used to be a caption ABOVE the body, and the only thing visible in it at
 * rest was the "VEX" name. With the name retired, a header row would have
 * reserved ~24px of permanently blank band between every avatar and its own
 * first line of prose. Moving the row to the turn's tail (the deepseek
 * turn-tail position) removes that band, lets the body start level with the
 * mark, and puts the reveal where a reader already expects end-of-turn chrome.
 *
 * Everything in it is hover/focus revealed via opacity, never display, so the
 * reserved line is paid for once and nothing shifts when it materializes.
 */
function AssistantActionsTail({
  createdAt,
  copyText,
  feedback,
  onBranch,
}: {
  readonly createdAt: string;
  /** Markdown source for the hover copy key; omitted = no copy affordance. */
  readonly copyText?: string;
  /** Per-message feedback context; omitted = no feedback affordance. */
  readonly feedback?: MessageFeedbackContext;
  /** Fork-after-this-reply key (A14); omitted = no branch affordance. */
  readonly onBranch?: () => void;
}): JSX.Element {
  return (
    // Register C2: message chrome is HUMAN, so it is the sans at 12 muted
    // (`.vex-micro`) - mono is reserved for figures and technical strings.
    <span
      data-vex-message-tail=""
      className="vex-micro vex-reply__tail tabular-nums"
    >
      {/* A15 — the clock is hover-revealed chrome (80ms, hover:hover +
          focus-within; always visible on touch). */}
      <TapeClock createdAt={createdAt} className="vex-time-reveal" />
      {copyText !== undefined ? (
        <CopyMessageAction text={copyText} markdown />
      ) : null}
      {onBranch !== undefined ? (
        <BranchMessageAction label="Branch from here" onBranch={onBranch} />
      ) : null}
      {feedback !== undefined ? (
        <FeedbackMessageAction context={feedback} />
      ) : null}
    </span>
  );
}

/**
 * Document-typography wrapper around the safe markdown renderer.
 *
 * TYPOGRAPHY LAW (docs/design/H3-DESKTOP.md section 2.3): every word is Be
 * Vietnam Pro, 400 with 600 for emphasis and heads, in ink; figures inside
 * code and tables keep their own faces. Vex's answer is set at 16 / 1.45
 * with 12 between paragraphs in her bubble, the person's own reading size
 * (VEX Cloud's `.t-vex p`). The face is declared on `.vex-chat-prose`
 * (type.css), the turn's metric on `.vex-reply .vex-chat-prose` and the
 * bubble on this wrapper, `.vex-answer` (chat-transcript.css); the wrapper
 * only owns the tone and wrapping here.
 */
function AssistantBody({ content }: { readonly content: string }): JSX.Element {
  return (
    <div className="vex-answer break-words text-ink-primary">
      <MarkdownContent text={content} />
    </div>
  );
}

/**
 * MEMOIZED (owner decree 2026-08-03, streaming speed). The transcript re-maps
 * every row on each preview tick, and without this boundary each of those rows
 * re-rendered and re-lexed its markdown at provider token rate. Every prop is
 * referentially stable across a preview tick (`row` comes from the `rows`
 * memo, `pendingApprovals` from its own memo, `agentWorking` and `turnMark`
 * are booleans), so the default shallow comparison actually holds.
 */
export const TranscriptMessage = memo(function TranscriptMessage({
  row,
  pendingApprovals,
  agentWorking = false,
  turnMark = true,
  turnSteps,
  thoughtMs,
  sessionId,
  boardArrival = "settled",
  feedbackSessionId,
  feedbackMessageKey,
  onEditMessage,
  onEditInNewBranch,
  onBranchFrom,
}: {
  readonly row: TranscriptEntry;
  /**
   * toolCallId to PENDING approval id for the active session (S5). Steps whose
   * call id matches get the "Waiting for approval" link to their card.
   */
  readonly pendingApprovals?: ReadonlyMap<string, string>;
  /** True only for the newest assistant row in the currently active turn. */
  readonly agentWorking?: boolean;
  /**
   * This row heads Vex's turn (`turnMarks.ts`), stamped on it as
   * `data-vex-turn-head`. A row rendered on its own heads its own turn, hence
   * the default.
   */
  readonly turnMark?: boolean;
  /**
   * Set only on the turn's thinking row (`turnSteps.ts`): the whole turn's
   * steps, which its first Reasoned row says at its right. Two PRIMITIVES, so
   * the memo boundary's shallow comparison keeps holding.
   */
  readonly turnSteps?: number;
  /**
   * The live turn clock's reading for this turn (`TurnIsland/turnClock.ts`),
   * set only on the thinking row of a turn watched live.
   */
  readonly thoughtMs?: number;
  /**
   * The owning session, for the reads a row makes of its own: the activity
   * ledger a filled receipt is drawn from (`ToolLedger/ReceiptCard.tsx`).
   * Omitted = no receipts (a read-only surface with no session).
   */
  readonly sessionId?: string;
  /**
   * How this row reached the screen, for a board card riding on it (A13).
   *
   * A PRIMITIVE, and it comes from the SAME bookkeeping that decides whether
   * the row plays its print animation, so the unseen dot and the animation can
   * never disagree about what "new" means. Defaulted to `"settled"` and
   * FAIL-CLOSED: an unknown provenance never lights a dot.
   */
  readonly boardArrival?: BoardArrival;
  /**
   * Per-message feedback identifiers (G7); both omitted = no affordance.
   * Two PRIMITIVES rather than one object so the memo boundary's shallow
   * comparison keeps holding at streaming rate (owner decree 2026-08-03).
   */
  readonly feedbackSessionId?: string;
  readonly feedbackMessageKey?: string;
  /**
   * Fork/edit callbacks (A14/A18): row-agnostic STABLE references (the
   * message id travels in the call, not the prop) so the memo boundary's
   * shallow comparison keeps holding at streaming rate. All omitted = no
   * affordances (read-only transcript surfaces).
   */
  readonly onEditMessage?: (messageId: number, content: string) => void;
  readonly onEditInNewBranch?: (messageId: number, content: string) => void;
  readonly onBranchFrom?: (messageId: number) => void;
}): JSX.Element {
  const feedbackContext: MessageFeedbackContext | undefined =
    feedbackSessionId !== undefined && feedbackMessageKey !== undefined
      ? { sessionId: feedbackSessionId, messageKey: feedbackMessageKey }
      : undefined;
  // The turn's thinking row is this row's FIRST Reasoned row; every other
  // one stays a plain "Thought".
  const headSteps = turnSteps ?? null;
  const headThoughtMs = turnSteps === undefined ? null : (thoughtMs ?? null);
  switch (row.variant) {
    case "user": {
      // A desk message carries the market scope, the desk's values and the
      // house style for the agent. The trader wrote the part above them, and
      // that is the part they get back. The row still holds what was sent.
      const written = deskMessageForDisplay(row.content);
      return (
        <div
          data-vex-message-role="user"
          data-time-hover-root=""
          className="vex-you"
        >
          {/* THE PERSON'S MESSAGE (docs/design/H3-DESKTOP.md section 1.7): a
              bubble at the right of the column, beside the round avatar
              cell. The bubble is the one fill H3 measured for it (`bubble`,
              section 2.1), its words sans 17 in ink, plain text and never
              markdown. H3 draws no caption: the avatar says whose words these
              are, so "You" is told to assistive technology alone, and the
              clock and the message keys wait at the bubble's left until the
              row is hovered or focused (opacity, so nothing shifts). */}
          <span className="vex-micro vex-you__cap tabular-nums">
            {feedbackContext !== undefined ? (
              <FeedbackMessageAction context={feedbackContext} />
            ) : null}
            {onEditInNewBranch !== undefined ? (
              <BranchMessageAction
                label="Edit in a new branch"
                onBranch={() => onEditInNewBranch(row.id, written)}
              />
            ) : null}
            {onEditMessage !== undefined ? (
              <EditMessageAction
                onEdit={() => onEditMessage(row.id, written)}
              />
            ) : null}
            <CopyMessageAction text={written} />
            <span className="sr-only">You</span>
            <TapeClock createdAt={row.createdAt} className="vex-time-reveal" />
          </span>
          <div className="vex-you__stack">
            <p className="vex-you__body">{written}</p>
            {/* A33 - an operator instruction says WHEN it reaches the model,
                in words. The words come from the engine's own typed
                disposition (M6), never from the row kind: the kind means only
                "this is an operator instruction", and three different things
                can have happened to one. Hardcoding the steered wording told a
                user whose message was queued against a parked run that it
                would be read at the agent's next step, contradicting the
                acknowledgement written beside it in the very same
                transaction. */}
            {row.steering === true ? (
              <span
                data-vex-steering-mark=""
                data-vex-disposition={row.interruptDisposition}
                className="vex-micro vex-you__note"
              >
                {steeringMarkText(row.interruptDisposition)}
              </span>
            ) : null}
          </div>
          <YouAvatar />
        </div>
      );
    }
    case "assistant":
      return (
        <div
          data-vex-message-role="assistant"
          data-time-hover-root=""
          className="vex-reply"
          {...turnSeams(turnMark, agentWorking)}
        >
          <AssistantSpeakerLabel />
          <ReasonedBlock
            reasoning={row.reasoning}
            steps={headSteps}
            thoughtMs={headThoughtMs}
          />
          <AssistantBody content={row.content} />
          {row.board != null ? (
            <BoardRowCard
              messageId={row.id}
              spec={row.board}
              arrival={boardArrival}
            />
          ) : null}
          <AssistantActionsTail
            createdAt={row.createdAt}
            copyText={row.content}
            feedback={feedbackContext}
            onBranch={
              onBranchFrom !== undefined
                ? () => onBranchFrom(row.id)
                : undefined
            }
          />
        </div>
      );
    case "assistant_stopped":
      return (
        <div
          data-vex-message-role="assistant"
          data-vex-stopped=""
          data-time-hover-root=""
          className="vex-reply"
          {...turnSeams(turnMark, agentWorking)}
        >
          <AssistantSpeakerLabel />
          <ReasonedBlock
            reasoning={row.reasoning}
            steps={headSteps}
            thoughtMs={headThoughtMs}
          />
          <AssistantBody content={row.content} />
          <AssistantActionsTail
            createdAt={row.createdAt}
            copyText={row.content}
            feedback={feedbackContext}
            onBranch={
              onBranchFrom !== undefined
                ? () => onBranchFrom(row.id)
                : undefined
            }
          />
          {/* A status in H3's grammar (docs/design/H3-DESKTOP.md section
              2.2): the small square and the caps word. Stopped is neither a
              fill nor a failure, so the square is the empty outline. */}
          <div className="vex-reply__stopped">
            <Swatch state="idle" size={8} />
            <span>Stopped</span>
          </div>
        </div>
      );
    case "tool":
      // S5 - THE ACT LEDGER, as step rows (docs/design/R3-MINIMAL.md
      // section 6). Orphan results (no call paired in their run) keep the
      // standalone disclosure; a call row registers one step per executed
      // call, and two or more finished steps fold into one quiet row.
      if (row.toolKind === "result") {
        return (
          <div
            data-vex-message-role="tool"
            className="vex-reply"
            {...turnSeams(turnMark, false)}
          >
            <div className="vex-steps">
              <ToolDisclosure
                label={row.label ?? "tool_output"}
                body={row.content}
                emptyHint="(no output)"
              />
              {/* Orphan result (call scrolled out of the page): its validated
                  explorer refs still surface here - grouped/paired acts get
                  theirs via ToolActRow instead. Inert when nothing resolves. */}
              <ExplorerRefLinks refs={row.explorerRefs} />
            </div>
          </div>
        );
      }
      return (
        <div
          data-vex-message-role="tool"
          className="vex-reply"
          {...turnSeams(turnMark, agentWorking)}
        >
          {/* Assistant prose accompanying the tool call (often empty). */}
          {row.content.length > 0 ? (
            <div data-time-hover-root="">
              <AssistantSpeakerLabel />
              <ReasonedBlock
                reasoning={row.reasoning}
                steps={headSteps}
                thoughtMs={headThoughtMs}
              />
              <AssistantBody content={row.content} />
              <AssistantActionsTail createdAt={row.createdAt} />
            </div>
          ) : null}
          {/* A prose-less tool row carries the turn's reasoning itself - the
              split rows share `dto.id`, and `splitToolCallProse` guarantees
              only ONE of them ever holds it, so this can never double-render. */}
          {row.content.length === 0 ? (
            <ReasonedBlock
              reasoning={row.reasoning}
              steps={headSteps}
              thoughtMs={headThoughtMs}
            />
          ) : null}
          <ToolSteps
            row={row}
            pendingApprovals={pendingApprovals}
            sessionId={sessionId}
          />
        </div>
      );
    case "tool_group":
      // A run of calls folded into one quiet row, on the turn's edge.
      // EVERY folded trace (the prose-less call rows' reasoning, which the
      // aggregation would otherwise swallow) gets its OWN collapsible block,
      // stacked in turn order above the fold, so a group never silently drops
      // the later halves of the turn's thinking. Index keys are correct here:
      // the list is a fixed, ordered projection of the group model, never
      // reordered or spliced.
      return (
        <div className="vex-reply" {...turnSeams(turnMark, false)}>
          {(row.reasonings ?? []).map((trace, index, traces) => {
            // The group's first non-empty trace is the one a thinking row
            // can open, so it carries the turn's head (`turnSteps.ts`).
            const head = index === traces.findIndex((t) => (t ?? "").length > 0);
            return (
              <ReasonedBlock
                key={`${row.id}-${index}`}
                reasoning={trace}
                steps={head ? headSteps : null}
                thoughtMs={head ? headThoughtMs : null}
              />
            );
          })}
          <ToolGroupRow group={row} pendingApprovals={pendingApprovals} />
          <ActReceipts acts={row.calls ?? []} sessionId={sessionId} />
          {/* A group folds its acts; a mission result must not fold with them. */}
          {(row.calls ?? []).map((call) => {
            const stopResult = readMissionStopResult(call);
            return stopResult !== null ? (
              <MissionStopResult key={call.toolCallId} result={stopResult} />
            ) : null;
          })}
          {/* Nor may an analysis the user asked for. */}
          {(row.calls ?? []).map((call) => {
            const analysis = readTechnicalAnalysisResult(call);
            return analysis !== null ? (
              <TechnicalAnalysisResult key={`ta-${call.toolCallId}`} result={analysis} />
            ) : null;
          })}
        </div>
      );
    case "notice":
      return (
        <div data-vex-message-role="system" className="flex justify-center">
          <NoticeBody tone={row.noticeTone ?? "runtime"}>
            {row.content}
          </NoticeBody>
        </div>
      );
    case "compaction":
      return <CompactionMarker content={row.content} />;
    case "recall":
      return <MemoryMarker toolName={row.label} content={row.content} />;
    default: {
      const exhaustive: never = row.variant;
      throw new Error(`Unhandled transcript variant: ${String(exhaustive)}`);
    }
  }
});

/**
 * The steps of one call row. One executed call is one step row; two or more
 * fold into one quiet row ("2 tool calls · Wallet balances, Market data")
 * that opens to the step rows (docs/design/R3-MINIMAL.md section 6). An
 * accepted MissionStop's result stays visible under the steps either way.
 */
function ToolSteps({
  row,
  pendingApprovals,
  sessionId,
}: {
  readonly row: TranscriptRowModel;
  readonly pendingApprovals?: ReadonlyMap<string, string>;
  readonly sessionId?: string;
}): JSX.Element | null {
  const acts = resolveActs(row);
  if (acts.length === 0) return null;
  const stopResults = acts.map((act) => ({
    key: act.toolCallId,
    result: readMissionStopResult(act),
  }));
  const analyses = acts.map((act) => ({
    key: act.toolCallId,
    result: readTechnicalAnalysisResult(act),
  }));
  return (
    <>
      {acts.length > 1 ? (
        <ToolGroupRow group={foldOf(row, acts)} pendingApprovals={pendingApprovals} />
      ) : (
        <div data-vex-tool-ledger="" className="vex-steps">
          {acts.map((act) => (
            <ToolActRow
              key={act.toolCallId}
              act={act}
              pendingApprovalId={pendingApprovals?.get(act.toolCallId) ?? null}
            />
          ))}
        </div>
      )}
      <ActReceipts acts={acts} sessionId={sessionId} />
      {stopResults.map(({ key, result }) =>
        result !== null ? <MissionStopResult key={key} result={result} /> : null,
      )}
      {analyses.map(({ key, result }) =>
        result !== null ? <TechnicalAnalysisResult key={`ta-${key}`} result={result} /> : null,
      )}
    </>
  );
}

/**
 * The filled receipts under a row's steps (`ToolLedger/ReceiptCard.tsx`): one
 * per act that executed a proven fund-moving operation with a transaction,
 * drawn only once the session's activity ledger confirms that transaction as
 * a swap. A surface that renders a row without its session draws none.
 */
function ActReceipts({
  acts,
  sessionId,
}: {
  readonly acts: readonly ToolCallActView[];
  readonly sessionId: string | undefined;
}): JSX.Element | null {
  if (sessionId === undefined) return null;
  return (
    <>
      {acts.map((act) => {
        const txRef = receiptTxRef(act);
        return txRef === null ? null : (
          <ActReceipt key={`rc-${act.toolCallId}`} txRef={txRef} sessionId={sessionId} />
        );
      })}
    </>
  );
}

/** The fold of one call row's acts, in the group shape the fold row reads. */
function foldOf(
  row: TranscriptRowModel,
  acts: readonly ToolCallActView[],
): ToolGroupRowModel {
  const names: string[] = [];
  for (const act of acts) {
    if (!names.includes(act.toolName)) names.push(act.toolName);
  }
  return {
    variant: "tool_group",
    id: row.id,
    calls: acts,
    distinctToolNames: names,
    createdAt: row.createdAt,
  };
}

/**
 * Acts for a call row. Rows that went through `groupTranscriptRows` carry
 * `toolActs` (outputs merged); rows rendered directly from `toTranscriptRows`
 * fall back to the raw call displays with no output.
 */
function resolveActs(row: TranscriptRowModel): readonly ToolCallActView[] {
  if (row.toolActs !== undefined) return row.toolActs;
  return (row.toolCalls ?? []).map((call) => ({
    ...call,
    output: null,
  }));
}

/**
 * Runtime/error notice. A runtime notice is 12 muted, centred. An error
 * notice wears the turn-error ROW grammar (A20, in the flow, not a box): the
 * ink cross, "Error" in ink 500, the persisted sanitized message at 13 ink 2,
 * never red.
 * The session-level banner remains the session-scope surface.
 *
 * `ack` (M6) is the runtime stamp plus a POLITE live region. It is the engine's
 * durable answer to an operator instruction, so it is the one notice a screen
 * reader should hear on arrival - politely, because it reports what already
 * happened and must never cut across the operator's own typing. Every other
 * runtime notice (wake banners and the rest) stays silent, which is why this
 * needed its own tone rather than an `aria-live` on the whole variant.
 */
/**
 * The register mark under an operator instruction, per disposition.
 *
 * Each says WHEN the agent reads the message, because that is the only thing
 * the operator actually wants from this mark and the one thing the old single
 * string got wrong for two of the three cases. The wording is deliberately
 * close to the engine's own acknowledgement text: the two rows describe one
 * event and are written from one typed value, so they must not read as two
 * different claims.
 *
 * A total default, not an exhaustive switch: the disposition is absent on
 * legacy rows and could gain a fourth member engine-side. The neutral "Sent"
 * makes no claim about timing at all, which is the only safe thing to say
 * when the record does not tell us.
 */
function steeringMarkText(
  disposition: OperatorInterruptDispositionDto | undefined,
): string {
  switch (disposition) {
    case "steered":
      return "Steered \u00b7 read at the agent's next step";
    case "queued_interrupt":
      return "Queued \u00b7 read the next time the agent runs";
    case "preempted_wake":
      return "Sent \u00b7 the agent is resuming now to read it";
    default:
      return "Sent to the agent";
  }
}

function NoticeBody({
  tone,
  children,
}: {
  readonly tone: "runtime" | "error" | "ack";
  readonly children: ReactNode;
}): JSX.Element {
  if (tone === "error") {
    return (
      <div role="alert" data-vex-turn-error="" className="vex-notice-error">
        <Swatch state="error" size={10} className="mt-[5px]" />
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span className="vex-notice-error__word">Error</span>
          <span className="vex-notice-error__text">{children}</span>
        </span>
      </div>
    );
  }
  return (
    <div
      {...(tone === "ack"
        ? { role: "status" as const, "aria-live": "polite" as const }
        : {})}
      data-vex-notice-tone={tone}
      className="vex-notice"
    >
      {children}
    </div>
  );
}
