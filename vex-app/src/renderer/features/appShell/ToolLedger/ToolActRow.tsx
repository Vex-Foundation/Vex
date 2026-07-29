/**
 * THE ACT LEDGER — one registered act (S5): a tool call plus its merged
 * output, presented as a FRIENDLY CARD.
 *
 * The card's header reads as a fact about the world rather than a symbol dump:
 * the protocol mark (contract C5 — venue logo when provenance is proven, the
 * category glyph otherwise), a human title ("Swap · KyberSwap", "Memory
 * recall"), the swap/bridge leg line when one can be parsed fail-closed, and
 * the measured duration chip when — and ONLY when — a duration was actually
 * measured (`null` is not zero; a call that never ran must never read "0 s").
 * The raw tool name stays available as the header's `title` tooltip so nothing
 * the ledger knew is lost.
 *
 * Two deterministic stamps survive unchanged: "Awaiting signature" from the
 * approval queue, and "Confirmed" when a `wallet_send_confirm` result carries
 * the tool's strict `{ status: "confirmed", txHash }` output contract.
 *
 * Collapsed by default (today's disclosure contract). The expanded body is a
 * recessed well; args/output are sanitized strings rendered as INERT TEXT
 * (`<pre>` pre-wrap) — never HTML, and the friendly header never replaces the
 * ability to read them. CSP-safe: the one-shot reveal uses the stylesheet
 * `.vex-entry-settle` keyframes (180ms, collapsed to its final frame under
 * prefers-reduced-motion by the global rule).
 */

import { useId, useMemo, useState, type JSX } from "react";
import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  VexIcon,
} from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";
import type { ToolCallActView } from "../transcriptRowModel.js";
import { ApprovalLinkStamp } from "./ApprovalLinkStamp.js";
import { ExplorerRefLinks } from "./ExplorerRefLinks.js";
import { ProtocolMark } from "./ProtocolMark.js";
import { ToolLegLine } from "./ToolLegLine.js";
import { formatToolDuration } from "./toolDuration.js";
import { resolveToolIdentity } from "./toolIdentity.js";
import { resolveToolLegs } from "./toolLegs.js";
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

/**
 * Measured-duration chip. Rendered ONLY for a real measurement — the caller
 * passes `null` through for every never-executed / synthetic / legacy act and
 * this returns nothing at all.
 */
function DurationChip({
  durationMs,
}: {
  readonly durationMs: number | null | undefined;
}): JSX.Element | null {
  const text = formatToolDuration(durationMs ?? null);
  if (text === null) return null;
  return (
    <span
      data-vex-tool-duration=""
      className="shrink-0 tabular-nums text-[11px] text-[var(--vex-text-3)]"
    >
      {text}
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
  const identity = useMemo(
    () => resolveToolIdentity(act.toolName, act.toolArgs),
    [act.toolName, act.toolArgs],
  );
  // Legs are a swap/bridge affordance only — parsing every act's payload for
  // token-shaped keys would let an unrelated tool's args draw a trade line.
  const legs = useMemo(
    () =>
      identity.category === "swap" || identity.category === "bridge"
        ? resolveToolLegs(act.toolArgs, act.output)
        : null,
    [identity.category, act.toolArgs, act.output],
  );
  return (
    <div
      // Semantic contract: every visible tool row keeps the role attr.
      data-vex-message-role="tool"
      data-vex-tool-category={identity.category}
      className="overflow-hidden rounded-[6px] border border-[var(--vex-line)] bg-white/[0.02]"
    >
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          // The raw symbol stays reachable even though the card shows prose.
          title={act.toolName}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          <ProtocolMark
            protocol={identity.protocol}
            fallbackGlyph={toolGlyph(act.toolName)}
            size={16}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="min-w-0 truncate text-[12.5px] text-foreground">
              {identity.title}
            </span>
            {legs !== null ? <ToolLegLine legs={legs} /> : null}
          </span>
          <DurationChip durationMs={act.durationMs} />
          {/* Chevron stays even when stamped — it is the expand affordance. */}
          <VexIcon
            icon={ArrowRight01Icon}
            size={12}
            aria-hidden
            className={cn(
              "shrink-0 text-[var(--vex-text-3)] transition-transform",
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
