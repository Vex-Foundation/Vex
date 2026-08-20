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
 * approval queue, and "Confirmed" when the engine persisted `success: true`
 * for a `wallet_send_confirm` act AND its (bounded) output carries the tool's
 * strict `{ status: "confirmed", txHash }` contract.
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
  IconChevronRight,
  IconCircleCheck,
} from "../../../components/icons/index.js";
import { JsonTree } from "../../../components/ui/json-tree.js";
import { cn } from "../../../lib/utils.js";
import type { ToolCallActView } from "../transcriptRowModel.js";
import { ApprovalLinkStamp } from "./ApprovalLinkStamp.js";
import { ExplorerRefLinks } from "./ExplorerRefLinks.js";
import { ProtocolMark } from "./ProtocolMark.js";
import { ToolLegLine, ToolSingleLegLine } from "./ToolLegLine.js";
import { formatToolDuration } from "./toolDuration.js";
import { resolveToolIdentity } from "./toolIdentity.js";
import { resolveToolLegs, resolveToolSingleLeg } from "./toolLegs.js";
import { resolveToolOperation } from "./toolOperation.js";
import { toolGlyph } from "./toolGlyph.js";

/**
 * Hard bound on the untrusted output text this module hands to `JSON.parse` —
 * the same 20k gate `toolLegs.ts` applies, for the same reason: tool output is
 * an UNBOUNDED DTO string and a multi-megabyte payload must never cost the
 * renderer a synchronous parse per visible card. Far above any legitimate
 * `{ status, txHash }` receipt, so the gate costs no real stamp.
 */
const MAX_PARSE_CHARS = 20_000;

/**
 * Recognise only the successful wallet-confirm output contract. Two proofs are
 * required, and the persisted one comes FIRST: the engine must have recorded
 * `success === true` for this act (rules/90 — a "Confirmed" stamp is a claim
 * that funds moved, and untrusted output text may confirm that claim but may
 * never make it on its own). Then the output must carry the tool's strict
 * `{ status: "confirmed", txHash }` contract. Malformed JSON, an oversized
 * payload, lookalike tools, a missing hash, or any non-confirmed status all
 * fail closed to no stamp.
 */
function isConfirmedWalletTransfer(act: ToolCallActView): boolean {
  if (act.success !== true) return false;
  if (act.toolName !== "wallet_send_confirm" || act.output === null) return false;
  if (act.output.length > MAX_PARSE_CHARS) return false;
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
      <IconCircleCheck size={12} />
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

/** Section label inside the expanded well — mono microtype (10px floor).
 * Sticky against the section's own scroll so the label stays readable while
 * its payload scrolls underneath. */
function SectionHeading({
  children,
}: {
  readonly children: string;
}): JSX.Element {
  return (
    <span className="sticky top-0 block bg-[var(--vex-surface-down)] font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--vex-text-3)]">
      {children}
    </span>
  );
}

/**
 * Bounded JSON read for the payload viewer (C9): the same 20k gate the
 * confirm-stamp reader applies — a multi-megabyte payload must never cost a
 * synchronous parse per visible card. Non-JSON, oversized, or primitive
 * payloads return null and render as inert text.
 */
function parseJsonPayload(text: string): object | readonly unknown[] | null {
  if (text.length > MAX_PARSE_CHARS) return null;
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Section body: a JSON payload renders as the collapsible inspector tree
 * (copy-raw included); anything else stays pre-wrapped inert text.
 */
function SectionBody({
  text,
  emptyHint,
}: {
  readonly text: string | null;
  readonly emptyHint: string;
}): JSX.Element {
  const json = useMemo(
    () => (text === null ? null : parseJsonPayload(text)),
    [text],
  );
  if (text === null || text.length === 0) {
    return (
      <span className="font-mono text-[11px] leading-relaxed text-[var(--vex-text-3)]">
        {emptyHint}
      </span>
    );
  }
  if (json !== null) {
    return <JsonTree data={json} />;
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--vex-text-2)]">
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
  // Legs are a money-operation affordance only — parsing every act's payload
  // for token-shaped keys would let an unrelated tool's args draw a trade
  // line. `resolveToolOperation` (not the coarse category) decides both
  // eligibility and what the line may CLAIM: a proven mutating op that
  // succeeded renders the bare executed summary, a proven quote renders a
  // labelled preview, an unproven money-shaped op renders labelled, and
  // anything else gets no legs at all.
  const operation = useMemo(
    () => resolveToolOperation(act.toolName, identity.protocol, act.toolArgs),
    [act.toolName, identity.protocol, act.toolArgs],
  );
  const legs = useMemo(
    () =>
      operation === null
        ? null
        : resolveToolLegs(
            act.toolArgs,
            act.output,
            act.success,
            operation,
            act.displayStatus,
          ),
    [operation, act.toolArgs, act.output, act.success, act.displayStatus],
  );
  // A ONE-SIDED movement - a Morpho Blue market supply/withdraw/borrow/repay
  // moves exactly one token - is read only once the PAIR reader has declined,
  // so a two-sided act can never be reported as half of itself. The single leg
  // draws a wallet-relative arrow, never the pair line's `→` between two
  // tokens: inventing a mirror leg would claim a movement that never happened.
  const singleLeg = useMemo(
    () =>
      operation === null || legs !== null
        ? null
        : resolveToolSingleLeg(
            act.toolArgs,
            act.output,
            act.success,
            operation,
            act.displayStatus,
          ),
    [operation, legs, act.toolArgs, act.output, act.success, act.displayStatus],
  );
  return (
    // §7 row anatomy: a quiet 24px header line (no boxed card), the expanded
    // body a SIBLING ioCard below it. `group` scopes the leading crossfade.
    <div
      // Semantic contract: every visible tool row keeps the role attr.
      data-vex-message-role="tool"
      data-vex-tool-category={identity.category}
      className="group flex flex-col"
    >
      <div className="flex min-h-6 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          // The raw symbol stays reachable even though the card shows prose.
          title={act.toolName}
          className="flex min-w-0 flex-1 items-center text-left focus-visible:outline-none focus-visible:rounded-[4px] focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          {/* DisclosureRow house pattern: the 16px leading box crossfades the
              tool mark to a chevron on hover/focus — "this row expands"
              without a resting chevron. 100ms opacity, no layout shift. */}
          <span className="relative mr-1.5 inline-grid h-4 w-4 flex-none place-items-center">
            <span className="col-start-1 row-start-1 inline-flex items-center justify-center transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0">
              <ProtocolMark
                protocol={identity.protocol}
                fallbackGlyph={toolGlyph(act.toolName)}
                size={16}
              />
            </span>
            <span
              aria-hidden
              className={cn(
                "col-start-1 row-start-1 inline-flex items-center justify-center text-[var(--vex-text-2)] opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100",
                open && "rotate-90",
              )}
            >
              <IconChevronRight size={12} />
            </span>
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center">
              <span className="flex-none truncate text-[14px] leading-6 text-[var(--vex-text-2)]">
                {identity.title}
              </span>
              {/* 2x2 separator dot before the trailing measurement. */}
              {formatToolDuration(act.durationMs ?? null) !== null ? (
                <span
                  aria-hidden
                  className="mx-2 h-[2px] w-[2px] flex-none rounded-[1px] bg-ink-caption"
                />
              ) : null}
              <DurationChip durationMs={act.durationMs} />
            </span>
            {legs !== null ? <ToolLegLine legs={legs} /> : null}
            {singleLeg !== null ? <ToolSingleLegLine leg={singleLeg} /> : null}
          </span>
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
        // ioCard: l1 hairline, r12, the recessed code surface; each section
        // caps and scrolls alone so a long input never buries a short output.
        <div
          id={bodyId}
          className="vex-entry-settle ml-1 mt-1 flex flex-col overflow-hidden rounded-[12px] border border-line-1 bg-[var(--vex-surface-down)]"
        >
          <div className="max-h-[150px] overflow-y-auto px-4 py-3">
            <SectionHeading>Args</SectionHeading>
            <SectionBody text={act.toolArgs} emptyHint="(no parameters)" />
          </div>
          {/* Output renders ONLY when a result actually merged (null = none). */}
          {act.output !== null ? (
            <>
              <div aria-hidden className="h-px flex-none bg-line-2" />
              <div className="max-h-[150px] overflow-y-auto px-4 py-3">
                <SectionHeading>Output</SectionHeading>
                <SectionBody text={act.output} emptyHint="(no output)" />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
