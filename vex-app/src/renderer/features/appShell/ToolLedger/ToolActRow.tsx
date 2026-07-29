/**
 * THE ACT LEDGER — one registered act (S5): a tool call plus its merged
 * output. The transcript shows REGISTERED FACTS: most rows stay quiet — name
 * + Args (+ Output when a result paired in the same run). Two deterministic
 * stamps are supported: "Awaiting signature" from the approval queue, and
 * "Confirmed" when a `wallet_send_confirm` result carries the tool's strict
 * `{ status: "confirmed", txHash }` output contract.
 *
 * Collapsed by default (today's disclosure contract). The expanded body is a
 * recessed well; args/output are sanitized strings rendered as TEXT (`<pre>`
 * pre-wrap) — never HTML. CSP-safe: the one-shot reveal uses the stylesheet
 * `.vex-entry-settle` keyframes (180ms, collapsed to its final frame under
 * prefers-reduced-motion by the global rule).
 */

import { useId, useState, type JSX } from "react";
import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  VexIcon,
} from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";
import type { ToolCallActView } from "../transcriptRowModel.js";
import { ApprovalLinkStamp } from "./ApprovalLinkStamp.js";
import { ExplorerRefLinks } from "./ExplorerRefLinks.js";
import { toolGlyph } from "./toolGlyph.js";

/**
 * Recognise only the successful wallet-confirm output contract. Tool output
 * is still treated as untrusted text: malformed JSON, lookalike tools, a
 * missing hash, or any non-confirmed status all fail closed to no stamp.
 */
function isConfirmedWalletTransfer(act: ToolCallActView): boolean {
  if (act.toolName !== "wallet_send_confirm" || act.output === null) return false;
  try {
    const parsed: unknown = JSON.parse(act.output);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    return (
      record["status"] === "confirmed" &&
      typeof record["txHash"] === "string" &&
      record["txHash"].length > 0
    );
  } catch {
    return false;
  }
}

function ConfirmedStamp(): JSX.Element {
  return (
    <span
      role="status"
      aria-label="Transaction confirmed"
      data-vex-transaction-status="confirmed"
      className="inline-flex shrink-0 items-center gap-1 rounded-[3px] border border-[color-mix(in_oklab,var(--color-success)_40%,transparent)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-success)]"
    >
      <VexIcon icon={CheckmarkCircle01Icon} size={12} aria-hidden />
      Confirmed
    </span>
  );
}

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
  const confirmed = isConfirmedWalletTransfer(act);
  return (
    <div
      // Semantic contract: every visible tool row keeps the role attr.
      data-vex-message-role="tool"
      className="overflow-hidden rounded-[6px] border border-[var(--vex-line)] bg-white/[0.02]"
    >
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          <VexIcon
            icon={toolGlyph(act.toolName)}
            size={14}
            aria-hidden
            className="shrink-0 text-[var(--vex-text-3)]"
          />
          <span className="min-w-0 truncate font-mono text-[12px] text-[var(--vex-text-2)]">
            {act.toolName}
          </span>
          {/* Chevron stays even when stamped — it is the expand affordance. */}
          <VexIcon
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
        {confirmed ? (
          <ConfirmedStamp />
        ) : pendingApprovalId !== null ? (
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
