/**
 * THE FILLED RECEIPT (docs/design/H3-DESKTOP.md section 1.7 and Appendix A.8;
 * H3's signed moment and its phone band draw it under the turn's thinking
 * row): a framed card for a swap that went through, from the ACTIVITY LEDGER'S
 * OWN ENTRY for it, never from the tool's output.
 *
 *   SWAP · BASE                     //// MAINNET  14:28  [CONFIRMED]
 *   USDC → ETH · Base
 *   ---------------------------------------------------------------
 *   SELL                                                   200 USDC
 *   VALUE (USD)                                       about $200.00
 *   RECEIVED                                           0.05709 ETH
 *   VEX FEE                                               0.5 USDC
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
 * entry with that SAME hash, of kind `swap`, and its status is `confirmed`.
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

/** The activity entry a receipt is drawn from, or `null` when none proves one. */
export function receiptEntry(
  entries: readonly AgentScanActivityEntry[],
  txRef: string,
): AgentScanActivityEntry | null {
  const entry = entries.find(
    (candidate) => candidate.txHash !== null && sameTransaction(candidate.txHash, txRef),
  );
  if (entry === undefined) return null;
  if (entry.activityKind !== "swap" || entry.status !== "confirmed") return null;
  return entry;
}

/** The chain the entry executed on, by name; `null` when the entry names none. */
function chainNameOf(entry: AgentScanActivityEntry): string | null {
  if (entry.chainSlug !== null && entry.chainSlug.length > 0) {
    return chainDisplayBySlug(entry.chainSlug).name;
  }
  return entry.chainId !== null ? chainDisplay(entry.chainId).name : null;
}

/** "200 USDC", marked "~" when the entry says its amounts are quoted. */
function legText(
  entry: AgentScanActivityEntry,
  leg: AgentScanActivityEntry["input"],
): string | null {
  const amount = legAmountText(leg);
  if (amount === null) return null;
  const figure = isEstimatedBasis(entry) ? `~${amount}` : amount;
  return `${figure} ${legSymbolText(leg)}`;
}

interface ReceiptRow {
  readonly label: string;
  readonly value: string;
}

function receiptRows(entry: AgentScanActivityEntry): readonly ReceiptRow[] {
  const rows: { label: string; value: string | null }[] = [
    { label: "Sell", value: legText(entry, entry.input) },
    { label: "Value (USD)", value: usdEstText(entry.input.usdEst) },
    { label: "Received", value: legText(entry, entry.output) },
    { label: "Vex fee", value: vexFeeText(entry) },
  ];
  return rows.filter((row): row is ReceiptRow => row.value !== null);
}

/** The card itself, from one confirmed swap entry. Presentational. */
export function ReceiptCard({
  entry,
}: {
  readonly entry: AgentScanActivityEntry;
}): JSX.Element {
  const chain = chainNameOf(entry);
  const clock = entryClockText(entry.createdAt);
  const rows = receiptRows(entry);
  const outcome = activityOutcome(entry);
  return (
    <section
      data-vex-receipt=""
      data-vex-receipt-status={entry.status}
      aria-label={chain === null ? "Swap receipt" : `Swap receipt on ${chain}`}
      className="vex-receipt"
    >
      <div className="vex-receipt__head">
        <div className="vex-receipt__eyebrow">
          <span className="vex-receipt__kind">
            {chain === null ? "Swap" : `Swap · ${chain}`}
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
        <p className="vex-receipt__title">
          <span className="vex-receipt__pair">
            {legSymbolText(entry.input)} → {legSymbolText(entry.output)}
          </span>
          {chain !== null ? (
            <span className="vex-receipt__where"> · {chain}</span>
          ) : null}
        </p>
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
