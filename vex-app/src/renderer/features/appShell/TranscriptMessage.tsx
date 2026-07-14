/**
 * One transcript row — presentational only (S3 ledger-document anatomy,
 * S5 act ledger).
 *
 * Switches on the pure `TranscriptEntry.variant`. The transcript reads as
 * an asymmetric register: USER turns are compact right-aligned cards with a
 * persistent "You · HH:MM" caption; ASSISTANT turns are full-width document
 * flow hung off the Signal Tape spine by a quiet node in a 28px gutter (no
 * bubble, no avatar — the shell is photo-free; accent is rationed to the
 * live/pending node, so a settled node rests in --vex-text-3). Assistant prose
 * renders through
 * `MarkdownContent` (stage 8-2a) — safe React elements, never an HTML
 * string; user/tool/notice rows + the `compaction`/`recall` markers (stage
 * 8-4) render as plain React text nodes. Either way model/tool output cannot
 * inject markup.
 */

import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { StopCircleIcon } from "@hugeicons/core-free-icons";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import { cn } from "../../lib/utils.js";
import { CompactionMarker } from "./CompactionMarker.js";
import { MemoryMarker } from "./MemoryMarker.js";
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
function TapeClock({ createdAt }: { readonly createdAt: string }): JSX.Element | null {
  const clock = formatClock(createdAt);
  return clock === null ? null : (
    <span className="text-[var(--vex-text-2)]">{clock}</span>
  );
}

/**
 * Vex's identity mark on the Signal Tape spine (the monotonic time axis the
 * transcript hangs off, drawn once in SessionTranscript). The avatar sits where
 * the settled node used to — an 18px disc centered on the spine x (left-0 → the
 * 9px gutter centre) with a canvas-colored ring so the spine reads as passing
 * cleanly behind it. Each Vex turn is thus signed by its face. Decorative: the
 * "Vex" caption carries the name, so the image is aria-hidden. CSP-safe — a
 * same-origin /vex.jpg under the existing `img-src 'self'` directive.
 */
function AssistantAvatar(): JSX.Element {
  return (
    <img
      src="/vex.jpg"
      alt=""
      aria-hidden
      draggable={false}
      className="absolute left-0 top-[2px] h-[18px] w-[18px] rounded-full object-cover ring-2 ring-[var(--vex-surface-0)]"
    />
  );
}

/**
 * Tape stamp above an assistant document block. The time LEADS (the readout)
 * and the speaker label trails (chrome) — the left-aligned HH:MM forms a clock
 * column down the assistant rail of the tape.
 */
function AssistantCaption({
  createdAt,
}: {
  readonly createdAt: string;
}): JSX.Element {
  return (
    <span className="mb-1 flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.14em] tabular-nums">
      <TapeClock createdAt={createdAt} />
      <span className="text-[var(--vex-text-3)]">Vex</span>
    </span>
  );
}

/** Document-typography wrapper around the safe markdown renderer. */
function AssistantBody({ content }: { readonly content: string }): JSX.Element {
  return (
    <div className="break-words text-[15px] leading-[1.7] text-foreground">
      <MarkdownContent text={content} />
    </div>
  );
}

export function TranscriptMessage({
  row,
  pendingApprovals,
}: {
  readonly row: TranscriptEntry;
  /**
   * toolCallId → PENDING approval id for the active session (S5). Acts whose
   * call id matches get the "Awaiting signature" stamp-link to their card.
   */
  readonly pendingApprovals?: ReadonlyMap<string, string>;
}): JSX.Element {
  switch (row.variant) {
    case "user":
      return (
        <div data-vex-message-role="user" className="flex flex-col items-end">
          <div className="max-w-[70%] whitespace-pre-wrap break-words rounded-xl border border-[var(--vex-line-strong)] bg-white/[0.04] px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
            {row.content}
          </div>
          <span className="mt-1 flex items-baseline justify-end gap-2 font-mono text-[10px] uppercase tabular-nums">
            <span className="text-[var(--vex-text-3)]">You</span>
            <TapeClock createdAt={row.createdAt} />
          </span>
        </div>
      );
    case "assistant":
      return (
        <div data-vex-message-role="assistant" className="relative pl-7">
          <AssistantAvatar />
          <AssistantCaption createdAt={row.createdAt} />
          <AssistantBody content={row.content} />
        </div>
      );
    case "assistant_stopped":
      return (
        <div
          data-vex-message-role="assistant"
          data-vex-stopped=""
          className="relative pl-7"
        >
          <AssistantAvatar />
          <AssistantCaption createdAt={row.createdAt} />
          <AssistantBody content={row.content} />
          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--vex-text-3)]">
            <HugeiconsIcon icon={StopCircleIcon} size={12} aria-hidden />
            <span>Stopped</span>
          </div>
        </div>
      );
    case "tool":
      // S5 — THE ACT LEDGER. Orphan results (no call paired in their run)
      // keep the standalone disclosure; call rows register one ToolActRow per
      // executed call. The assistant prose keeps the S3 document anatomy.
      if (row.toolKind === "result") {
        // Acts hang in the same 28px gutter as the assistant rows so their box
        // sits right of the tape spine instead of overlapping it.
        return (
          <div data-vex-message-role="tool" className="flex flex-col gap-1 pl-7">
            <ToolDisclosure
              label={row.label ?? "tool_output"}
              body={row.content}
              emptyHint="(no output)"
            />
            {/* Orphan result (call scrolled out of the page): its validated
                explorer refs still surface here — grouped/paired acts get theirs
                via ToolActRow instead. Inert when nothing resolves. */}
            <ExplorerRefLinks refs={row.explorerRefs} />
          </div>
        );
      }
      return (
        <div data-vex-message-role="tool" className="flex flex-col gap-1.5">
          {/* Assistant prose accompanying the tool call (often empty). */}
          {row.content.length > 0 ? (
            <div className="relative pl-7">
              <AssistantAvatar />
              <AssistantCaption createdAt={row.createdAt} />
              <AssistantBody content={row.content} />
            </div>
          ) : null}
          {/* One registered act per executed call — collapsed by default. Each
              hangs in the 28px gutter so it aligns right of the tape spine. */}
          {resolveActs(row).map((act) => (
            <div key={act.toolCallId} className="pl-7">
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
      // Wrap in the 28px gutter so the collapsed "{N} tool calls" box clears the
      // tape spine (left-[9px]) instead of colliding with it.
      return (
        <div className="pl-7">
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
    toolDisplayBlock: null,
  }));
}

/**
 * Runtime/error notice — the marker mono grammar without hairlines. Error
 * notices carry the destructive tone with the one sanctioned fill (danger/10).
 */
function NoticeBody({
  tone,
  children,
}: {
  readonly tone: "runtime" | "error";
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "max-w-[80%] whitespace-pre-wrap break-words rounded-[6px] px-3 py-2 text-center font-mono text-[10px] uppercase tracking-[0.28em]",
        tone === "error"
          ? "border border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] bg-destructive/10 text-destructive"
          : "bg-white/[0.03] text-[var(--vex-text-3)]",
      )}
    >
      {children}
    </div>
  );
}
