/**
 * THE ACT LEDGER - one registered act (S5): a tool call plus its merged
 * output, presented as one STEP ROW (docs/design/R3-MINIMAL.md section 6): the
 * outcome fill, the venue mark, the human title in 500, the word ("Done",
 * "Failed", "Pending"), the measured duration in the mono 12 at the right and
 * the chevron. Status by fill plus a word, and only for an outcome the engine
 * actually persisted.
 *
 * The row reads as a fact about the world rather than a symbol dump: the
 * protocol mark (contract C5 - venue logo when provenance is proven, the
 * category glyph otherwise), a human title ("Swap · KyberSwap", "Memory
 * recall"), one summary slot, and the measured duration when - and ONLY when -
 * a duration was actually measured (`null` is not zero; a call that never ran
 * must never read "0 s"). The raw tool name stays available as the row's
 * `title` tooltip so nothing the ledger knew is lost.
 *
 * THE ROW IS ALWAYS ONE LINE (deepseek ToolRow): every fixed member is
 * `flex-none` and the summary is the only thing that fills and truncates, so a
 * wide leg line or a long failure message clips instead of folding the row.
 * The summary slot holds, in precedence order, the proven leg line or the
 * failure's first line (see `summary` below for why that order is not
 * deepseek's). Explorer refs and the opened well are SIBLING lines below the
 * row, never inside it.
 *
 * Two deterministic marks survive unchanged: "Waiting for approval" from the
 * approval queue (a link to the card), and "Confirmed" when the engine
 * persisted `success: true` for a `wallet_send_confirm` act AND its (bounded)
 * output carries the tool's strict `{ status: "confirmed", txHash }` contract.
 *
 * Collapsed by default (today's disclosure contract). The opened row is a
 * paper 2 well with Args and Output on a 64px key column; args/output are
 * sanitized strings rendered as INERT TEXT (`<pre>` pre-wrap) or the JSON
 * inspector - never HTML. The reveal is the shared `ExpandRegion` primitive:
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
import {
  LineChevronDown,
  LineChevronRight,
} from "../../../components/icons/line/index.js";
import { JsonTree } from "../../../components/ui/json-tree.js";
import { Swatch, type SwatchState } from "../../../components/ui/swatch.js";
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

/** "Confirmed" in ink with the solid fill, after the row, for a proven send. */
function ConfirmedStamp(): JSX.Element {
  return (
    <span
      role="status"
      aria-label="Transaction confirmed"
      data-vex-transaction-status="confirmed"
      className="vex-step-confirmed"
    >
      <Swatch state="done" size={10} />
      Confirmed
    </span>
  );
}

/** What a step's fill and word say: only an outcome the engine persisted. */
interface StepOutcome {
  readonly fill: SwatchState;
  readonly word: string;
  readonly state: "done" | "pending" | "failed";
}

/**
 * The act's outcome (docs/design/R3-MINIMAL.md section 6) - ONLY for an
 * outcome the engine persisted. A success is the solid square and "Done", an
 * ambiguous broadcast the dot screen and "Pending" (not failed), a failure the
 * ink cross and "Failed". A call with no persisted outcome yet (still running,
 * never run, or a legacy row) draws no fill and no word: `null` is not a
 * status, and a guessed fill would be a claim.
 */
function actOutcome(act: ToolCallActView): StepOutcome | null {
  if (act.success === true) return { fill: "done", word: "Done", state: "done" };
  if (act.success === false) {
    return act.displayStatus === "pending"
      ? { fill: "ongoing", word: "Pending", state: "pending" }
      : { fill: "error", word: "Failed", state: "failed" };
  }
  return null;
}

/**
 * Measured duration, in the mono 12 muted at the row's right. The caller
 * resolves the text first and renders this only for a real measurement -
 * `formatToolDuration` returns `null` for every never-executed / synthetic /
 * legacy act, and `null` is not zero: a call that never ran must never read
 * "0 s".
 *
 * `flex-none` so it survives a narrow row: a duration clipped to "2" would be
 * a wrong number, whereas a clipped summary is still honest prose.
 */
function DurationChip({ text }: { readonly text: string }): JSX.Element {
  return (
    <span data-vex-tool-duration="" className="vex-step__num flex-none">
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
 * Section key of the opened well - "Args", "Output", 12 muted in the 64px key
 * column. It is a STATIC label BESIDE its section's scroll surface, never
 * inside it: a sticky label inside the scroller let scrolled payload show
 * through around it (owner QA screenshot). `SectionScroll` is the only
 * element that scrolls.
 */
function SectionHeading({
  children,
}: {
  readonly children: string;
}): JSX.Element {
  return (
    <span data-vex-tool-section-label="" className="vex-step-well__key">
      {children}
    </span>
  );
}

/**
 * The section's capped scroll surface. Caps and scrolls alone so a long
 * input never buries a short output; the label sits beside it as a sibling,
 * so no text can pass under or beside the label.
 */
function SectionScroll({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div
      data-vex-tool-section-scroll=""
      className="vex-step-well__scroll overflow-y-auto"
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
      <span className="font-code text-[12px] leading-relaxed text-ink-tertiary">
        {emptyHint}
      </span>
    );
  }
  if (json !== null) {
    return <JsonTree data={json} />;
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-code text-[12px] leading-relaxed text-ink-primary">
      {text}
    </pre>
  );
}

export function ToolActRow({
  act,
  pendingApprovalId = null,
}: {
  readonly act: ToolCallActView;
  /** Matching PENDING approval id - adds the "Waiting for approval" link. */
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
  const outcome = actOutcome(act);
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
        className="vex-step__summary min-w-0 truncate text-destructive"
      >
        {failureLine}
      </span>
    ) : null;
  // A leg line that already names its outcome ("Quote", "Failed", "Pending")
  // says what the word would; the row does not say it twice. A step waiting
  // on the reader says so through its link (the target fill and "Waiting for
  // approval"), and a confirmed send through its "Confirmed" mark.
  const legOutcome = legs?.outcome ?? singleLeg?.outcome ?? null;
  const legsNameOutcome = legOutcome !== null && legOutcome !== "executed";
  const awaiting = pendingApprovalId !== null;
  const fill: SwatchState | null = awaiting ? null : (outcome?.fill ?? null);
  const word =
    outcome === null || awaiting || confirmed || legsNameOutcome
      ? null
      : outcome.word;
  return (
    // The step: a 36px row closed by the quiet rule, its links and its well
    // SIBLING lines below it, each closed by its own rule.
    <div
      // Semantic contract: every visible tool row keeps the role attr.
      data-vex-message-role="tool"
      data-vex-tool-category={identity.category}
      className="flex flex-col"
    >
      <div
        className="vex-step flex items-center"
        data-vex-step-state={outcome?.state}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          // The raw symbol stays reachable even though the row shows prose.
          title={act.toolName}
          className="vex-step__key"
        >
          {/* The outcome fill: always 10px wide, so every title starts on
              one edge whether or not an outcome is known. */}
          <span
            aria-hidden
            data-vex-tool-status={outcome?.fill}
            className="vex-step__fill"
          >
            {fill !== null ? <Swatch state={fill} size={10} /> : null}
          </span>
          <span className="vex-step__mark">
            <ProtocolMark
              protocol={identity.protocol}
              fallbackGlyph={toolGlyph(act.toolName)}
              size={14}
            />
          </span>
          {/* ONE LINE, always (deepseek ToolRow): title, word, the
              FILL-truncating summary, then the measurement. `flex-none` on
              every fixed member is what stops a long summary or a wide leg
              line from folding the row into two lines. */}
          <span className="vex-step__title">{identity.title}</span>
          {word !== null ? (
            <span data-vex-step-word="" className="vex-step__word">
              {word}
            </span>
          ) : null}
          {summary}
          <span aria-hidden className="vex-step__spacer" />
          {durationText !== null ? <DurationChip text={durationText} /> : null}
          <span aria-hidden className="vex-step__chev">
            {open ? <LineChevronDown size={14} /> : <LineChevronRight size={14} />}
          </span>
        </button>
        <DeskTicketLoadStamp act={act} />
        {confirmed ? (
          <ConfirmedStamp />
        ) : pendingApprovalId !== null ? (
          <ApprovalLinkStamp approvalId={pendingApprovalId} />
        ) : null}
      </div>
      {/* Explorer links get their OWN line under the row. They are anchors,
          so they can never nest inside the disclosure button (invalid HTML),
          and as a wrapping sibling INSIDE the row they used to crush the
          title and wrap off on their own - the "row of chips with no owner"
          in the QA screenshot. Inert when nothing resolves. */}
      <ExplorerRefLinks refs={act.explorerRefs} />
      {/* The well (docs/design/R3-MINIMAL.md section 6): paper 2, no frame,
          20 in from the row; each section a 64px key beside its own capped
          scroll surface. It rides the shared expand primitive - the well is
          the INNER box, so the animated outer box carries none of its
          margin, and there is no entrance keyframe (an expand is not also a
          mount). */}
      <ExpandRegion
        id={bodyId}
        open={open}
        triggerRef={triggerRef}
        className="vex-step-well overflow-hidden"
      >
        <div data-vex-tool-section="args" className="vex-step-well__section">
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
            primitive's stylesheet, not here. No trigger: this region opens
            on data, not on a click. */}
        <ExpandRegion
          id={`${bodyId}-output`}
          open={act.output !== null}
          className="flex flex-col"
        >
          <div data-vex-tool-section="output" className="vex-step-well__section">
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
