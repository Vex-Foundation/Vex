/**
 * THE ACT LEDGER — one registered act (S5): a tool call plus its merged
 * output, presented as one ruled LEDGER LINE (docs/design/V10-SPREAD.md
 * section 1, reference d3): the protocol mark in the blue, the human title in
 * 13px Departure Mono, the measured duration, and the act's status swatch at
 * the line's end - status by fill, and only for an outcome the engine
 * actually persisted.
 *
 * The card's header reads as a fact about the world rather than a symbol dump:
 * the protocol mark (contract C5 — venue logo when provenance is proven, the
 * category glyph otherwise), a human title ("Swap · KyberSwap", "Memory
 * recall"), one summary slot, and the measured duration chip when - and ONLY
 * when - a duration was actually measured (`null` is not zero; a call that
 * never ran must never read "0 s"). The raw tool name stays available as the
 * header's `title` tooltip so nothing the ledger knew is lost.
 *
 * THE COLLAPSED HEADER IS ALWAYS ONE LINE (deepseek ToolRow): every fixed
 * member is `flex-none` and the summary is the only thing that fills and
 * truncates, so a wide leg line or a long failure message clips instead of
 * folding the row. The summary slot holds, in precedence order, the proven leg
 * line or the failure's first line in the error tone (see `summary` below for
 * why that order is not deepseek's). Explorer refs and the expanded body are
 * SIBLING lines below the header, never inside it.
 *
 * Two deterministic stamps survive unchanged: "Awaiting signature" from the
 * approval queue, and "Confirmed" when the engine persisted `success: true`
 * for a `wallet_send_confirm` act AND its (bounded) output carries the tool's
 * strict `{ status: "confirmed", txHash }` contract.
 *
 * Collapsed by default (today's disclosure contract). The expanded body is a
 * recessed well; args/output are sanitized strings rendered as INERT TEXT
 * (`<pre>` pre-wrap) — never HTML, and the friendly header never replaces the
 * ability to read them. The reveal is the shared `ExpandRegion` primitive:
 * build-time CSS height interpolation, collapsed to a hard cut under
 * prefers-reduced-motion. The OUTPUT section rides a second region of its own
 * so a result that lands later unfolds instead of popping in.
 */

import {
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { IconChevronRight } from "../../../components/icons/index.js";
import { JsonTree } from "../../../components/ui/json-tree.js";
import { Swatch, type SwatchState } from "../../../components/ui/swatch.js";
import { cn } from "../../../lib/utils.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";
import { DeskTicketLoadStamp } from "../lighterTrading/DeskTicketLoadStamp.js";
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
      className="inline-flex h-[22px] shrink-0 items-center gap-[7px] px-2 font-mono text-[11px] uppercase leading-none tracking-chip text-ink-primary outline outline-1 -outline-offset-1 outline-rule-ink"
    >
      <Swatch state="done" size={9} />
      Confirmed
    </span>
  );
}

/**
 * The act's status fill at the line's end (reference d3) - ONLY for an outcome
 * the engine persisted. A success is the solid square, an ambiguous broadcast
 * the dot screen (pending, not failed), a failure the ink cross. A call with no
 * persisted outcome yet (still running, never run, or a legacy row) draws no
 * swatch at all: `null` is not a status, and a guessed fill would be a claim.
 */
function actSwatch(act: ToolCallActView): SwatchState | null {
  if (act.success === true) return "done";
  if (act.success === false) {
    return act.displayStatus === "pending" ? "ongoing" : "error";
  }
  return null;
}

/**
 * The 2x2 separator dot of the one-line header grammar. `line-3`, not the
 * caption tier: caption is the disabled/decoration step and a 2px dot painted
 * in it is invisible in both themes.
 */
function SeparatorDot(): JSX.Element {
  return (
    <span
      aria-hidden
      className="mx-2 h-[2px] w-[2px] flex-none bg-line-3"
    />
  );
}

/**
 * Measured-duration chip. The caller resolves the text first and renders this
 * only for a real measurement - `formatToolDuration` returns `null` for every
 * never-executed / synthetic / legacy act, and `null` is not zero: a call that
 * never ran must never read "0 s".
 *
 * `flex-none` so it survives a narrow row: a duration clipped to "2" would be
 * a wrong number, whereas a clipped summary is still honest prose.
 */
function DurationChip({ text }: { readonly text: string }): JSX.Element {
  return (
    <span
      data-vex-tool-duration=""
      className="flex-none font-mono text-[11px] tracking-[0.02em] tabular-nums text-ink-secondary"
    >
      {text}
    </span>
  );
}

/**
 * A failed act's collapsed summary: the first line of its output, in the error
 * tone, REPLACING the leg line (deepseek ToolRow's error grammar). A number
 * beside a failed call reads as money that moved, so the leg line - which is
 * where amounts live - must not survive here.
 *
 * `displayStatus === "pending"` is deliberately excluded: an ambiguous
 * broadcast is unresolved, not failed, and `ToolLegLine` already labels it.
 */
function errorSummaryLine(
  act: ToolCallActView,
  displayTitle: string,
): string | null {
  if (act.success !== false) return null;
  if (act.displayStatus === "pending") return null;
  if (act.output === null) return null;
  const newline = act.output.indexOf("\n");
  const first = (newline === -1 ? act.output : act.output.slice(0, newline)).trim();
  const summary = stripToolNamePrefix(first, [displayTitle, act.toolName]).trim();
  return summary.length === 0 ? null : summary;
}

/**
 * SUMMARY-ONLY derivation, not a cut of content: the header already prints the
 * tool's title, so a failure line that begins with that same name followed by
 * ":" ("BoardCompose: notes: ...") would read the name twice on one line. The
 * known prefix is removed from the collapsed summary alone; the expanded
 * OUTPUT body renders the whole output text untouched, prefix included. Only
 * a case-sensitive match on the row's display title or its raw tool id counts
 * - no other text is ever dropped.
 */
function stripToolNamePrefix(
  line: string,
  names: readonly string[],
): string {
  for (const name of names) {
    if (name.length === 0) continue;
    const prefix = `${name}:`;
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return line;
}

/**
 * Section label of the expanded well - mono microtype (10px floor, a
 * documented register). It is a STATIC label rendered ABOVE its section's
 * scroll surface, never inside it: a sticky label inside the scroller let
 * scrolled payload show through the well's padding around it (owner QA
 * screenshot). `SectionScroll` is the only element that scrolls.
 */
function SectionHeading({
  children,
}: {
  readonly children: string;
}): JSX.Element {
  return (
    <div className="px-4 pb-1 pt-3">
      <span
        data-vex-tool-section-label=""
        className="block font-mono text-[11px] uppercase tracking-chip text-ink-secondary"
      >
        {children}
      </span>
    </div>
  );
}

/**
 * The section's capped scroll surface. Caps and scrolls alone so a long
 * input never buries a short output; the label sits above it as a sibling, so
 * no text can pass under or beside the label.
 */
function SectionScroll({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div
      data-vex-tool-section-scroll=""
      className="max-h-[220px] overflow-y-auto px-4 pb-3"
    >
      {children}
    </div>
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
      <span className="font-code text-[11.5px] leading-relaxed text-ink-secondary">
        {emptyHint}
      </span>
    );
  }
  if (json !== null) {
    return <JsonTree data={json} />;
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-code text-[11.5px] leading-relaxed text-ink-secondary">
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
  const triggerRef = useRef<HTMLButtonElement>(null);
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
  const durationText = formatToolDuration(act.durationMs ?? null);
  const swatch = actSwatch(act);
  // The header's ONE summary slot. Whatever lands here fills and truncates;
  // the title and the duration flank it and never shrink.
  //
  // PRECEDENCE IS INVERTED FROM deepseek's ToolRow, deliberately. There the
  // failure line outranks the summary because that summary is args-derived and
  // stale once the call failed. Vex's leg line is not an args summary: it is a
  // proven money assertion that ALREADY reports the failure honestly ("Failed"
  // outcome label, every amount suppressed, rules/90). Dropping it for prose
  // would delete a fail-closed money-path affordance, so a proven leg line
  // wins and the failure line takes the slot on every other row - which is
  // where deepseek's argument actually bites, since a bare title told the
  // reader nothing about what went wrong.
  const failureLine = errorSummaryLine(act, identity.title);
  const summary =
    legs !== null ? (
      <ToolLegLine legs={legs} />
    ) : singleLeg !== null ? (
      <ToolSingleLegLine leg={singleLeg} />
    ) : failureLine !== null ? (
      <span
        data-vex-tool-error-summary=""
        className="min-w-0 flex-1 truncate text-[12px] text-destructive"
      >
        {failureLine}
      </span>
    ) : null;
  return (
    // The ledger line: a 32px header closed by the quiet rule, the expanded
    // body a SIBLING well below it. `group` scopes the leading crossfade.
    <div
      // Semantic contract: every visible tool row keeps the role attr.
      data-vex-message-role="tool"
      data-vex-tool-category={identity.category}
      className="vex-ledger__row group flex flex-col"
    >
      <div className="flex min-h-8 items-center gap-3">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          // The raw symbol stays reachable even though the card shows prose.
          title={act.toolName}
          className="flex min-w-0 flex-1 items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {/* DisclosureRow house pattern: the 16px leading box crossfades the
              tool mark to a chevron on hover/focus - "this row expands"
              without a resting chevron. 100ms opacity, no layout shift. */}
          <span className="relative mr-3 inline-grid h-4 w-4 flex-none place-items-center text-accent-primary">
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
                "col-start-1 row-start-1 inline-flex items-center justify-center text-accent-primary opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100",
                open && "rotate-90",
              )}
            >
              <IconChevronRight size={12} />
            </span>
          </span>
          {/* ONE LINE, always (deepseek ToolRow): title, separator dot, the
              FILL-truncating summary, then the measurement. `flex-nowrap` and
              `flex-none` on every fixed member are what stop a long summary or
              a wide leg line from folding the header into two rows - the
              defect the QA screenshot caught. */}
          <span className="flex min-w-0 flex-1 flex-nowrap items-center">
            <span className="flex-none truncate font-mono text-[13px] leading-6 tracking-[0.02em] text-ink-primary">
              {identity.title}
            </span>
            {summary !== null ? (
              <>
                <SeparatorDot />
                {summary}
              </>
            ) : null}
            {durationText !== null ? (
              <>
                <SeparatorDot />
                <DurationChip text={durationText} />
              </>
            ) : null}
          </span>
        </button>
        <DeskTicketLoadStamp act={act} />
        {confirmed ? (
          <ConfirmedStamp />
        ) : pendingApprovalId !== null ? (
          <ApprovalLinkStamp approvalId={pendingApprovalId} />
        ) : null}
        {/* The status column: always 9px wide, so every line's figures end
            on one edge whether or not an outcome is known. */}
        <span
          aria-hidden
          data-vex-tool-status={swatch ?? undefined}
          className="inline-flex w-[9px] flex-none text-accent-primary"
        >
          {swatch !== null && pendingApprovalId === null ? (
            <Swatch state={swatch} size={9} />
          ) : null}
        </span>
      </div>
      {/* Explorer links get their OWN line under the header. They are anchors,
          so they can never nest inside the disclosure button (invalid HTML),
          and as a wrapping sibling INSIDE the header row they used to crush
          the `min-w-0 flex-1` title and wrap off on their own - the "row of
          chips with no owner" in the QA screenshot. Inert when nothing
          resolves. */}
      <ExplorerRefLinks refs={act.explorerRefs} />
      {/* The well (reference d4's facts well): the second paper, no frame;
          each section is a static label over its own capped scroll surface.
          It rides the shared expand primitive - the well is the INNER box,
          so the animated outer box carries none of its margin, and the
          entrance keyframe is gone (an expand is not also a mount). */}
      <ExpandRegion
        id={bodyId}
        open={open}
        triggerRef={triggerRef}
        className="mb-2 ml-7 flex flex-col overflow-hidden bg-surface-3"
      >
        <div data-vex-tool-section="args">
          <SectionHeading>Args</SectionHeading>
          <SectionScroll>
            <SectionBody text={act.toolArgs} emptyHint="(no parameters)" />
          </SectionScroll>
        </div>
        {/* Output exists ONLY once a result actually merged (null = none), and
            its ARRIVAL is a reveal, not a pop: the section rides its own
            ExpandRegion (lazy first mount, so nothing renders while null;
            stays mounted after) and unfolds with the same curve as the well
            and the thinking block. Reduced motion is honoured by the
            primitive's stylesheet, not here. The hairline divider belongs to
            the revealed section, so it unfolds with it. No trigger: this
            region opens on data, not on a click. */}
        <ExpandRegion
          id={`${bodyId}-output`}
          open={act.output !== null}
          className="flex flex-col"
        >
          <div aria-hidden className="h-px flex-none bg-rule-quiet" />
          <div data-vex-tool-section="output">
            <SectionHeading>Output</SectionHeading>
            <SectionScroll>
              <SectionBody text={act.output} emptyHint="(no output)" />
            </SectionScroll>
          </div>
        </ExpandRegion>
      </ExpandRegion>
    </div>
  );
}
