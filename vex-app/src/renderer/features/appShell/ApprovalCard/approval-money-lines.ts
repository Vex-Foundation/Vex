/**
 * THE MONEY LINES of an approval card (docs/design/R3-MINIMAL.md section 8.1,
 * item 4): You send, You receive, Minimum receipt, Fees and Network fee.
 *
 * Each line reads its own bound key when the approval carries it. A line the
 * tool did not quote reads "Not available" in muted type. Nothing is computed
 * from another figure and nothing is filled from a sample: the bridge lane,
 * for one, binds no expected output and no network fee, so those lines say so.
 * Total debit appears only when every part of it is known, and no lane binds
 * a network fee estimate today, so no card draws it yet.
 *
 * Which keys exist per tool family (the producers, read in source):
 *   - bridge: `bridgeAmount` ("1 USDC | 1000000 raw units | 6 decimals"),
 *     `fromChain`, `toChain`, `bridgeDestinationWallet`, `slippageBps`,
 *     `vexFee`;
 *   - swap: `amountIn`, `tokenIn`, `tokenOut`, `chain`, `slippageBps`,
 *     `vexFee`, and `quoteBinding` ("... | quoted 2.5 USDC | will not fill
 *     below 2.4 USDC (400 bps of the quote) | ...") where the quote lane binds
 *     one;
 *   - transfer (a wallet send): `amount`, `token`, `chain`, `to`;
 *   - a wrap: `youSend`, `youReceive`.
 * Lighter cards keep their own fact rows (`lighter-order-facts.ts` and the
 * curated rows in `ApprovalDetails`); they carry no money lines here.
 *
 * IN H3'S TABLE (docs/design/H3-DESKTOP.md Appendix A.7) these lines are the
 * card's field rows, their labels set in mono caps by the field-label
 * register; the labels stay sentence case here. Where H3's rows differ:
 * "You send" is H3's AMOUNT TO SWAP as signed, never an editable field;
 * "Minimum receipt" carries the slippage limit in its note in place of
 * H3's SLIPPAGE LIMIT; and H3's FROM wallet, QUOTED PRICE and limits line
 * have no line here at all, because the approval binds none of them (section
 * 4.1). The look changed in the H3 slice; what a line reads did not.
 *
 * THE FEE ROWS ARE CLOUD'S (the money gaps sheet, DG5-06). A swap and a
 * bridge carry two: "Fees", Vex's fee as the engine states it, and "Network
 * fee", which no lane binds, so it reads "Not available". A transfer has no
 * Vex fee, so its one "Fees" row IS the network fee and reads "Not
 * available"; a second row would say the same unknown twice. Should a
 * transfer ever state a Vex fee, it takes the swap's two rows rather than
 * calling that fee a network fee.
 *
 * Pure: no React, no IO.
 */

import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import {
  addressIn,
  approvalFamily,
  argText,
  chainName,
  firstSegment,
  shortAddress,
} from "./approval-sentence.js";

/** The word a missing money value reads (owner decision: the web app's word). */
export const MONEY_NOT_AVAILABLE = "Not available";

/** One part of a money line's value: a figure in mono, a word, or a muted note. */
export type MoneyPart =
  | { readonly kind: "figure"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "missing" };

export interface MoneyLine {
  readonly label: string;
  readonly parts: readonly MoneyPart[];
}

type Args = NonNullable<ApprovalSummaryDto["preview"]>["criticalArgs"];

const figure = (text: string): MoneyPart => ({ kind: "figure", text });
const text = (value: string): MoneyPart => ({ kind: "text", text: value });
const note = (value: string): MoneyPart => ({ kind: "note", text: value });
const MISSING: MoneyPart = { kind: "missing" };

/** "50 bps" as the percentage a person reads: "0.5%". */
function bpsAsPercent(bps: string | null): string | null {
  if (bps === null || !/^\d+(\.\d+)?$/.test(bps)) return null;
  const percent = Number(bps) / 100;
  return `${String(Number(percent.toFixed(4)))}%`;
}

interface VexFee {
  readonly amount: string | null;
  readonly percent: string | null;
  readonly none: boolean;
}

/**
 * The Vex fee as the engine states it ("Vex fee 0.25% (25 bps): 0.0025 USDC |
 * 2500 raw units | ...", or "Vex fee: none on this swap (...)"). Only the
 * amount and the rate are lifted; the full statement stays in the signed
 * fields. An unreadable statement yields `null`, never a guess.
 */
export function parseVexFee(value: string | null): VexFee | null {
  if (value === null) return null;
  if (/^Vex fee:?\s*none\b/i.test(value) || /^none\b/i.test(value)) {
    return { amount: null, percent: null, none: true };
  }
  const rated = /^Vex fee\s+([\d.]+%)\s*\([^)]*\):\s*([^|;,]+?)\s*(?:\||;|,|\.(?=\s|$)|$)/i.exec(value);
  if (rated === null) return null;
  return { amount: rated[2]?.trim() ?? null, percent: rated[1] ?? null, none: false };
}

interface QuoteTerms {
  readonly quoted: string | null;
  readonly minimum: string | null;
}

/** The quoted and the minimum output, read from a bound quote ("quoted X", "will not fill below Y"). */
export function parseQuoteBinding(value: string | null): QuoteTerms | null {
  if (value === null) return null;
  const segments = value.split("|").map((segment) => segment.trim());
  const quoted = segments.find((segment) => /^quoted\s/i.test(segment))?.replace(/^quoted\s+/i, "") ?? null;
  const floor = segments.find((segment) => /^will not fill below\s/i.test(segment)) ?? null;
  const minimum = floor === null ? null : floor.replace(/^will not fill below\s+/i, "").replace(/\s*\(.*\)\s*$/, "");
  if (quoted === null && minimum === null) return null;
  return { quoted, minimum };
}

function slippageNote(args: Args): MoneyPart | null {
  const percent = bpsAsPercent(argText(args, "slippageBps"));
  return percent === null ? null : note(`· slippage limit ${percent}`);
}

/** The two fee rows' labels, Cloud's words ("Network fee" is DRAFT there, G6). */
export const FEES_LABEL = "Fees";
export const NETWORK_FEE_LABEL = "Network fee";

/** "Fees": Vex's fee as the engine states it, or "Not available" where it states none readable. */
function vexFeeLine(fee: VexFee | null): MoneyLine {
  if (fee === null) return { label: FEES_LABEL, parts: [MISSING] };
  if (fee.none) return { label: FEES_LABEL, parts: [text("No Vex fee")] };
  const parts: MoneyPart[] = [text("Vex fee"), fee.amount === null ? MISSING : figure(fee.amount)];
  if (fee.percent !== null) parts.push(note(`(${fee.percent})`));
  return { label: FEES_LABEL, parts };
}

/** "Network fee": no money lane on this card binds a network fee estimate. */
const NETWORK_FEE_LINE: MoneyLine = { label: NETWORK_FEE_LABEL, parts: [MISSING] };

/** A swap's and a bridge's fee rows: Vex's fee, then the network fee. */
function feeLines(args: Args): MoneyLine[] {
  return [vexFeeLine(parseVexFee(argText(args, "vexFee"))), NETWORK_FEE_LINE];
}

/**
 * A transfer's fee row: its "Fees" is the network fee, which no lane binds
 * (DG5-06). A transfer that states a Vex fee takes the swap's two rows.
 */
function transferFeeLines(args: Args): MoneyLine[] {
  const fee = parseVexFee(argText(args, "vexFee"));
  if (fee !== null) return [vexFeeLine(fee), NETWORK_FEE_LINE];
  return [{ label: FEES_LABEL, parts: [MISSING] }];
}

function withNote(parts: MoneyPart[], extra: MoneyPart | null): MoneyPart[] {
  if (extra !== null) parts.push(extra);
  return parts;
}

function bridgeLines(args: Args): MoneyLine[] {
  const amount = firstSegment(argText(args, "bridgeAmount"));
  const from = chainName(argText(args, "fromChain"));
  const to = chainName(argText(args, "toChain"));
  const destination = addressIn(argText(args, "bridgeDestinationWallet"));
  const receiveNote = [to === null ? null : `on ${to}`, destination === null ? null : `to ${shortAddress(destination)}`]
    .filter((part): part is string => part !== null)
    .join(", ");
  return [
    {
      label: "You send",
      parts: withNote([amount === null ? MISSING : figure(amount)], from === null ? null : note(`· on ${from}`)),
    },
    { label: "You receive", parts: withNote([MISSING], receiveNote.length > 0 ? note(`· ${receiveNote}`) : null) },
    { label: "Minimum receipt", parts: withNote([MISSING], slippageNote(args)) },
    ...feeLines(args),
  ];
}

function swapLines(args: Args): MoneyLine[] {
  const amount = argText(args, "amountIn");
  const tokenIn = argText(args, "tokenIn");
  const chain = chainName(argText(args, "chain"));
  const quote = parseQuoteBinding(argText(args, "quoteBinding"));
  const send = amount === null ? null : tokenIn === null ? amount : `${amount} ${shortAddress(tokenIn)}`;
  return [
    {
      label: "You send",
      parts: withNote([send === null ? MISSING : figure(send)], chain === null ? null : note(`· on ${chain}`)),
    },
    {
      label: "You receive",
      parts: quote === null || quote.quoted === null ? [MISSING] : [figure(quote.quoted), note("· quoted")],
    },
    {
      label: "Minimum receipt",
      parts: withNote([quote === null || quote.minimum === null ? MISSING : figure(quote.minimum)], slippageNote(args)),
    },
    ...feeLines(args),
  ];
}

function transferLines(args: Args): MoneyLine[] {
  const amount = argText(args, "amount");
  const symbol = argText(args, "token") ?? argText(args, "asset");
  const chain = chainName(argText(args, "chain"));
  const to = argText(args, "to") ?? argText(args, "recipient");
  const send = amount === null ? null : symbol === null ? amount : `${amount} ${symbol}`;
  const sendNote = [symbol === null && amount !== null ? "native token" : null, chain === null ? null : `on ${chain}`]
    .filter((part): part is string => part !== null)
    .join(", ");
  const lines: MoneyLine[] = [
    {
      label: "You send",
      parts: withNote([send === null ? MISSING : figure(send)], sendNote.length > 0 ? note(`· ${sendNote}`) : null),
    },
  ];
  if (to !== null) lines.push({ label: "To", parts: [figure(to)] });
  lines.push(...transferFeeLines(args));
  return lines;
}

function wrapLines(args: Args): MoneyLine[] | null {
  const send = argText(args, "youSend");
  const receive = argText(args, "youReceive");
  if (send === null && receive === null) return null;
  return [
    { label: "You send", parts: [send === null ? MISSING : text(send)] },
    { label: "You receive", parts: [receive === null ? MISSING : text(receive)] },
  ];
}

/**
 * The money lines for a card, or `null` when the tool is not a money family
 * this card can read (its own fact rows or the signed fields carry it).
 */
export function approvalMoneyLines(summary: Pick<ApprovalSummaryDto, "toolName" | "preview">): readonly MoneyLine[] | null {
  const args = summary.preview?.criticalArgs ?? null;
  if (args === null) return null;
  // Lighter cards carry their own rows.
  if (typeof args.toolId === "string" && args.toolId.startsWith("lighter.")) return null;
  switch (approvalFamily(summary)) {
    case "bridge":
      return bridgeLines(args);
    case "swap":
      return swapLines(args);
    case "transfer":
      return transferLines(args);
    default:
      return wrapLines(args);
  }
}
