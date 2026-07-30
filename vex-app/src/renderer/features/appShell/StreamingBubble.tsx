/**
 * THE WORKING STRIP — live state of the in-flight assistant turn (S4).
 *
 * Renders the `streamStore` preview in the same gutter grammar as a persisted
 * assistant row (relative pl-7): a DotMatrix working mark in the gutter, a
 * status word + elapsed counter header, the live reasoning tail, then the
 * streaming answer text. Honest ephemerality: reasoning is the instrument's
 * needle deflection — visible while it moves, NEVER a transcript row, never
 * persisted. When the canonical message DTO lands, `useStreamPreviewSync`
 * clears the whole preview and nothing looks missing.
 *
 * Accessibility: the strip is NOT a live region over the growing text (that
 * would spam screen readers token-by-token). A visually-hidden `role="status"`
 * announces the phase + working status, which change at most a few times per
 * turn; the DotMatrix marks are decorative (`aria-hidden`). The canonical
 * content is read from the persisted transcript row.
 */

import { memo, useEffect, useMemo, useState, type JSX } from "react";
import type { StreamPreview, StreamWorkingStatus } from "../../stores/streamStore.js";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import { DotmCircular8 } from "../../components/ui/dotm-circular-8.js";
import { DotmHex3 } from "../../components/ui/dotm-hex-3.js";
import { cn } from "../../lib/utils.js";
import { classifyEngineFailure } from "@shared/engine-error-classification.js";
import { engineErrorCopy } from "@shared/engine-error-copy.js";

/** m:ss from elapsed ms — clamped at 0 so clock skew never prints "-1:-7". */
function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Compact token count for the "Reasoned · 1.2K tokens" summary. */
function formatTokenCount(count: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}

/** Visible + sr-only status word (calling appends the tool name separately). */
const STATUS_WORD: Record<StreamWorkingStatus, string> = {
  working: "Working",
  thinking: "Thinking",
  calling: "Calling",
  writing: "Writing",
};

/**
 * Elapsed m:ss counter, isolated so the 1s tick re-renders only this span.
 * Recomputes from startedAtMs each tick — interval drift cannot accumulate.
 * Mounted only while phase === "streaming", so unmount is the cleanup edge.
 */
function ElapsedCounter({
  startedAtMs,
}: {
  readonly startedAtMs: number;
}): JSX.Element {
  const [label, setLabel] = useState(() =>
    formatElapsed(Date.now() - startedAtMs),
  );
  useEffect(() => {
    const tick = (): void => setLabel(formatElapsed(Date.now() - startedAtMs));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAtMs]);
  return (
    <span className="font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
      {label}
    </span>
  );
}

/**
 * The reasoning tail window. While thinking it shows the newest lines pinned
 * to the bottom of a masked 46px window (CSS justify-end — no JS scrolling);
 * once the answer streams it hard-swaps to the "Reasoned · N tokens" summary.
 * Either form is one <button> so the full trace stays reopenable while the
 * preview lives. Memoized: 80ms-batched reasoning flushes and answer-text
 * deltas re-render only this strip, never the rest of the bubble's subtree.
 */
const ReasoningStrip = memo(function ReasoningStrip({
  reasoningText,
  reasoningTokens,
  answering,
}: {
  readonly reasoningText: string;
  readonly reasoningTokens: number | null;
  readonly answering: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // Once the answer streams, the trace collapses to the summary line unless
  // the user explicitly reopens it.
  const showTrace = !answering || expanded;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label="Reasoning trace"
      onClick={() => setExpanded((open) => !open)}
      className="block w-full cursor-pointer text-left"
    >
      <span className="flex items-baseline justify-between gap-2">
        {answering ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
            {reasoningTokens !== null
              ? `Reasoned · ${formatTokenCount(reasoningTokens)} tokens`
              : "Reasoned"}
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--vex-accent-text)]">
            Reasoning
          </span>
        )}
        {showTrace ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
            Ephemeral — not retained
          </span>
        ) : null}
      </span>
      {showTrace ? (
        // Expanded trace flows at full height in the transcript — the old
        // max-h scrollbox drew its own scrollbar mid-conversation and boxed
        // the strip off from the tape (seamless-chat owner review). Only the
        // collapsed 46px working peek keeps its masked window.
        <div
          className={
            expanded
              ? "mt-1"
              : "vex-fade-top mt-1 flex max-h-[46px] flex-col justify-end overflow-hidden"
          }
        >
          <p className="whitespace-pre-wrap text-[13px] leading-[1.55] text-[var(--vex-text-2)]">
            {reasoningText}
          </p>
        </div>
      ) : null}
    </button>
  );
});

export function StreamingBubble({
  preview,
  awaitingApproval = false,
}: {
  readonly preview: StreamPreview;
  /**
   * S5 circuit-break: the active session has ≥1 pending approval. The
   * working mark freezes and the status word becomes "Awaiting signature" —
   * the machine visibly stops while it waits for the user's pen. Derived
   * upstream (SessionTranscript shares ApprovalsRegion's pending query);
   * the stream store stays decoupled from TanStack Query.
   */
  readonly awaitingApproval?: boolean;
}): JSX.Element {
  const streaming = preview.phase === "streaming";
  const answering = preview.text.length > 0;

  // Memoized on the answer text: an 80ms reasoning flush must not re-parse
  // the markdown answer body.
  const answerBody = useMemo(
    () =>
      preview.text.length > 0 ? (
        // Resolves in once beneath the needle bloom — clarity "earned" by the
        // thinking. One-shot on first mount; text deltas reuse the same node so
        // it never re-triggers.
        <div className="vex-answer-resolve break-words text-[15px] leading-[1.7] text-foreground">
          <MarkdownContent text={preview.text} />
        </div>
      ) : null,
    [preview.text],
  );

  // Bounded label -> category -> fixed copy. The classifier is total, so a
  // missing or unrecognized label lands on the honest `unknown` wording rather
  // than the old "Stream error", which named nothing.
  const streamErrorCopy = engineErrorCopy(
    classifyEngineFailure({ errorType: preview.errorType }),
  );

  return (
    <div
      data-vex-area="stream-preview"
      data-vex-message-role="assistant"
      data-vex-stream-phase={preview.phase}
      aria-busy={streaming}
      className="relative flex flex-col gap-2 pl-7"
    >
      <span className="sr-only" role="status">
        <span>
          {preview.phase === "error"
            ? "Vex stream error"
            : preview.phase === "done"
              ? "Vex responded"
              : "Vex is responding"}
        </span>
        {streaming ? (
          <span>
            {awaitingApproval ? "Awaiting signature" : STATUS_WORD[preview.status]}
          </span>
        ) : null}
      </span>
      {streaming ? (
        <>
          {/* Gutter working mark — Vex's countersign slot, but moving:
              DotmCircular8 = cognition (thinking), DotmHex3 = everything else.
              Circuit-break (S5): a pending approval FREEZES the mark — the
              only animations in the shell are bound to verifiable work, and
              waiting on a signature is not work. */}
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-0",
              // Needle bloom fires ONCE when the class is added — i.e. the
              // instant the answer starts — unless a pending approval is
              // freezing the strip (trust = stillness, no flare while waiting).
              answering && !awaitingApproval && "vex-signal-resolve",
            )}
          >
            {preview.status === "thinking" ? (
              <DotmCircular8
                size={14}
                dotSize={2}
                color="var(--vex-accent)"
                animated={!awaitingApproval}
              />
            ) : (
              <DotmHex3
                size={14}
                dotSize={2}
                color="var(--vex-accent)"
                animated={!awaitingApproval}
              />
            )}
          </span>
          <div className="flex items-baseline justify-between gap-2">
            {awaitingApproval ? (
              // Quiet pin/amber register (matches the amber approval card) —
              // no pulse, no fill; the pen decides.
              <span
                data-vex-stream-awaiting=""
                className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--vex-pin)]"
              >
                Awaiting signature
              </span>
            ) : preview.status === "calling" ? (
              <span
                data-vex-tool-state="preparing"
                className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--vex-text-3)]"
              >
                Calling {preview.toolName ?? "tool"}
              </span>
            ) : (
              <span
                className={
                  preview.status === "thinking"
                    ? "font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--vex-accent-text)]"
                    : "font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--vex-text-3)]"
                }
              >
                {STATUS_WORD[preview.status]}
              </span>
            )}
            <ElapsedCounter startedAtMs={preview.startedAtMs} />
          </div>
        </>
      ) : null}
      {preview.phase === "error" ? (
        <div className="flex flex-col gap-1">
          {/* Category copy, NOT provider text. `errorType` is a bounded enum
              label from the provider's own taxonomy; it is mapped through the
              ONE shared classifier so this strip, the error banner and the
              chat IPC mapper cannot disagree. With no label the copy falls
              back to the honest `unknown` wording rather than "Stream error",
              which told the user nothing. */}
          <span className="text-sm text-destructive">{streamErrorCopy.title}</span>
          <span className="text-xs text-destructive">{streamErrorCopy.body}</span>
          {preview.reasoningText.length > 0 ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
              Reasoning interrupted
            </span>
          ) : null}
        </div>
      ) : (
        <>
          {preview.reasoningText.length > 0 ? (
            <ReasoningStrip
              reasoningText={preview.reasoningText}
              reasoningTokens={preview.reasoningTokens}
              answering={answering}
            />
          ) : null}
          {answerBody}
        </>
      )}
    </div>
  );
}
