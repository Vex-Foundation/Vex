/**
 * THE APPROVAL IN WORDS (docs/design/R3-MINIMAL.md section 8.1): the plain
 * sentence that titles the card, the readable risk tag, and the risk
 * sentences under the money lines. The H3 frame's own words sit here too
 * (docs/design/H3-DESKTOP.md Appendix A.7): the eyebrow that names the act
 * ("Confirm this swap") and the consequence line under the sentence.
 *
 * Built only from what the approval carries. Every part of a sentence comes
 * from a present argument; a sentence with nothing to say falls back to
 * "{tool title}: review the signed fields". Nothing is computed, guessed or
 * filled from a sample: an absent amount is left out, never a zero.
 *
 * Pure: no React, no IO. The tool family comes from the one action-word table
 * (`approvalActionWord`, features/vex/needs-you-words.ts), so the card's
 * button, the Needs you rows and this sentence can never disagree about what
 * a tool is. The Needs you rows title themselves with this sentence and name
 * the place with `approvalPlace` (docs/design/H3-DESKTOP.md Appendix A.3), so
 * this module reads the table from its leaf, never from `needs-you.ts`, which
 * imports this one.
 */

import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { chainDisplay, chainDisplayBySlug } from "@shared/chains/display.js";
import { LIGHTER_ENVIRONMENT_NAMES } from "@shared/lighter-environment-labels.js";
import { APPROVAL_ACTION_WORDS, approvalActionWord, formatNeedsYouTime } from "../../vex/needs-you-words.js";
import { resolveToolIdentity } from "../ToolLedger/toolIdentity.js";
import { lighterOrderFacts } from "./lighter-order-facts.js";
import { isHighRisk } from "./risk.js";

type ApprovalTarget = Pick<ApprovalSummaryDto, "toolName" | "preview">;
type Args = NonNullable<ApprovalSummaryDto["preview"]>["criticalArgs"];

/** The tool families of the action-word table. */
export type ApprovalFamily = keyof typeof APPROVAL_ACTION_WORDS;

const FAMILY_BY_WORD: ReadonlyMap<string, ApprovalFamily> = new Map(
  (Object.keys(APPROVAL_ACTION_WORDS) as ApprovalFamily[]).map((family) => [
    APPROVAL_ACTION_WORDS[family],
    family,
  ]),
);

/** The family the action-word table puts this tool in. */
export function approvalFamily(approval: ApprovalTarget): ApprovalFamily {
  return FAMILY_BY_WORD.get(approvalActionWord(approval)) ?? "other";
}

/** "Review bridge", "Review order", ...; plain "Review" for any other tool. */
export function approvalReviewWord(approval: ApprovalTarget): string {
  return approvalActionWord(approval).replace(/^Approve/, "Review");
}

// -- Reading the arguments ---------------------------------------------------

/** A non-empty trimmed string, or `null`. Numbers read as their decimal text. */
export function argText(args: Args | null, key: string): string | null {
  if (args === null) return null;
  const value = args[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** The first `|` segment of a bound display string: "1 USDC | 1000000 raw units" reads "1 USDC". */
export function firstSegment(value: string | null): string | null {
  if (value === null) return null;
  const head = value.split("|")[0]?.trim() ?? "";
  return head.length > 0 ? head : null;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Whether a value is a whole wallet or token address rather than a name. */
export function isAddress(value: string): boolean {
  return EVM_ADDRESS.test(value) || BASE58_ADDRESS.test(value);
}

/** An address cut to its ends for a sentence ("0x1234…5678"); any other text unchanged. */
export function shortAddress(value: string): string {
  if (!isAddress(value)) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** The first whole EVM address inside a bound display string, or `null`. */
export function addressIn(value: string | null): string | null {
  if (value === null) return null;
  const match = /0x[0-9a-fA-F]{40}/.exec(value);
  return match === null ? null : match[0];
}

/**
 * A chain's name from the value the tool was called with: a numeric chain id
 * ("8453" reads "Base") or a provider slug ("base" reads "Base"). An unknown
 * id keeps the catalogue's honest "Chain {id}"; an unknown slug keeps itself.
 */
export function chainName(value: string | null): string | null {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return chainDisplay(Number(value)).name;
  return chainDisplayBySlug(value).name;
}

/** A token as a sentence says it: the symbol as typed, an address cut short. */
function tokenWord(value: string | null): string | null {
  return value === null ? null : shortAddress(value);
}

function joinWords(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part.length > 0).join(" ");
}

/** One full stop at the end, never two. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// -- The sentence ------------------------------------------------------------

/** The tool's human title ("Bridge · Relay"), from the names the approval carries. */
export function approvalToolTitle(summary: ApprovalTarget): string {
  const args = summary.preview?.criticalArgs ?? null;
  const name = argText(args, "toolId") ?? summary.preview?.toolName ?? summary.toolName ?? "";
  return resolveToolIdentity(name, null).title;
}

function bridgeSentence(args: Args): string | null {
  const amount = firstSegment(argText(args, "bridgeAmount"));
  const from = chainName(argText(args, "fromChain"));
  const to = chainName(argText(args, "toChain"));
  if (amount === null && from === null && to === null) return null;
  return sentence(
    joinWords(["Bridge", amount, from === null ? null : `from ${from}`, to === null ? null : `to ${to}`]),
  );
}

function swapSentence(args: Args): string | null {
  const amount = argText(args, "amountIn");
  const tokenIn = tokenWord(argText(args, "tokenIn"));
  const tokenOut = tokenWord(argText(args, "tokenOut"));
  const chain = chainName(argText(args, "chain"));
  if (amount === null && tokenIn === null) return null;
  return sentence(
    joinWords([
      "Swap",
      amount,
      tokenIn,
      tokenOut === null ? null : `for ${tokenOut}`,
      chain === null ? null : `on ${chain}`,
    ]),
  );
}

function transferSentence(args: Args): string | null {
  const amount = argText(args, "amount");
  const symbol = argText(args, "token") ?? argText(args, "asset");
  const chain = chainName(argText(args, "chain"));
  const to = argText(args, "to") ?? argText(args, "recipient");
  if (amount === null && to === null) return null;
  // A send with no token names its chain's native token, which the arguments
  // do not spell: say so rather than guess a symbol.
  const what = amount === null ? null : symbol === null ? `${amount} in the native token` : `${amount} ${symbol}`;
  return sentence(
    joinWords([
      "Send",
      what,
      chain === null ? null : `on ${chain}`,
      to === null ? null : `to ${shortAddress(to)}`,
    ]),
  );
}

/** A Lighter order card's sentence: its Action row, and where a create fills. */
function lighterOrderSentence(args: Args): string | null {
  const facts = lighterOrderFacts(args);
  const action = facts?.find((fact) => fact.label === "Action")?.value ?? null;
  if (action === null) return null;
  if (args.toolId !== "lighter.order.create" || args.groupingType === "one-cancels-the-other") {
    return sentence(action);
  }
  const price = argText(args, "priceDisplay");
  const where = args.orderType === "market" ? "at market" : price === null ? null : `at ${price}`;
  return sentence(joinWords([action, where]));
}

/**
 * A call to one of the user's own MCP tools (F12): the engine marks its
 * preview with the `mcp` namespace. Nothing is signed and no wallet is
 * involved, so the card drops the real-funds stamp and says what will run.
 */
export function isUserMcpApproval(summary: Pick<ApprovalSummaryDto, "preview">): boolean {
  return summary.preview?.namespace === "mcp";
}

/** The longest summary a card will set as its title; a longer one stays a row. */
const SUMMARY_SENTENCE_MAX = 160;

/**
 * The card's title: the plain sentence (section 8.1), built only from present
 * arguments, else "{tool title}: review the signed fields".
 */
export function approvalSentence(summary: ApprovalTarget): string {
  const args = summary.preview?.criticalArgs ?? null;
  if (isUserMcpApproval(summary)) {
    const tool = argText(args, "tool");
    const server = argText(args, "server");
    if (tool !== null && server !== null) return sentence(`Call ${tool} on your MCP server ${server}`);
  }
  if (args !== null) {
    const built = (() => {
      if (typeof args.toolId === "string" && args.toolId.startsWith("lighter.")) {
        const order = lighterOrderSentence(args);
        if (order !== null) return order;
      }
      switch (approvalFamily(summary)) {
        case "bridge":
          return bridgeSentence(args);
        case "swap":
          return swapSentence(args);
        case "transfer":
          if (typeof args.toolId !== "string") return transferSentence(args);
          return null;
        default:
          return null;
      }
    })();
    if (built !== null) return built;
    // The binding's own sentence, where it wrote one: a Lighter summary
    // ("Authorize VEX trading fees"), a signed transaction's effect label.
    const own = argText(args, "summary") ?? argText(args, "effect");
    if (own !== null && own.length <= SUMMARY_SENTENCE_MAX) return sentence(own);
  }
  return `${approvalToolTitle(summary)}: review the signed fields`;
}

// -- The card's frame in words (docs/design/H3-DESKTOP.md Appendix A.7) -------

/**
 * The eyebrow over the card, by tool family: "Confirm this swap", "Confirm
 * this bridge", "Confirm this transfer", "Confirm this order", else "Confirm
 * this action". The family is the action-word table's, so the eyebrow, the
 * approve key ("Approve swap") and the Needs you row can never name one card
 * two ways. Written in sentence case; the eyebrow's style sets the caps.
 */
export const APPROVAL_EYEBROW_WORDS: Readonly<Record<ApprovalFamily, string>> = {
  bridge: "Confirm this bridge",
  order: "Confirm this order",
  swap: "Confirm this swap",
  transfer: "Confirm this transfer",
  other: "Confirm this action",
};

/** The card's eyebrow for this approval's family. */
export function approvalEyebrowWord(approval: ApprovalTarget): string {
  return APPROVAL_EYEBROW_WORDS[approvalFamily(approval)];
}

/**
 * H3's own consequence line, kept where it is true in full: a swap, a market
 * order, an immediate-or-cancel order and a position close all fill (or die)
 * the moment they are sent, so nothing is left to take back.
 */
export const CONSEQUENCE_PLACES_ORDER = "This places a real order on mainnet. It cannot be undone.";
/**
 * The same line without its second sentence, for an order that rests on the
 * book: a limit order good till its time, a post-only order, a stop-loss or
 * take-profit waiting on its trigger, an OCO pair. Each can still be
 * cancelled before it fills, so "It cannot be undone." would be false.
 */
export const CONSEQUENCE_PLACES_RESTING_ORDER = "This places a real order on mainnet.";
/** The desktop's line for a transfer and a bridge (Appendix A.7, proposed). */
export const CONSEQUENCE_SENDS_FUNDS = "This sends real funds on mainnet. It cannot be undone.";

/**
 * A position close is a reduce-only order at its worst acceptable price,
 * sent to fill at once: H3's full line holds for it.
 */
const CLOSING_TOOLS: ReadonlySet<string> = new Set(["lighter.position.close"]);
/**
 * An order create places an order; whether it can still be taken back
 * depends on its own bound terms (`placedOrderConsequence`). A cancel, a
 * modify and a cancel-all are orders too in the family table, but "places a
 * real order" would be false for them.
 */
const CREATING_TOOLS: ReadonlySet<string> = new Set(["lighter.order.create"]);

/**
 * The line for a Lighter order create, read from its bound terms: the full
 * line only when the order cannot rest on the book, which is a market order
 * or an immediate-or-cancel limit, and never an OCO pair or a trigger order
 * (both wait). Every other create, and one whose terms the approval does not
 * carry, takes the line without "It cannot be undone.": the shorter line is
 * true either way, the longer only when the terms prove it.
 */
function placedOrderConsequence(args: Args | null): string {
  const orderType = argText(args, "orderType");
  const timeInForce = argText(args, "timeInForce");
  const grouped = argText(args, "groupingType") !== null;
  const fillsAtOnce =
    !grouped &&
    (orderType === "market" || (orderType === "limit" && timeInForce === "immediate-or-cancel"));
  return fillsAtOnce ? CONSEQUENCE_PLACES_ORDER : CONSEQUENCE_PLACES_RESTING_ORDER;
}

/** Every dotted name the approval carries for its tool, lower-cased. */
function dottedToolNames(approval: ApprovalTarget): readonly string[] {
  const preview = approval.preview;
  const names = [
    argText(preview?.criticalArgs ?? null, "toolId"),
    preview !== null && preview.namespace !== undefined ? `${preview.namespace}.${preview.toolName}` : null,
    approval.toolName,
  ];
  return names
    .filter((name): name is string => name !== null && name.length > 0)
    .map((name) => name.toLowerCase().replace(/:/g, "."));
}

/**
 * The consequence line under the sentence: what pressing Approve does to real
 * funds, and that it cannot be taken back. Only where it is true for the
 * whole family, read from the same names the family is:
 *   - a swap, a Lighter position close, and a Lighter order create that
 *     fills at once (market, or immediate-or-cancel): H3's own line, "This
 *     places a real order on mainnet. It cannot be undone.";
 *   - a Lighter order create that can rest on the book (a limit good till
 *     its time, post-only, a trigger order, an OCO pair): "This places a
 *     real order on mainnet." alone, because it can still be cancelled
 *     before it fills;
 *   - a transfer (a wallet send, a Lighter deposit or withdrawal) and a
 *     bridge: "This sends real funds on mainnet. It cannot be undone.".
 * `null` for every other card, so it shows no line rather than a false one:
 * a Lighter cancel or modify places nothing, a trading-fee authorization can
 * be revoked, and a call to the user's own MCP tool signs nothing. Those
 * cards still say what they do in their sentence and their risk sentences.
 * Desktop is mainnet only, so "on mainnet" is true wherever a line shows.
 */
export function approvalConsequence(approval: ApprovalTarget): string | null {
  if (isUserMcpApproval(approval)) return null;
  switch (approvalFamily(approval)) {
    case "swap":
      return CONSEQUENCE_PLACES_ORDER;
    case "order": {
      const names = dottedToolNames(approval);
      if (names.some((name) => CLOSING_TOOLS.has(name))) return CONSEQUENCE_PLACES_ORDER;
      if (names.some((name) => CREATING_TOOLS.has(name))) {
        return placedOrderConsequence(approval.preview?.criticalArgs ?? null);
      }
      return null;
    }
    case "transfer":
    case "bridge":
      return CONSEQUENCE_SENDS_FUNDS;
    default:
      return null;
  }
}

/** The Lighter deployment a call names, by its people name ("Lighter Core"); else `null`. */
function lighterEnvironmentName(value: string | null): string | null {
  if (value === null) return null;
  const named = Object.entries(LIGHTER_ENVIRONMENT_NAMES).find(([key]) => key === value);
  return named === undefined ? null : named[1];
}

/**
 * Where the approval acts, as the Needs you row's meta line says it
 * (docs/design/H3-DESKTOP.md Appendix A.3): both ends of a bridge ("Base to
 * Arbitrum"), the Lighter deployment a Lighter call names ("Lighter Core",
 * plain "Lighter" when it names none), else the chain its arguments name
 * ("Base"). `null` when the arguments name no place, so the row says nothing
 * rather than guess one. Read only from the bound arguments, as the sentence
 * is.
 */
export function approvalPlace(summary: ApprovalTarget): string | null {
  const args = summary.preview?.criticalArgs ?? null;
  if (args === null) return null;
  if (typeof args.toolId === "string" && args.toolId.startsWith("lighter.")) {
    return lighterEnvironmentName(argText(args, "environment")) ?? "Lighter";
  }
  if (approvalFamily(summary) === "bridge") {
    const from = chainName(argText(args, "fromChain"));
    const to = chainName(argText(args, "toChain"));
    if (from !== null && to !== null) return `${from} to ${to}`;
    // A bridge acts first on the chain it leaves; with only its far end
    // named, the sentence already says "to {chain}".
    return from;
  }
  return chainName(argText(args, "chain"));
}

/**
 * The expiry as the top row says it, in UTC like every other surface that
 * names it: "Expires at 15:30 UTC" today, "Expires Oct 12, 15:30 UTC" on
 * another day; `null` for an unreadable value. The whole ISO instant stays in
 * the signed fields.
 */
export function approvalExpiryWords(expiresAt: string, nowMs: number): string | null {
  const at = formatNeedsYouTime(expiresAt, nowMs);
  if (at === null) return null;
  return /^\d/.test(at) ? `Expires at ${at}` : `Expires ${at}`;
}

// -- Risk in words -----------------------------------------------------------

/** The readable risk tag ("High risk"); the style sets it in caps. */
export function riskTagWord(riskLevel: ApprovalSummaryDto["riskLevel"]): string | null {
  switch (riskLevel) {
    case null:
      return null;
    case "info":
      return "Info";
    default:
      return `${riskLevel.charAt(0).toUpperCase()}${riskLevel.slice(1)} risk`;
  }
}

/** Whether the risk tag is the ink outline (high, critical) or the quiet one. */
export function riskTagIsInk(riskLevel: ApprovalSummaryDto["riskLevel"]): boolean {
  return riskLevel === "high" || riskLevel === "critical";
}

export interface RiskSentence {
  /** The 600 ink lead: "High risk:", "Unverified, audit unavailable:". */
  readonly lead: string;
  readonly text: string;
}

function broadcastConsequence(family: ApprovalFamily): string {
  switch (family) {
    case "bridge":
      return "real funds leave your wallet for another chain, and a sent bridge cannot be undone.";
    case "swap":
      return "real funds leave your wallet in a signed swap, and a sent swap cannot be undone.";
    case "transfer":
      return "real funds leave your wallet, and a sent transfer cannot be undone.";
    default:
      return "this signs a transaction from your own wallet, and a sent transaction cannot be undone.";
  }
}

/**
 * The lead of the second-press sentence: the rated level when it is what arms
 * the second press ("High risk:", "Critical risk:"), else the action kind that
 * does, so the lead never contradicts the risk tag beside the title.
 */
function secondPressLead(riskLevel: ApprovalSummaryDto["riskLevel"]): string {
  if (riskLevel === "high") return "High risk:";
  if (riskLevel === "critical") return "Critical risk:";
  return "Irreversible:";
}

/**
 * The plain risk sentences (section 8.1, item 5). One sentence exactly when
 * the card's two-step confirm arms (`isHighRisk`), explained by the action
 * kind; "Unverified, audit unavailable:" when the binding says no audit is on
 * record. Both explain facts the approval carries, nothing more.
 */
export function riskSentences(summary: ApprovalSummaryDto): readonly RiskSentence[] {
  const out: RiskSentence[] = [];
  if (isHighRisk(summary)) {
    const text = (() => {
      switch (summary.actionKind) {
        case "user_wallet_broadcast":
          return broadcastConsequence(approvalFamily(summary));
        case "destructive":
          return "this action cannot be undone.";
        case "external_post":
          return "this sends a request to an outside venue on your behalf, and it cannot be recalled once sent.";
        default:
          return "Approve asks for a second press before anything is sent.";
      }
    })();
    out.push({ lead: secondPressLead(summary.riskLevel), text });
  }
  const safety = argText(summary.preview?.criticalArgs ?? null, "safety");
  if (safety !== null && /unverified/i.test(safety)) {
    out.push({
      lead: "Unverified, audit unavailable:",
      text: "no audit is on record for this contract, so Vex cannot vouch for it.",
    });
  }
  return out;
}

/** The action kind in words for the signed fields' summary: "wallet broadcast". */
export function actionKindWords(actionKind: ApprovalSummaryDto["actionKind"]): string | null {
  if (actionKind === null) return null;
  if (actionKind === "user_wallet_broadcast") return "wallet broadcast";
  return actionKind.replace(/_/g, " ");
}
