/**
 * One transcript row — presentational only (S3 ledger-document anatomy,
 * S5 act ledger).
 *
 * Switches on the pure `TranscriptEntry.variant`. The transcript reads as
 * an asymmetric register: USER turns are compact right-aligned cards with a
 * persistent "You · HH:MM" caption; ASSISTANT turns are full-width document
 * flow hung off the Signal Tape spine by the Vex mark in a 36px gutter (no
 * bubble), with their clock and actions in a tail row BELOW the body. While
 * the current turn is active, a restrained accent ring rotates around that
 * mark; settled turns remain still. Assistant prose renders through
 * `MarkdownContent` (stage 8-2a) — safe React elements, never an HTML
 * string; user/tool/notice rows + the `compaction`/`recall` markers (stage
 * 8-4) render as plain React text nodes. Either way model/tool output cannot
 * inject markup.
 */

import { memo, type JSX, type ReactNode } from "react";
import { IconCircleStop } from "../../components/icons/index.js";
import { StateDot } from "../../components/ui/state-dot.js";
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
import { MemoryMarker } from "./MemoryMarker.js";
import { ReasonedBlock } from "./ReasonedBlock.js";
import { BoardBlock } from "./Board/BoardBlock.js";
import { ToolActRow } from "./ToolLedger/ToolActRow.js";
import { ExplorerRefLinks } from "./ToolLedger/ExplorerRefLinks.js";
import { ToolGroupRow } from "./ToolLedger/ToolGroupRow.js";
import { ToolDisclosure } from "./ToolDisclosure.js";
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
 * The tape's clock readout for one entry — HH:MM in --vex-text-2 (the data), or
 * nothing for an unparseable timestamp. Pairs with a speaker label to form a
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
    <span className={cn("text-[var(--vex-text-2)]", className)}>{clock}</span>
  );
}

/**
 * Vex's identity mark on the Signal Tape spine (the monotonic time axis the
 * transcript hangs off). The mark sits at the gutter's left edge, centred in a
 * 26px square box, so every Vex turn is signed by the brand monogram rather
 * than by a character portrait (owner QA round 2, item 5).
 *
 * GUTTER: unchanged at `pl-9` (36px). `VexMark` is 824:658, so an 18px height
 * is ~23px wide - it fits the existing 26px box with room to spare, and the
 * whole `pl-9` family (assistant prose, tool acts, tool groups, the live
 * stream preview, the turn-stats line) therefore stays where it is. If that
 * box ever changes, EVERY member of the family moves with it.
 *
 * WORKING RING: still a circle, deliberately. The mark's box is square, but a
 * spinning rounded rectangle drags its corners through the sweep; a circle
 * circumscribing the box does not. `-inset-[3px]` on a 26px box gives a 32px
 * circle, and the mark's 23x18 diagonal is 29.2px, so the glyph clears the
 * ring at every phase. Reduced motion stills it to a static arc.
 *
 * The mark is decorative here - the row's sr-only speaker label names the
 * turn - so it stays aria-hidden (VexMark sets that itself).
 */
function AssistantAvatar({ working = false }: { readonly working?: boolean }): JSX.Element {
  return (
    <span
      data-vex-agent-avatar=""
      data-vex-agent-avatar-state={working ? "working" : "settled"}
      className="absolute left-0 top-[1px] inline-flex h-[26px] w-[26px] items-center justify-center text-brand-mark"
    >
      {working ? (
        <span
          data-vex-agent-spinner=""
          aria-hidden
          className="absolute -inset-[3px] rounded-full border border-[var(--vex-accent)] border-r-transparent animate-spin [animation-duration:1200ms] motion-reduce:animate-none"
        />
      ) : null}
      <VexMark size={18} />
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
      className="vex-micro mt-1 flex h-5 items-center gap-2 tabular-nums"
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
 * TYPOGRAPHY LAW (owner readability round 2026-07-30): message BODY copy is
 * the sans reading register, Inter Tight. Instrument Serif is a condensed
 * display face; the previous serif body was the "chujowo się czyta" report,
 * and since 2026-08-21 (owner 6/6a) the serif is out of shell chrome
 * altogether - it survives on the pre-shell display headings and the
 * long-form article variant only. The face and metrics are declared once on
 * `.vex-chat-prose`
 * (landing-motifs.css) and reach the body through `MarkdownContent`; this
 * wrapper only owns the tone and wrapping, so the two can never drift apart.
 */
function AssistantBody({ content }: { readonly content: string }): JSX.Element {
  return (
    <div className="break-words text-foreground">
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
    case "user":
      return (
        <div
          data-vex-message-role="user"
          data-time-hover-root=""
          className="flex flex-col items-end"
        >
          {/* Operator prose shares the READING register with the assistant
              body (owner readability round 2026-07-30): the sans face, Inter
              Tight. This row renders as plain text, not markdown, so it
              carries its own metric instead of inheriting
              `.vex-chat-prose` - keep the two in sync. */}
          {/* r22 = the composer card's radius (the two "user surfaces" share
              one shape); 525px cap inside the column, percentage keeps narrow
              windows sane. 44px single-line bubble: 24 line + 10 padding each
              side. */}
          <div className="max-w-[min(525px,82%)] whitespace-pre-wrap break-words rounded-[22px] bg-surface-bubble px-4 py-2.5 text-[16px] leading-6 text-ink-primary">
            {row.content}
          </div>
          {/* A33 - a steered message says WHEN it reaches the model, in
              words: delivery happens at the live loop's next tool-step
              boundary, never mid tool call. */}
          {row.steering === true ? (
            <span
              data-vex-steering-mark=""
              className="vex-micro-label mt-1 text-ink-secondary"
            >
              Steered · read at the agent's next step
            </span>
          ) : null}
          {/* Same C2 human-caption register as the assistant stamp. */}
          <span className="vex-micro mt-1 flex items-center justify-end gap-2 tabular-nums">
            {feedbackContext !== undefined ? (
              <FeedbackMessageAction context={feedbackContext} />
            ) : null}
            {onEditInNewBranch !== undefined ? (
              <BranchMessageAction
                label="Edit in a new branch"
                onBranch={() => onEditInNewBranch(row.id, row.content)}
              />
            ) : null}
            {onEditMessage !== undefined ? (
              <EditMessageAction
                onEdit={() => onEditMessage(row.id, row.content)}
              />
            ) : null}
            <CopyMessageAction text={row.content} />
            <span className="text-[var(--vex-text-3)]">You</span>
            <TapeClock createdAt={row.createdAt} className="vex-time-reveal" />
          </span>
        </div>
      );
    case "assistant":
      return (
        <div
          data-vex-message-role="assistant"
          data-time-hover-root=""
          className="relative pl-9"
        >
          <AssistantAvatar working={agentWorking} />
          <AssistantSpeakerLabel />
          <ReasonedBlock reasoning={row.reasoning} />
          <AssistantBody content={row.content} />
          {row.board != null ? <BoardBlock spec={row.board} /> : null}
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
          className="relative pl-9"
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
          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--vex-text-3)]">
            <IconCircleStop size={12} />
            <span>Stopped</span>
          </div>
        </div>
      );
    case "tool":
      // S5 — THE ACT LEDGER. Orphan results (no call paired in their run)
      // keep the standalone disclosure; call rows register one ToolActRow per
      // executed call. The assistant prose keeps the S3 document anatomy.
      if (row.toolKind === "result") {
        // Acts hang in the same 36px gutter as the assistant rows so their box
        // sits right of the tape spine instead of overlapping it.
        return (
          <div data-vex-message-role="tool" className="flex flex-col gap-1 pl-9">
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
        <div data-vex-message-role="tool" className="flex flex-col gap-1.5">
          {/* Assistant prose accompanying the tool call (often empty). */}
          {row.content.length > 0 ? (
            <div className="relative pl-9">
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
            <div className="pl-9">
              <ReasonedBlock reasoning={row.reasoning} />
            </div>
          ) : null}
          {/* One registered act per executed call — collapsed by default. Each
              hangs in the 36px gutter so it aligns right of the tape spine. */}
          {resolveActs(row).map((act) => (
            <div key={act.toolCallId} className="pl-9">
              <ToolActRow
                act={act}
                pendingApprovalId={
                  pendingApprovals?.get(act.toolCallId) ?? null
                }
              />
            </div>
          ))}
        </div>
      );
    case "tool_group":
      // Wrap in the 36px gutter so the collapsed "{N} tool calls" box clears the
      // tape spine (left-[9px]) instead of colliding with it. EVERY folded
      // trace (the prose-less call rows' reasoning, which the aggregation would
      // otherwise swallow) gets its OWN collapsible block — the same one used
      // everywhere else — stacked in turn order above the ledger line, so a
      // group never silently drops the later halves of the turn's thinking.
      // Index keys are correct here: the list is a fixed, ordered projection of
      // the group model, never reordered or spliced.
      return (
        <div className="pl-9">
          {(row.reasonings ?? []).map((trace, index) => (
            <ReasonedBlock key={`${row.id}-${index}`} reasoning={trace} />
          ))}
          <ToolGroupRow group={row} pendingApprovals={pendingApprovals} />
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
 * error dot / bold "Error" title / the persisted sanitized message at 13/20.
 * The session-level banner remains the session-scope surface.
 */
function NoticeBody({
  tone,
  children,
}: {
  readonly tone: "runtime" | "error";
  readonly children: ReactNode;
}): JSX.Element {
  if (tone === "error") {
    return (
      <div
        role="alert"
        data-vex-turn-error=""
        className="grid w-full grid-cols-[10px_minmax(0,1fr)] items-start gap-2 py-0.5 text-[13px] leading-5"
      >
        <StateDot state="error" size={8} className="mt-1.5" />
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span className="mr-1.5 font-semibold text-destructive">Error</span>
          <span className="text-ink-secondary">{children}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-[6px] bg-interactive-hover px-3 py-2 text-center font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--vex-text-3)]">
      {children}
    </div>
  );
}
