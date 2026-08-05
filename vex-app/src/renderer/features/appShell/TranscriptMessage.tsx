/**
 * One transcript row — presentational only (S3 ledger-document anatomy,
 * S5 act ledger).
 *
 * Switches on the pure `TranscriptEntry.variant`. The transcript reads as
 * an asymmetric register: USER turns are compact right-aligned cards with a
 * persistent "You · HH:MM" caption; ASSISTANT turns are full-width document
 * flow hung off the Signal Tape spine by its 26px avatar in a 36px gutter (no
 * bubble). While the current turn is active, a restrained accent ring rotates
 * around that avatar; settled turns remain still. Assistant prose renders through
 * `MarkdownContent` (stage 8-2a) — safe React elements, never an HTML
 * string; user/tool/notice rows + the `compaction`/`recall` markers (stage
 * 8-4) render as plain React text nodes. Either way model/tool output cannot
 * inject markup.
 */

import { memo, type JSX, type ReactNode } from "react";
import { StopCircleIcon, VexIcon } from "../../components/icons/index.js";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import { cn } from "../../lib/utils.js";
import { CompactionMarker } from "./CompactionMarker.js";
import { MemoryMarker } from "./MemoryMarker.js";
import { ReasonedBlock } from "./ReasonedBlock.js";
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
 * transcript hangs off). The avatar sits where the settled node used to — a
 * disc at the gutter's left edge with a canvas-colored ring so the spine reads
 * as passing cleanly behind it. Each Vex turn is thus signed by its face.
 *
 * Sized up 18px → 26px (owner visual round 2026-07-30: "powiększyć pfp Vex").
 * The gutter widened with it, `pl-7` → `pl-9` (28px → 36px), so the face keeps
 * a 10px channel to the text instead of crowding it. EVERY row that hangs in
 * this gutter moves together — assistant prose, tool acts, tool groups, the
 * live stream preview — or the column loses its left edge.
 *
 * Decorative: the "VEX" caption carries the name, so the image is aria-hidden.
 * CSP-safe — a same-origin /vex.jpg under the existing `img-src 'self'`.
 */
function AssistantAvatar({ working = false }: { readonly working?: boolean }): JSX.Element {
  return (
    <span
      data-vex-agent-avatar=""
      data-vex-agent-avatar-state={working ? "working" : "settled"}
      className="absolute left-0 top-[1px] h-[26px] w-[26px]"
    >
      {working ? (
        <span
          data-vex-agent-spinner=""
          aria-hidden
          className="absolute -inset-[3px] rounded-full border border-[var(--vex-accent)] border-r-transparent animate-spin [animation-duration:1200ms] motion-reduce:animate-none"
        />
      ) : null}
      <img
        src="/vex.jpg"
        alt=""
        aria-hidden
        draggable={false}
        className="h-[26px] w-[26px] rounded-full object-cover ring-2 ring-[var(--vex-surface-0)]"
      />
    </span>
  );
}

/** The speaker name, as Vex signs it. */
const VEX_SPEAKER = "VEX";

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
    // Register C2: a speaker caption is HUMAN chrome, so it wears the support
    // small-caps stamp (`.vex-micro`, sans) — mono is reserved for genuinely
    // technical strings (code, raw JSON, addresses, tx hashes).
    //
    // THE NAME SHIMMERS (owner visual round 2026-07-30: "na napis VEX dodać
    // taki shimmer jak przy wyborze poziomu reasoningu"). It is the exact
    // sanctioned class the reasoning-effort selector uses for its value —
    // `.vex-preview-shimmer` + `data-shimmer-text` (chronos-motion.css): the
    // base text stays SOLID and an ::after duplicate sweeps a narrow cobalt
    // band across the glyphs. The same mark rides the Turn Island's live
    // status word, so one gesture means one thing everywhere — Vex is here.
    // The class family stills itself under `prefers-reduced-motion`, leaving
    // the solid wordmark; `data-shimmer-text` must equal the rendered string.
    <span className="vex-micro mb-1 flex items-baseline gap-2 tabular-nums">
      <TapeClock createdAt={createdAt} />
      <span
        className="vex-preview-shimmer text-[var(--vex-text-3)]"
        data-shimmer-text={VEX_SPEAKER}
      >
        {VEX_SPEAKER}
      </span>
    </span>
  );
}

/**
 * Document-typography wrapper around the safe markdown renderer.
 *
 * TYPOGRAPHY LAW (owner readability round 2026-07-30): message BODY copy is
 * Instrument Sans 15px/1.65. Instrument Serif is a condensed display face and
 * is now confined to headings, display figures and the reasoning aside — the
 * previous serif body was the "chujowo się czyta" report. The metrics are
 * declared once on `.vex-chat-prose` (landing-motifs.css) and reach the body
 * through `MarkdownContent`; this wrapper only owns the tone and wrapping, so
 * the two can never drift apart.
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
}: {
  readonly row: TranscriptEntry;
  /**
   * toolCallId → PENDING approval id for the active session (S5). Acts whose
   * call id matches get the "Awaiting signature" stamp-link to their card.
   */
  readonly pendingApprovals?: ReadonlyMap<string, string>;
  /** True only for the newest assistant avatar in the currently active turn. */
  readonly agentWorking?: boolean;
}): JSX.Element {
  switch (row.variant) {
    case "user":
      return (
        <div data-vex-message-role="user" className="flex flex-col items-end">
          {/* Operator prose shares the READING register with the assistant
              body (owner readability round 2026-07-30): Instrument Sans
              15px/1.65. This row renders as plain text, not markdown, so it
              carries the metric itself instead of inheriting
              `.vex-chat-prose` — keep the two in sync. */}
          <div className="max-w-[70%] whitespace-pre-wrap break-words rounded-xl border border-[var(--vex-line-strong)] bg-white/[0.04] px-3.5 py-2.5 text-[15px] leading-[1.65] text-foreground">
            {row.content}
          </div>
          {/* Same C2 human-caption register as the assistant stamp. */}
          <span className="vex-micro mt-1 flex items-baseline justify-end gap-2 tabular-nums">
            <span className="text-[var(--vex-text-3)]">You</span>
            <TapeClock createdAt={row.createdAt} />
          </span>
        </div>
      );
    case "assistant":
      return (
        <div data-vex-message-role="assistant" className="relative pl-9">
          <AssistantAvatar working={agentWorking} />
          <AssistantCaption createdAt={row.createdAt} />
          <ReasonedBlock reasoning={row.reasoning} />
          <AssistantBody content={row.content} />
        </div>
      );
    case "assistant_stopped":
      return (
        <div
          data-vex-message-role="assistant"
          data-vex-stopped=""
          className="relative pl-9"
        >
          <AssistantAvatar working={agentWorking} />
          <AssistantCaption createdAt={row.createdAt} />
          <ReasonedBlock reasoning={row.reasoning} />
          <AssistantBody content={row.content} />
          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--vex-text-3)]">
            <VexIcon icon={StopCircleIcon} size={12} aria-hidden />
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
            <div className="relative pl-9">
              <AssistantAvatar working={agentWorking} />
              <AssistantCaption createdAt={row.createdAt} />
              <ReasonedBlock reasoning={row.reasoning} />
              <AssistantBody content={row.content} />
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
