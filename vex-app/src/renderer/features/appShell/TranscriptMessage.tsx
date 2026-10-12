/**
 * One transcript row — presentational only (S3 ledger-document anatomy,
 * S5 act ledger), drawn on the V10 page (docs/design/V10-SPREAD.md section 1,
 * reference d3).
 *
 * Switches on the pure `TranscriptEntry.variant`. The transcript reads as
 * an asymmetric register: USER turns are right-hung notes on a 2px blue rule
 * under a "You · HH:MM" caption, never a bubble; ASSISTANT turns are
 * full-width document flow hung off the vx mark in a 30px gutter, with their
 * clock and actions in a tail row BELOW the body. While the current turn is
 * active the ongoing swatch sits under that mark; settled turns are still. Assistant prose renders through
 * `MarkdownContent` (stage 8-2a) — safe React elements, never an HTML
 * string; user/tool/notice rows + the `compaction`/`recall` markers (stage
 * 8-4) render as plain React text nodes. Either way model/tool output cannot
 * inject markup.
 */

import { memo, type JSX, type ReactNode } from "react";
import { Swatch } from "../../components/ui/swatch.js";
import { VexMark } from "../../components/common/VexMark.js";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import { cn } from "../../lib/utils.js";
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
 * The tape's clock readout for one entry - HH:MM in the second ink (the data),
 * or nothing for an unparseable timestamp. Pairs with a speaker label to form a
 * tape stamp: the time leads on the assistant rail and trails on the user rail.
 */
function TapeClock({
  createdAt,
  className,
}: {
  readonly createdAt: string;
  readonly className?: string;
}): JSX.Element | null {
  const clock = formatClock(createdAt);
  return clock === null ? null : (
    <span className={cn("text-ink-secondary", className)}>{clock}</span>
  );
}

/**
 * Vex's identity mark at the head of the 30px gutter the assistant turn hangs
 * off (reference d3): the vx monogram, 18px wide, in the brand-mark ink (the
 * blue by day, paper at night), so every Vex turn is signed by the mark rather
 * than by a character portrait (owner QA round 2, item 5).
 *
 * GUTTER: `pl-[30px]`, shared by the whole family (assistant prose, tool acts,
 * tool groups, the live stream preview, the turn-stats line). If the gutter
 * ever changes, EVERY member of the family moves with it.
 *
 * WORKING: the ongoing swatch under the mark, the page's one state motion
 * (its dot screen steps; reduced motion stills it). No spinning ring: V10
 * draws no arcs. The `data-vex-agent-spinner` seam keeps its name.
 *
 * The mark is decorative here - the row's sr-only speaker label names the
 * turn - so it stays aria-hidden (VexMark sets that itself).
 */
function AssistantAvatar({ working = false }: { readonly working?: boolean }): JSX.Element {
  return (
    <span
      data-vex-agent-avatar=""
      data-vex-agent-avatar-state={working ? "working" : "settled"}
      className="absolute left-0 top-[5px] flex w-[18px] flex-col items-center gap-2 text-brand-mark"
    >
      <VexMark size={14} />
      {working ? (
        <span
          data-vex-agent-spinner=""
          aria-hidden
          className="inline-flex text-accent-primary"
        >
          <Swatch state="ongoing" size={9} />
        </span>
      ) : null}
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
    // Register C2: message chrome is HUMAN, so it wears the support small-caps
    // stamp (`.vex-micro`, sans) - mono is reserved for genuinely technical
    // strings (code, raw JSON, addresses, tx hashes).
    <span
      data-vex-message-tail=""
      className="vex-micro mt-1 flex h-5 items-center gap-2 tabular-nums text-ink-secondary [--vex-micro-size:11px]"
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
 * TYPOGRAPHY LAW (owner readability round 2026-07-30, V10 section 1): message
 * BODY copy is the sans reading register, Instrument Sans 15.5px. The serif is
 * a display face and never sets a paragraph. The face and metrics are
 * declared once on `.vex-chat-prose` (landing-motifs.css) and reach the body
 * through `MarkdownContent`; this wrapper only owns the tone and wrapping, so
 * the two can never drift apart.
 */
function AssistantBody({ content }: { readonly content: string }): JSX.Element {
  return (
    <div className="break-words text-ink-primary">
      <MarkdownContent text={content} />
    </div>
  );
}

/**
 * MEMOIZED (owner decree 2026-08-03 — streaming speed). The transcript re-maps
 * every row on each preview tick, and without this boundary each of those rows
 * re-rendered and re-lexed its markdown at provider token rate. All three
 * props are referentially stable across a preview tick — `row` comes from the
 * `rows` memo, `pendingApprovals` from its own memo, `agentWorking` is a
 * boolean — so the default shallow comparison actually holds.
 */
export const TranscriptMessage = memo(function TranscriptMessage({
  row,
  pendingApprovals,
  agentWorking = false,
  boardArrival = "settled",
  feedbackSessionId,
  feedbackMessageKey,
  onEditMessage,
  onEditInNewBranch,
  onBranchFrom,
}: {
  readonly row: TranscriptEntry;
  /**
   * toolCallId → PENDING approval id for the active session (S5). Acts whose
   * call id matches get the "Awaiting signature" stamp-link to their card.
   */
  readonly pendingApprovals?: ReadonlyMap<string, string>;
  /** True only for the newest assistant avatar in the currently active turn. */
  readonly agentWorking?: boolean;
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
   * Fork/edit callbacks (A14/A18) — row-agnostic STABLE references (the
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
          className="flex flex-col items-end"
        >
          {/* THE NOTE (reference d3): right-hung, on the 2px blue rule, its
              "You · HH:MM" caption above the words. The caption carries the
              hover-revealed actions and clock; the words are the operator's
              prose in the reading register - this row renders as plain text,
              not markdown, so it carries its own metric. */}
          <div className="vex-note flex max-w-[82%] flex-col items-stretch">
            {/* Same C2 human-caption register as the assistant stamp. */}
            <span className="vex-micro mb-1.5 flex items-center justify-end gap-2 tabular-nums text-ink-secondary [--vex-micro-size:11px]">
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
              <span className="text-ink-secondary">You</span>
              <TapeClock
                createdAt={row.createdAt}
                className="vex-time-reveal before:mr-2 before:content-['·']"
              />
            </span>
            <p className="whitespace-pre-wrap break-words text-left font-sans text-[16px] leading-[26px] text-ink-primary">
              {written}
            </p>
          </div>
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
              className="vex-micro-label mt-1.5 text-ink-secondary"
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
          className="relative pl-[30px]"
        >
          <AssistantAvatar working={agentWorking} />
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
          className="relative pl-[30px]"
        >
          <AssistantAvatar working={agentWorking} />
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
          <div className="mt-1.5 flex items-center gap-[7px] font-mono text-[11px] uppercase leading-none tracking-status text-ink-secondary">
            <Swatch state="idle" size={9} />
            <span>Stopped</span>
          </div>
        </div>
      );
    case "tool":
      // S5 — THE ACT LEDGER. Orphan results (no call paired in their run)
      // keep the standalone disclosure; call rows register one ToolActRow per
      // executed call. The assistant prose keeps the S3 document anatomy.
      if (row.toolKind === "result") {
        // Acts hang in the same 30px gutter as the assistant rows.
        return (
          <div data-vex-message-role="tool" className="flex flex-col gap-1 pl-[30px]">
            <ToolDisclosure
              label={row.label ?? "tool_output"}
              body={row.content}
              emptyHint="(no output)"
            />
            {/* Orphan result (call scrolled out of the page): its validated
                explorer refs still surface here - grouped/paired acts get theirs
                via ToolActRow instead. Inert when nothing resolves. */}
            <ExplorerRefLinks refs={row.explorerRefs} />
          </div>
        );
      }
      return (
        <div data-vex-message-role="tool" className="flex flex-col">
          {/* Assistant prose accompanying the tool call (often empty). */}
          {row.content.length > 0 ? (
            <div className="relative pl-[30px]">
              <AssistantAvatar working={agentWorking} />
              <AssistantSpeakerLabel />
              <ReasonedBlock reasoning={row.reasoning} />
              <AssistantBody content={row.content} />
              <AssistantActionsTail createdAt={row.createdAt} />
            </div>
          ) : null}
          {/* A prose-less tool row carries the turn's reasoning itself — the
              split rows share `dto.id`, and `splitToolCallProse` guarantees
              only ONE of them ever holds it, so this can never double-render. */}
          {row.content.length === 0 ? (
            <div className="pl-[30px]">
              <ReasonedBlock reasoning={row.reasoning} />
            </div>
          ) : null}
          {/* THE LEDGER (reference d3): one ruled list of the registered acts,
              hung in the 30px gutter under the prose - one 32px line per
              executed call, collapsed by default. */}
          <div className="pl-[30px]">
            <div data-vex-tool-ledger="" className="vex-ledger">
              {resolveActs(row).map((act) => {
                const stopResult = readMissionStopResult(act);
                return (
                  <div key={act.toolCallId}>
                    <ToolActRow
                      act={act}
                      pendingApprovalId={
                        pendingApprovals?.get(act.toolCallId) ?? null
                      }
                    />
                    {/* An accepted MissionStop's result stays visible, not
                        folded behind the collapsed act. */}
                    {stopResult !== null ? <MissionStopResult result={stopResult} /> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      );
    case "tool_group":
      // Wrap in the 30px gutter so the collapsed "{N} tool calls" line hangs
      // under the mark with the rest of the turn. EVERY folded
      // trace (the prose-less call rows' reasoning, which the aggregation would
      // otherwise swallow) gets its OWN collapsible block — the same one used
      // everywhere else — stacked in turn order above the ledger line, so a
      // group never silently drops the later halves of the turn's thinking.
      // Index keys are correct here: the list is a fixed, ordered projection of
      // the group model, never reordered or spliced.
      return (
        <div className="pl-[30px]">
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
 * Runtime/error notice. A runtime notice keeps the quiet mono stamp. An error
 * notice wears the turn-error ROW grammar (A20 — in the flow, not a box):
 * the ink cross / the mono "Error" caps / the persisted sanitized message at
 * 13/20, never red.
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
      <div
        role="alert"
        data-vex-turn-error=""
        className="grid w-full grid-cols-[10px_minmax(0,1fr)] items-start gap-2 py-0.5 text-[13px] leading-5"
      >
        <Swatch state="error" size={9} className="mt-[5px]" />
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span className="mr-2 font-mono text-[11px] uppercase tracking-status text-ink-primary">Error</span>
          <span className="text-ink-secondary">{children}</span>
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
      className="max-w-[80%] whitespace-pre-wrap break-words px-3 py-1 text-center font-mono text-[11px] uppercase leading-[18px] tracking-status text-ink-secondary"
    >
      {children}
    </div>
  );
}
