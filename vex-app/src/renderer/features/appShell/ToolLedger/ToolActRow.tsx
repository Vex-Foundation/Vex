/**
 * THE ACT LEDGER — one registered act (S5): a tool call plus its merged
 * output. The transcript shows REGISTERED FACTS: the DTO carries no per-call
 * status or duration, so the row is quiet — name + Args (+ Output when a
 * result paired in the same run). The only stamp the data supports is
 * "Awaiting signature": a pending approval whose `toolCallId` matches this
 * act (rendered as a sibling link, see `ApprovalLinkStamp`).
 *
 * Collapsed by default (today's disclosure contract). The expanded body is a
 * recessed well; args/output are sanitized strings rendered as TEXT (`<pre>`
 * pre-wrap) — never HTML. CSP-safe: the one-shot reveal uses the stylesheet
 * `.vex-entry-settle` keyframes (180ms, collapsed to its final frame under
 * prefers-reduced-motion by the global rule).
 */

import { useId, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { cn } from "../../../lib/utils.js";
import type { ToolCallActView } from "../transcriptRowModel.js";
import type { HyperliquidDisplayBlock } from "@shared/schemas/hyperliquid.js";
import { ApprovalLinkStamp } from "./ApprovalLinkStamp.js";
import { ExplorerRefLinks } from "./ExplorerRefLinks.js";
import { toolGlyph } from "./toolGlyph.js";

/** Section label inside the expanded well — mono microtype (10px floor). */
function SectionHeading({
  children,
  topGap = false,
}: {
  readonly children: string;
  readonly topGap?: boolean;
}): JSX.Element {
  return (
    <span
      className={cn(
        "block font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--vex-text-3)]",
        topGap && "mt-2",
      )}
    >
      {children}
    </span>
  );
}

/** Pre-wrapped TEXT body for sanitized args/output; hint when empty. */
function SectionBody({
  text,
  emptyHint,
}: {
  readonly text: string | null;
  readonly emptyHint: string;
}): JSX.Element {
  if (text === null || text.length === 0) {
    return (
      <span className="font-mono text-[11px] leading-relaxed text-[var(--vex-text-3)]">
        {emptyHint}
      </span>
    );
  }
  return (
    <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--vex-text-2)]">
      {text}
    </pre>
  );
}

/** The receipt detail (coin/status/etc.) — the brand wordmark is drawn once in
 * the frame header, so this is the mono, scannable remainder only. */
function hyperliquidDetail(block: HyperliquidDisplayBlock): string {
  switch (block.kind) {
    case "order_receipt":
      return `${block.coin} · ${block.status}`;
    case "position_summary":
      return `${block.side} ${block.size} ${block.coin} · ${block.protectionState}`;
    case "risk_proposal":
      return `risk proposal · ${block.proposal.coin} · ${block.proposal.policy.leverageCapDefault}x cap`;
    case "workspace_mode_request":
      // The agent-emitted request that drives the Hypervexing workspace; the
      // transcript states plainly which way it asked to move.
      return block.mode === "hypervexing"
        ? "open Hypervexing workspace"
        : "close Hypervexing workspace";
    default: {
      const exhaustive: never = block;
      throw new Error(`Unhandled Hyperliquid display block: ${String(exhaustive)}`);
    }
  }
}

export function ToolActRow({
  act,
  pendingApprovalId = null,
}: {
  readonly act: ToolCallActView;
  /** Matching PENDING approval id — adds the "Awaiting signature" link. */
  readonly pendingApprovalId?: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const hyperliquidDisplay = act.toolDisplayBlock ?? null;
  return (
    <div
      // Semantic contract: every visible tool row keeps the role attr.
      data-vex-message-role="tool"
      data-hyperliquid-card={hyperliquidDisplay === null ? undefined : "true"}
      className={cn(
        // The Hyperliquid frame wears a 2px accent LEFT SPINE (design spec
        // §4.5) + a hairline elsewhere; plain acts keep the full hairline.
        "overflow-hidden rounded-[6px] border bg-white/[0.02]",
        hyperliquidDisplay === null
          ? "border-[var(--vex-line)]"
          : "border-[var(--vex-line)] border-l-2 border-l-[var(--vex-accent)]",
      )}
    >
      {hyperliquidDisplay !== null ? (
        // Protocol frame header: the HL logomark (full color — the mark is its
        // own brand punctuation) + the serif "Hyperliquid" wordmark accent,
        // then the mono, scannable receipt detail.
        <div className="flex items-center gap-2 border-b border-[var(--vex-line)] px-2.5 py-1.5">
          <img
            src="/protocols/hl.png"
            alt=""
            aria-hidden
            draggable={false}
            className="h-4 w-4 shrink-0 rounded-full object-cover"
          />
          <span className="shrink-0 font-serif text-[14px] italic leading-none text-[var(--vex-accent-text)]">
            Hyperliquid
          </span>
          <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-3)]">
            {hyperliquidDetail(hyperliquidDisplay)}
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          <HugeiconsIcon
            icon={toolGlyph(act.toolName)}
            size={14}
            aria-hidden
            className="shrink-0 text-[var(--vex-text-3)]"
          />
          <span className="min-w-0 truncate font-mono text-[12px] text-[var(--vex-text-2)]">
            {act.toolName}
          </span>
          {/* Chevron stays even when stamped — it is the expand affordance. */}
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            aria-hidden
            className={cn(
              "ml-auto shrink-0 text-[var(--vex-text-3)] transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
        {/* Explorer links are SIBLINGS of the disclosure button — anchors must
            never nest inside a button (invalid HTML). Rendered only when a
            paired result deposited resolvable refs; inert otherwise. */}
        <ExplorerRefLinks refs={act.explorerRefs} />
        {pendingApprovalId !== null ? (
          <ApprovalLinkStamp approvalId={pendingApprovalId} />
        ) : null}
      </div>
      {open ? (
        <div
          id={bodyId}
          className="vex-entry-settle border-t border-[var(--vex-line)] bg-[var(--vex-surface-down)] px-2.5 py-2"
        >
          <SectionHeading>Args</SectionHeading>
          <SectionBody text={act.toolArgs} emptyHint="(no parameters)" />
          {/* Output renders ONLY when a result actually merged (null = none). */}
          {act.output !== null ? (
            <>
              <SectionHeading topGap>Output</SectionHeading>
              <SectionBody text={act.output} emptyHint="(no output)" />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
