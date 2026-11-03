/**
 * THE WORDS A DECISION SHARES: the one action-word table per tool family and
 * the one way a decision's time is written. The approval card's keys and
 * sentence (`features/appShell/ApprovalCard/approval-sentence.ts`) and the
 * Needs you rows (`needs-you.ts`) both read them, so the card's button, its
 * sentence and the row that points at it can never disagree about what a tool
 * is or when it waits.
 *
 * A leaf on purpose: it imports no renderer module. The Needs you row titles
 * itself with the card's own sentence, so `needs-you.ts` imports the card's
 * sentence module; that module needs this table, and reading it from here
 * keeps the two from importing each other (a cycle would read the table
 * before it was written). `needs-you.ts` re-exports everything here, so its
 * older importers stand unchanged.
 *
 * Pure: the clock arrives as `nowMs`.
 */

import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";

// -- Approval action words ------------------------------------------------

export const APPROVAL_ACTION_WORDS = {
  bridge: "Approve bridge",
  order: "Approve order",
  swap: "Approve swap",
  transfer: "Approve transfer",
  other: "Approve",
} as const;

type ApprovalActionTarget = Pick<ApprovalPendingGlobalDto, "toolName" | "preview">;

/** Every name the approval carries for its tool, lower-cased, most specific first. */
function toolNamesOf(approval: ApprovalActionTarget): readonly string[] {
  const names: string[] = [];
  const preview = approval.preview;
  if (preview !== null) {
    const toolId = preview.criticalArgs["toolId"];
    if (typeof toolId === "string" && toolId.length > 0) names.push(toolId);
    if (preview.namespace !== undefined && preview.toolName.length > 0) {
      names.push(`${preview.namespace}.${preview.toolName}`);
    }
    names.push(preview.toolName);
  }
  if (approval.toolName !== null) names.push(approval.toolName);
  return names.map((name) => name.toLowerCase());
}

const LIGHTER_ORDER = /^lighter[.:](order|position)([.:]|$)/;
const LIGHTER_TRANSFER = /^lighter[.:](deposit|withdraw)([.:]|$)/;
const BRIDGE = /bridge/;
// The engine's mutating aliases carry no separator: `SwapExecute` and
// `SwapExecuteUniswap` are swaps, `WalletSendConfirm` is a wallet send.
const SWAP = /(^|[.:_])swap($|[.:_])|trade_execute|^swapexecute/;
const TRANSFER = /(^|[.:_])(send|transfer)($|[.:_])|^walletsendconfirm$/;

/**
 * The action-named approve word for a tool family: bridge, order (Lighter
 * orders and positions), swap, transfer; plain "Approve" for any other tool.
 * Decided from the names the approval itself carries, never from its
 * arguments, so a family is claimed only when the tool says so.
 */
export function approvalActionWord(approval: ApprovalActionTarget): string {
  const names = toolNamesOf(approval);
  const some = (pattern: RegExp): boolean => names.some((name) => pattern.test(name));
  if (some(LIGHTER_ORDER)) return APPROVAL_ACTION_WORDS.order;
  if (some(LIGHTER_TRANSFER)) return APPROVAL_ACTION_WORDS.transfer;
  if (some(BRIDGE)) return APPROVAL_ACTION_WORDS.bridge;
  if (some(SWAP)) return APPROVAL_ACTION_WORDS.swap;
  if (some(TRANSFER)) return APPROVAL_ACTION_WORDS.transfer;
  return APPROVAL_ACTION_WORDS.other;
}

// -- Time -----------------------------------------------------------------

const MONTHS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * An instant in UTC, so the same row reads the same on every machine and the
 * zone is on the line: "15:30 UTC" when it falls on today's UTC date, else
 * "Oct 12, 15:30 UTC". `null` for an unparseable value, so the line says
 * nothing rather than "Invalid Date".
 */
export function formatNeedsYouTime(iso: string, nowMs: number): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const clock = `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())} UTC`;
  const now = new Date(nowMs);
  const sameDay =
    at.getUTCFullYear() === now.getUTCFullYear() &&
    at.getUTCMonth() === now.getUTCMonth() &&
    at.getUTCDate() === now.getUTCDate();
  if (sameDay) return clock;
  const month = MONTHS[at.getUTCMonth()] ?? "";
  return `${month} ${at.getUTCDate()}, ${clock}`;
}
