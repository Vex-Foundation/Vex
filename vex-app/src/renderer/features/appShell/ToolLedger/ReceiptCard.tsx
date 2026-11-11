/**
 * THE FILLED RECEIPT (docs/design/H3-DESKTOP.md section 1.7 and Appendix A.8;
 * H3's signed moment and its phone band draw it under the turn's thinking
 * row): a framed card for a swap, a transfer or a bridge that went through
 * (Cloud's result cards, 6f067702), from the ACTIVITY LEDGER'S OWN ENTRY for
 * it, never from the tool's output.
 *
 *   SWAP · BASE                     //// MAINNET  14:28  [CONFIRMED]
 *   USDC (arrow) ETH · Base
 *   ---------------------------------------------------------------
 *   SELL                                                   200 USDC
 *   VALUE (USD)                                       about $200.00
 *   RECEIVED                                           0.05709 ETH
 *   VEX FEE                                               0.5 USDC
 *
 * A TRANSFER (Cloud's TransferCard) titles its sent amount, "0.5 ETH · Base",
 * with Value (USD) and any Vex fee the row records; the entry names no
 * recipient, so Cloud's Recipient row is left out. A BRIDGE (Cloud's
 * BridgeCard) titles its route, "200 USDC · Base", the arrow, "USDC ·
 * Arbitrum", from the route ends' slugs, with Received, Value (USD) and the
 * Vex fee; Cloud's "It arrives at your own trading wallet" line is left out,
 * since the entry names no wallet.
 *
 * WHERE THE NUMBERS COME FROM. The act row's output is the tool's own word,
 * untrusted; the activity entry is what main recorded and checked
 * (`shared/schemas/agent-scan-feed.ts`), read through the same feed and the
 * same honest readers as the Activity page (`agent-scan-display.ts`), so the
 * receipt and Activity can never disagree:
 *   - SELL and RECEIVED are each leg's `displayAmount` (main's status-aware
 *     C20 choice) and its main-resolved symbol;
 *   - VALUE (USD) is the sold leg's quote-time `usdEst`, said as the
 *     estimate it is, "about $200.00" (Cloud's DG5-40): there is no
 *     settlement-time USD anywhere;
 *   - VEX FEE is the fee the row records (`vexFee`), or the fee attempt's own
 *     state when it has no settled amount;
 *   - the time is the entry's own, the chain its own, by name, in the kind
 *     and the title line;
 *   - MAINNET with the quiet hatch (Cloud's EC-10: a settled mainnet money
 *     card carries the quiet mark, never the solid stamp, which belongs
 *     where money is decided). Desktop is mainnet only, so it is always true.
 * A row whose value the entry does not hold is left out, never filled.
 *
 * WHICH ACT GETS ONE (`receiptTxRef`). Only an act the engine persisted as a
 * success, whose operation is PROVEN fund-moving (`toolOperation.ts`), that
 * carries a validated explorer reference: its transaction hash is the join
 * key. The card then shows only when the session's activity feed holds an
 * entry with that SAME hash (its own, or for a bridge, whose logical row is
 * the destination fill, one of its legs'), of kind `swap`, `transfer` or
 * `bridge`, and its status is `confirmed`.
 * Anything short of that draws no card, and the act row says what it knows.
 *
 * THE STAMP. H3's FILLED stamp is a status green fill with white caps
 * (`bg-stamp-filled`), and Cloud's tag leads its word with the state square
 * (PD-03: a fill, a square and a word). Desktop knows a transaction
 * CONFIRMED, not an order filled, so the stamp says desktop's outcome word
 * for the entry, "Confirmed" (Appendix A.3, `agent-scan-outcome.ts`).
 *
 * LEFT OUT. H3's APPROVAL row ("Approved by you"): approvals are not joined
 * to activity, and the transcript holds no resolved approval for the act, so
 * desktop has nothing that proves who approved it (Appendix A.8). H3's
 * "(your trading wallet)": the entry names no wallet.
 */

import { useMemo, type JSX } from "react";
import type { AgentScanActivityEntry } from "@shared/schemas/agent-scan-feed.js";
import { chainDisplay, chainDisplayBySlug } from "@shared/chains/display.js";
import { LineArrowUp } from "../../../components/icons/line/index.js";
import { StateSquare } from "../../../components/ui/state-square.js";
import { MainnetMark } from "../../../components/ui/stamp.js";
import { useAgentScanInfinite } from "../../../lib/api/portfolio.js";
import {
  entryClockText,
  isEstimatedBasis,
  legAmountText,
  legSymbolText,
  usdEstText,
  vexFeeText,
} from "../screens/agent-scan/agent-scan-display.js";
import { activityOutcome } from "../screens/agent-scan/agent-scan-outcome.js";
import type { ToolCallActView } from "../transcriptRowModel.js";
import { resolveToolIdentity } from "./toolIdentity.js";
import { resolveToolOperation } from "./toolOperation.js";

/**
 * The transaction a receipt may be drawn for: the act's first validated
 * explorer reference, and only for a persisted success of a proven
 * fund-moving operation. `null` for everything else.
 */
export function receiptTxRef(act: ToolCallActView): string | null {
  if (act.success !== true) return null;
  const ref = act.explorerRefs?.[0]?.txRef ?? null;
  if (ref === null || ref.length === 0) return null;
  const identity = resolveToolIdentity(act.toolName, act.toolArgs);
  const operation = resolveToolOperation(act.toolName, identity.protocol, act.toolArgs);
  return operation === "mutating" ? ref : null;
}

/** One transaction, two spellings: an EVM hash in any case, any other ref exactly. */
export function sameTransaction(a: string, b: string): boolean {
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** The activity kinds a receipt is drawn for (Cloud's swap, transfer and bridge result cards). */
export const RECEIPT_KINDS: ReadonlySet<string> = new Set(["swap", "transfer", "bridge"]);

/**
 * Whether the entry is the record of `txRef`: its own transaction, or, for a
 * bridge whose logical row is the destination fill, one of its execution legs
 * (the source deposit the act signed is a leg).
 */
function entryHolds(entry: AgentScanActivityEntry, txRef: string): boolean {
  if (entry.txHash !== null && sameTransaction(entry.txHash, txRef)) return true;
  return entry.legs.some((leg) => leg.txHash !== null && sameTransaction(leg.txHash, txRef));
}

/** The activity entry a receipt is drawn from, or `null` when none proves one. */
export function receiptEntry(
  entries: readonly AgentScanActivityEntry[],
  txRef: string,
): AgentScanActivityEntry | null {
  const entry = entries.find((candidate) => entryHolds(candidate, txRef));
  if (entry === undefined) return null;
  if (!RECEIPT_KINDS.has(entry.activityKind) || entry.status !== "confirmed") return null;
  return entry;
}

/** The chain the entry executed on, by name; `null` when the entry names none. */
function chainNameOf(entry: AgentScanActivityEntry): string | null {
  if (entry.chainSlug !== null && entry.chainSlug.length > 0) {
    return chainDisplayBySlug(entry.chainSlug).name;
  }
  return entry.chainId !== null ? chainDisplay(entry.chainId).name : null;
}

/**
 * One end of a bridge route, by name, from its slug only: a route end's
 * chain id is the provider's own numbering, never read as an EVM id.
 */
function routeEndName(end: AgentScanActivityEntry["fromChain"]): string | null {
  return end?.slug != null && end.slug.length > 0 ? chainDisplayBySlug(end.slug).name : null;
}

/** "Swap", "Transfer", "Bridge": the kind word of the head. */
function kindWord(entry: AgentScanActivityEntry): string {
  if (entry.activityKind === "transfer") return "Transfer";
  if (entry.activityKind === "bridge") return "Bridge";
  return "Swap";
}

/**
 * "200 USDC", said as "about 200 USDC" when the entry says its amounts are
 * quoted (Cloud's DG5-40: an estimate says "about", never "~").
 */
function legText(
  entry: AgentScanActivityEntry,
  leg: AgentScanActivityEntry["input"],
): string | null {
  const amount = legAmountText(leg);
  if (amount === null) return null;
  const figure = isEstimatedBasis(entry) ? `about ${amount}` : amount;
  return `${figure} ${legSymbolText(leg)}`;
}

/**
 * The route's arrow (Cloud's `RouteArrow`): a 14 glyph, unseen by a screen
 * reader, which reads " to " in its place.
 */
function RouteArrow(): JSX.Element {
  return (
    <>
      <LineArrowUp size={14} className="vex-receipt__arrow" />
      <span className="sr-only"> to </span>
    </>
  );
}

interface ReceiptRow {
  readonly label: string;
  readonly value: string;
}

function receiptRows(entry: AgentScanActivityEntry): readonly ReceiptRow[] {
  const rows: { label: string; value: string | null }[] =
    entry.activityKind === "transfer"
      ? [
          // The amount is the title (Cloud's TransferCard); the entry names
          // no recipient, so that row is left out.
          { label: "Value (USD)", value: usdEstText(entry.input.usdEst) },
          { label: "Vex fee", value: vexFeeText(entry) },
        ]
      : entry.activityKind === "bridge"
        ? [
            // The sent amount and the route are the title (Cloud's BridgeCard).
            { label: "Received", value: legText(entry, entry.output) },
            { label: "Value (USD)", value: usdEstText(entry.input.usdEst) },
            { label: "Vex fee", value: vexFeeText(entry) },
          ]
        : [
            { label: "Sell", value: legText(entry, entry.input) },
            { label: "Value (USD)", value: usdEstText(entry.input.usdEst) },
            { label: "Received", value: legText(entry, entry.output) },
            { label: "Vex fee", value: vexFeeText(entry) },
          ];
  return rows.filter((row): row is ReceiptRow => row.value !== null);
}

/**
 * The title line: a swap's pair, a transfer's amount, a bridge's route
 * ("200 USDC · Base", the arrow, "USDC · Arbitrum"), each from the entry
 * alone; the place word follows where the title does not name it.
 */
function ReceiptTitle({
  entry,
  chain,
}: {
  readonly entry: AgentScanActivityEntry;
  readonly chain: string | null;
}): JSX.Element {
  if (entry.activityKind === "transfer") {
    return (
      <p className="vex-receipt__title">
        <span className="vex-receipt__pair">{legText(entry, entry.input) ?? legSymbolText(entry.input)}</span>
        {chain !== null ? <span className="vex-receipt__where"> · {chain}</span> : null}
      </p>
    );
  }
  if (entry.activityKind === "bridge") {
    const from = routeEndName(entry.fromChain);
    const to = routeEndName(entry.toChain) ?? chain;
    const sent = legText(entry, entry.input) ?? legSymbolText(entry.input);
    return (
      <p className="vex-receipt__title">
        <span className="vex-receipt__pair">
          <span>
            {sent}
            {from !== null ? <span className="vex-receipt__where"> · {from}</span> : null}
          </span>
          <RouteArrow />
          <span>
            {legSymbolText(entry.output)}
            {to !== null ? <span className="vex-receipt__where"> · {to}</span> : null}
          </span>
        </span>
      </p>
    );
  }
  return (
    <p className="vex-receipt__title">
      <span className="vex-receipt__pair">
        {legSymbolText(entry.input)}
        <RouteArrow />
        {legSymbolText(entry.output)}
      </span>
      {chain !== null ? <span className="vex-receipt__where"> · {chain}</span> : null}
    </p>
  );
}

/** The card itself, from one confirmed swap, transfer or bridge entry. Presentational. */
export function ReceiptCard({
  entry,
}: {
  readonly entry: AgentScanActivityEntry;
}): JSX.Element {
  const chain = chainNameOf(entry);
  const clock = entryClockText(entry.createdAt);
  const rows = receiptRows(entry);
  const outcome = activityOutcome(entry);
  const kind = kindWord(entry);
  // A bridge's route is its title; its own chain is only the far end.
  const place = entry.activityKind === "bridge" ? null : chain;
  return (
    <section
      data-vex-receipt=""
      data-vex-receipt-kind={entry.activityKind}
      data-vex-receipt-status={entry.status}
      aria-label={place === null ? `${kind} receipt` : `${kind} receipt on ${place}`}
      className="vex-receipt"
    >
      <div className="vex-receipt__head">
        <div className="vex-receipt__eyebrow">
          <span className="vex-receipt__kind">
            {place === null ? kind : `${kind} · ${place}`}
          </span>
          <MainnetMark data-vex-receipt-net="" />
          {clock !== null ? (
            <span data-vex-receipt-time="" className="vex-receipt__time">
              {clock}
            </span>
          ) : null}
          <span
            data-vex-receipt-stamp=""
            className="vex-receipt__stamp bg-stamp-filled text-ink-on-stamp-filled"
          >
            <StateSquare state="done" />
            {outcome.word}
          </span>
        </div>
        <ReceiptTitle entry={entry} chain={chain} />
      </div>
      {rows.length > 0 ? (
        <dl className="vex-receipt__rows">
          {rows.map((row) => (
            <div key={row.label} data-vex-receipt-row={row.label} className="vex-receipt__row">
              <dt className="vex-field-label vex-receipt__label">{row.label}</dt>
              <dd className="vex-receipt__value">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/**
 * The receipt for one act, when the session's activity feed proves it: the
 * feed narrowed to this session (the same read and the same cache entry for
 * every receipt in the chat), searched for the act's transaction. Draws
 * nothing while the feed loads, when it fails, or when no confirmed swap
 * matches.
 */
export function ActReceipt({
  txRef,
  sessionId,
}: {
  readonly txRef: string;
  readonly sessionId: string;
}): JSX.Element | null {
  const filters = useMemo(() => ({ sessionId }), [sessionId]);
  const feed = useAgentScanInfinite(filters);
  const entry = useMemo(() => {
    const entries: AgentScanActivityEntry[] = [];
    for (const page of feed.data?.pages ?? []) {
      if (!page.ok || page.data.status !== "available") continue;
      for (const candidate of page.data.entries) {
        if (candidate.source === "agent_activity") entries.push(candidate);
      }
    }
    return receiptEntry(entries, txRef);
  }, [feed.data, txRef]);
  return entry === null ? null : <ReceiptCard entry={entry} />;
}
