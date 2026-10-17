/**
 * One transcript row - presentational only (S5 act ledger), drawn as the R3
 * conversation (docs/design/R3-MINIMAL.md section 6).
 *
 * Switches on the pure `TranscriptEntry.variant`. USER rows are a right
 * anchored block on a 2px blue rule under a "You · 12:28" caption, never a
 * bubble; VEX's turn hangs off the flat vx token in a 28px column with a 12
 * gap, once per turn (`turnMark`), with her clock and message keys in a tail
 * row BELOW the body. Tool calls read as step rows; several finished steps
 * fold into one quiet row. Assistant prose renders through `MarkdownContent`
 * (stage 8-2a) - safe React elements, never an HTML string; user/tool/notice
 * rows + the `compaction`/`recall` markers (stage 8-4) render as plain React
 * text nodes. Either way model/tool output cannot inject markup.
 */

import { memo, type JSX, type ReactNode } from "react";
import { Swatch } from "../../components/ui/swatch.js";
import { VxToken } from "../../components/ui/vx-token.js";
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
import {
  MissionStopResult,
  readMissionStopResult,
} from "./ToolLedger/MissionStopResult.js";
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
 * Vex's flat vx token at the head of her turn (docs/design/R3-MINIMAL.md
 * section 6): the 24px disc in the 28px column, drawn ONCE per turn - only on
 * the row that heads the turn (`turnMark`). Every member of the turn (prose,
 * steps, the live row, the stats) sits on the same 40px edge (`.vex-reply`).
 *
 * The state of a turn in flight is the live row's word and timer, never a
 * mark under the token; `data-vex-agent-avatar-state` still says which mark
 * belongs to the working turn.
 *
 * Decorative: the row's sr-only speaker label names the turn, so the token
 * stays aria-hidden (VxToken without a label).
 */
type MarkAt = "prose" | "reasoned" | "step" | "fold";

/** A row that opens on its Reasoned row centres the token on that row. */
function proseMarkAt(reasoning: string | null | undefined): MarkAt {
  return (reasoning ?? "").length > 0 ? "reasoned" : "prose";
}

function AssistantMark({
  working = false,
  at = "prose",
}: {
  readonly working?: boolean;
  /**
   * What heads the row, so the token centres on its first line: prose, the
   * 36px Reasoned row, a 36px step row or a 30px fold.
   */
  readonly at?: MarkAt;
}): JSX.Element {
  return (
    <span
      data-vex-agent-avatar=""
      data-vex-agent-avatar-state={working ? "working" : "settled"}
      data-vex-mark-at={at === "prose" ? undefined : at}
      className="vex-reply__mark"
    >
      <VxToken size={24} />
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
 * TYPOGRAPHY LAW (docs/design/R3-MINIMAL.md sections 1.3 and 6): message BODY
 * copy is the sans reading register, Instrument Sans 15 / 1.6 with 10 between
 * paragraphs. The serif is a display face and never sets a paragraph. The face
 * is declared on `.vex-chat-prose` (landing-motifs.css) and the turn's metric
 * on `.vex-reply .vex-chat-prose` (chat-transcript.css); this wrapper only owns
 * the tone and wrapping.
 */
function AssistantBody({ content }: { readonly content: string }): JSX.Element {
  return (
    <div className="break-words text-ink-primary">
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
   * This row heads Vex's turn, so it carries her token (`turnMarks.ts`). A row
   * rendered on its own heads its own turn, hence the default.
   */
  readonly turnMark?: boolean;
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
          {/* THE USER BLOCK (docs/design/R3-MINIMAL.md section 6): right
              anchored, the words left aligned on the 2px blue rule, the
              "You · 12:28" caption above them with the hover-revealed message
              keys. Plain text, never markdown. */}
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
            <span>
              You
              <TapeClock
                createdAt={row.createdAt}
                className="before:mx-[0.3em] before:content-['·']"
              />
            </span>
          </span>
          <p className="vex-you__body">{written}</p>
          {/* A33 - an operator instruction says WHEN it reaches the model, in
              words. The words come from the engine's own typed disposition
              (M6), never from the row kind: the kind means only "this is an
              operator instruction", and three different things can have
              happened to one. Hardcoding the steered wording told a user whose
              message was queued against a parked run that it would be read at
              the agent's next step, contradicting the acknowledgement written
              beside it in the very same transaction. */}
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
      );
    }
    case "assistant":
      return (
        <div
          data-vex-message-role="assistant"
          data-time-hover-root=""
          className="vex-reply"
        >
          {turnMark ? (
            <AssistantMark working={agentWorking} at={proseMarkAt(row.reasoning)} />
          ) : null}
          <AssistantSpeakerLabel />
          <ReasonedBlock reasoning={row.reasoning} />
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
        >
          {turnMark ? (
            <AssistantMark working={agentWorking} at={proseMarkAt(row.reasoning)} />
          ) : null}
          <AssistantSpeakerLabel />
          <ReasonedBlock reasoning={row.reasoning} />
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
          <div className="vex-reply__stopped">
            <Swatch state="idle" size={10} />
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
          <div data-vex-message-role="tool" className="vex-reply">
            {turnMark ? <AssistantMark at="step" /> : null}
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
        <div data-vex-message-role="tool" className="vex-reply">
          {turnMark ? (
            <AssistantMark
              working={agentWorking}
              at={toolRowMarkAt(row)}
            />
          ) : null}
          {/* Assistant prose accompanying the tool call (often empty). */}
          {row.content.length > 0 ? (
            <div data-time-hover-root="">
              <AssistantSpeakerLabel />
              <ReasonedBlock reasoning={row.reasoning} />
              <AssistantBody content={row.content} />
              <AssistantActionsTail createdAt={row.createdAt} />
            </div>
          ) : null}
          {/* A prose-less tool row carries the turn's reasoning itself - the
              split rows share `dto.id`, and `splitToolCallProse` guarantees
              only ONE of them ever holds it, so this can never double-render. */}
          {row.content.length === 0 ? (
            <ReasonedBlock reasoning={row.reasoning} />
          ) : null}
          <ToolSteps row={row} pendingApprovals={pendingApprovals} />
        </div>
      );
    case "tool_group":
      // A run of calls folded into one quiet row, hung on the turn's edge.
      // EVERY folded trace (the prose-less call rows' reasoning, which the
      // aggregation would otherwise swallow) gets its OWN collapsible block,
      // stacked in turn order above the fold, so a group never silently drops
      // the later halves of the turn's thinking. Index keys are correct here:
      // the list is a fixed, ordered projection of the group model, never
      // reordered or spliced.
      return (
        <div className="vex-reply">
          {turnMark ? (
            <AssistantMark
              at={(row.reasonings ?? []).length === 0 ? "fold" : "reasoned"}
            />
          ) : null}
          {(row.reasonings ?? []).map((trace, index) => (
            <ReasonedBlock key={`${row.id}-${index}`} reasoning={trace} />
          ))}
          <ToolGroupRow group={row} pendingApprovals={pendingApprovals} />
          {/* A group folds its acts; a mission result must not fold with them. */}
          {(row.calls ?? []).map((call) => {
            const stopResult = readMissionStopResult(call);
            return stopResult !== null ? (
              <MissionStopResult key={call.toolCallId} result={stopResult} />
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
}: {
  readonly row: TranscriptRowModel;
  readonly pendingApprovals?: ReadonlyMap<string, string>;
}): JSX.Element | null {
  const acts = resolveActs(row);
  if (acts.length === 0) return null;
  const stopResults = acts.map((act) => ({
    key: act.toolCallId,
    result: readMissionStopResult(act),
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
      {stopResults.map(({ key, result }) =>
        result !== null ? <MissionStopResult key={key} result={result} /> : null,
      )}
    </>
  );
}

/**
 * What heads a call row: its prose or its Reasoned row (both centre like
 * prose), else its steps - one step row, or the fold of several.
 */
function toolRowMarkAt(row: TranscriptRowModel): MarkAt {
  if ((row.reasoning ?? "").length > 0) return "reasoned";
  if (row.content.length > 0) return "prose";
  return resolveActs(row).length > 1 ? "fold" : "step";
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
