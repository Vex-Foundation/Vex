/**
 * NEEDS YOU: everything that waits for a decision of the user's, as one list
 * (docs/design/R3-MINIMAL.md sections 3 and 5). One model feeds the title bar
 * panel, the Vex sidebar and the Needs you page, so the three can never count
 * differently.
 *
 * What enters the list, and what never does:
 *
 *   - every pending approval, app-wide (`usePendingApprovalsAll`), each named
 *     by its action ("Approve bridge"), where it was raised, and when it
 *     expires, or since when it has been waiting;
 *   - a mission session that needs a decision to go on: `paused_error`
 *     (Recover), `paused_plan_acceptance` (Accept the contract),
 *     `paused_user_form` (Fill in the form);
 *   - `paused_user` and `paused_wake` never count: one is the user's own pause
 *     and the other a sleep the mission ends by itself;
 *   - a cancellable Vex Inference withdrawal this app did not start (main's
 *     `withdrawalNotices` read): Review opens the funding page, where its
 *     Cancel and "It was me" keys are.
 *
 * An unreadable approvals inbox is `unknown`, never an empty list, and so is
 * a withdrawal check that failed or could not read every withdrawal. "Needs
 * you · ?" with a Retry is honest; an empty list after a failed read would be
 * a false all-clear on a surface that exists to say something waits for a
 * signature. The notices shown before a failed withdrawal check stay listed. The list never approves anything: Review opens the card, and the
 * REAL FUNDS decision stays in the approval card's own two-step flow.
 *
 * Pure: the clock arrives as `nowMs`.
 */

import type { Result } from "@shared/ipc/result.js";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { VexCloudWithdrawalNotice, VexCloudWithdrawalNoticesResult } from "@shared/schemas/vex-cloud-funding.js";
import { getSessionTitle } from "../appShell/sessionListModel.js";
import { approvalProjectDisplay } from "../appShell/approvals/approvals-copy.js";

export type NeedsYouKind = "approval" | "recover" | "contract" | "form" | "withdrawal";

export interface NeedsYouItem {
  /** Stable React key: `approval:{id}`, `mission:{sessionId}` or `withdrawal:{id}`. */
  readonly key: string;
  readonly kind: NeedsYouKind;
  /** The action, as the line's title: "Approve bridge", "Recover the mission". */
  readonly title: string;
  /**
   * The line under the title, in two parts so the time can be set as a figure:
   * where it was raised and what the time means ("Agent session · expires"),
   * then the time itself ("15:30 UTC"), `null` when there is none to give.
   * `needsYouMetaText` joins them.
   */
  readonly metaLead: string;
  readonly metaTime: string | null;
  /** What the row's key says: "Review", "Recover" or "Open". */
  readonly go: string;
  /** Where the decision was raised, by name; the page groups by it. */
  readonly where: string;
  /** Group key for the page: one per project, per session, or "background". */
  readonly groupKey: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  /** The approval's id, for an approval item; the card to open. */
  readonly approvalId: string | null;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
}

/** "loading" until the first read, "unknown" after a failed one, else "ready". */
export type NeedsYouStatus = "loading" | "ready" | "unknown";

export interface NeedsYouModel {
  readonly status: NeedsYouStatus;
  /** What could not be checked, in words, while `unknown`; else `null`. */
  readonly unknownCopy: string | null;
  /** `null` while loading or unknown: a count nobody verified is not a zero. */
  readonly count: number | null;
  /** In reading order: approvals newest first, then withdrawals this app did not start, then the missions that wait. */
  readonly items: readonly NeedsYouItem[];
}

/** The existing "could not check" copy, for the tooltip and the live region. */
export const NEEDS_YOU_UNKNOWN_COPY =
  "Couldn't check for pending approvals. Some may be waiting for your signature.";

/** The withdrawal check failed: a withdrawal this app did not start may be waiting. */
export const NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY =
  "Couldn't check for withdrawals you did not start. One may still be waiting to be cancelled.";

/** The withdrawal check stopped at its page bound with more withdrawals left. */
export const NEEDS_YOU_WITHDRAWALS_INCOMPLETE_COPY =
  "Couldn't check every withdrawal on your Vex Inference account. One you did not start may still be waiting to be cancelled.";

/** Both checks failed. */
export const NEEDS_YOU_ALL_UNKNOWN_COPY =
  "Couldn't check for pending approvals or for withdrawals you did not start. Some may be waiting for you.";

export const NEEDS_YOU_EMPTY_COPY = "Nothing needs you.";

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

// -- Items ----------------------------------------------------------------

function whereOf(row: ApprovalPendingGlobalDto): { where: string; groupKey: string } {
  if (row.projectId !== null) {
    return {
      where: approvalProjectDisplay(row.projectId, row.projectName),
      groupKey: `project:${row.projectId}`,
    };
  }
  if (row.sessionId !== null) {
    const title = row.sessionTitle?.trim() ?? "";
    return {
      where: title.length > 0 ? title : "Untitled session",
      groupKey: `session:${row.sessionId}`,
    };
  }
  return { where: "Background approval", groupKey: "background" };
}

/** The meta line as one string: "Agent session · expires 15:30 UTC". */
export function needsYouMetaText(item: Pick<NeedsYouItem, "metaLead" | "metaTime">): string {
  return item.metaTime === null ? item.metaLead : `${item.metaLead} ${item.metaTime}`;
}

/** "{where} · expires 15:30 UTC", or "{where} · since 12:05 UTC" with no expiry. */
function approvalMeta(
  row: ApprovalPendingGlobalDto,
  where: string,
  nowMs: number,
): Pick<NeedsYouItem, "metaLead" | "metaTime"> {
  const expiry = row.expiresAt === null ? null : formatNeedsYouTime(row.expiresAt, nowMs);
  if (expiry !== null) return { metaLead: `${where} · expires`, metaTime: expiry };
  const since = formatNeedsYouTime(row.createdAt, nowMs);
  return since === null
    ? { metaLead: where, metaTime: null }
    : { metaLead: `${where} · since`, metaTime: since };
}

/** One pending approval as a Needs you item. */
export function approvalNeedsYouItem(row: ApprovalPendingGlobalDto, nowMs: number): NeedsYouItem {
  const { where, groupKey } = whereOf(row);
  return {
    key: `approval:${row.id}`,
    kind: "approval",
    title: approvalActionWord(row),
    ...approvalMeta(row, where, nowMs),
    go: "Review",
    where,
    groupKey,
    sessionId: row.sessionId,
    projectId: row.projectId,
    approvalId: row.id,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

const WAITS_FOR_YOU = "the mission waits for your decision";

/**
 * A mission session that needs a decision, or `null` when its status needs
 * none. Total over the statuses: only the three named ones enter.
 */
export function missionNeedsYouItem(row: SessionListItem): NeedsYouItem | null {
  const shared = {
    where: getSessionTitle(row),
    groupKey: `session:${row.id}`,
    sessionId: row.id,
    projectId: null,
    approvalId: null,
    createdAt: null,
    expiresAt: null,
  } as const;
  const key = `mission:${row.id}`;
  switch (row.missionStatus) {
    case "paused_error":
      return {
        ...shared,
        key,
        kind: "recover",
        title: "Recover the mission",
        metaLead: `${shared.where} · paused on an error`,
        metaTime: null,
        go: "Recover",
      };
    case "paused_plan_acceptance":
      return {
        ...shared,
        key,
        kind: "contract",
        title: "Accept the contract",
        metaLead: `${shared.where} · ${WAITS_FOR_YOU}`,
        metaTime: null,
        go: "Review",
      };
    case "paused_user_form":
      return {
        ...shared,
        key,
        kind: "form",
        title: "Fill in the form",
        metaLead: `${shared.where} · ${WAITS_FOR_YOU}`,
        metaTime: null,
        go: "Open",
      };
    default:
      return null;
  }
}

/** The mission items of a sessions list, in the list's own order. */
export function missionNeedsYouItems(sessions: readonly SessionListItem[]): readonly NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const row of sessions) {
    const item = missionNeedsYouItem(row);
    if (item !== null) items.push(item);
  }
  return items;
}

/** Where a withdrawal notice was raised, and its group on the page. */
export const VEX_INFERENCE_WHERE = "Vex Inference";

/**
 * A cancellable withdrawal this app did not start, as a Needs you item:
 * "Check a withdrawal you did not start", releasing at its time. Review opens
 * the funding page; the item itself decides nothing.
 */
export function withdrawalNoticeNeedsYouItem(notice: VexCloudWithdrawalNotice, nowMs: number): NeedsYouItem {
  const at = formatNeedsYouTime(notice.releaseAt, nowMs);
  return {
    key: `withdrawal:${notice.withdrawalId}`,
    kind: "withdrawal",
    title: "Check a withdrawal you did not start",
    metaLead: at === null ? VEX_INFERENCE_WHERE : `${VEX_INFERENCE_WHERE} · releases`,
    metaTime: at,
    go: "Review",
    where: VEX_INFERENCE_WHERE,
    groupKey: "vexInference",
    sessionId: null,
    projectId: null,
    approvalId: null,
    createdAt: notice.createdAt,
    expiresAt: notice.releaseAt,
  };
}

// -- The model --------------------------------------------------------------

/**
 * The withdrawal check as Needs you sees it. Signed out claims nothing about
 * an account and is not an error. A failed read keeps the notices the last
 * good read listed (`lastKnown`): one failed read must not drop a shown
 * notice.
 */
export type NeedsYouWithdrawalRead =
  | { readonly state: "loading" }
  | { readonly state: "signed_out" }
  | { readonly state: "ready"; readonly notices: readonly VexCloudWithdrawalNotice[]; readonly complete: boolean }
  | { readonly state: "failed"; readonly lastKnown: readonly VexCloudWithdrawalNotice[] };

/**
 * The withdrawal check from the one notices query: its last answer, whether
 * the query errored (a thrown failure, not an application `Result`), and the
 * notices of the last good signed-in read.
 */
export function needsYouWithdrawalReadOf(
  data: Result<VexCloudWithdrawalNoticesResult> | undefined,
  errored: boolean,
  lastKnown: readonly VexCloudWithdrawalNotice[],
): NeedsYouWithdrawalRead {
  if (data === undefined) return errored ? { state: "failed", lastKnown } : { state: "loading" };
  if (!data.ok) return { state: "failed", lastKnown };
  // A refetch that threw: the cached answer is stale whatever it said (a cached
  // signed out can predate a sign-in). A good read's notices are the last known.
  if (errored) return { state: "failed", lastKnown: data.data.state === "signed_out" ? lastKnown : data.data.notices };
  if (data.data.state === "signed_out") return { state: "signed_out" };
  return { state: "ready", notices: data.data.notices, complete: data.data.complete };
}

export interface NeedsYouInput {
  /** The approvals inbox read; `undefined` while it has not answered. */
  readonly approvals: Result<ReadonlyArray<ApprovalPendingGlobalDto>> | undefined;
  /** The inbox query errored (a thrown failure, not an application `Result`). */
  readonly approvalsErrored: boolean;
  /** The sessions list; `null` while unread or when its read failed. */
  readonly sessions: readonly SessionListItem[] | null;
  /** The check for withdrawals this app did not start. */
  readonly withdrawals: NeedsYouWithdrawalRead;
  readonly nowMs: number;
}

function withdrawalNoticesOf(read: NeedsYouWithdrawalRead): readonly VexCloudWithdrawalNotice[] {
  switch (read.state) {
    case "ready":
      return read.notices;
    case "failed":
      return read.lastKnown;
    case "loading":
    case "signed_out":
      return [];
  }
}

/** Why the withdrawal check cannot clear, or `null` when it can. */
function withdrawalsUnknownCopy(read: NeedsYouWithdrawalRead): string | null {
  if (read.state === "failed") return NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY;
  if (read.state === "ready" && !read.complete) return NEEDS_YOU_WITHDRAWALS_INCOMPLETE_COPY;
  return null;
}

/**
 * The Needs you model. The status follows the two reads whose silence would
 * be a false all-clear: the approvals inbox and the withdrawal check.
 *
 * Approvals: a failed read is `unknown`, and a failed refetch over an earlier
 * EMPTY read is `unknown` too, since repeating that empty answer would be a
 * clear nobody verified. A failed refetch that still holds earlier rows keeps
 * them, an approval that may since have resolved being a safe overstatement.
 *
 * Withdrawals: a failed check, or one that stopped before the last
 * withdrawal (`complete: false`), is `unknown` whatever else is listed, and
 * keeps the notices already known. Every item that is known stays listed in
 * every status; only the count waits for both checks.
 */
export function needsYouModelOf(input: NeedsYouInput): NeedsYouModel {
  // Withdrawals first among the non-approval items: a release time is a deadline.
  const missions = [
    ...withdrawalNoticesOf(input.withdrawals).map((notice) => withdrawalNoticeNeedsYouItem(notice, input.nowMs)),
    ...(input.sessions === null ? [] : missionNeedsYouItems(input.sessions)),
  ];
  const data = input.approvals;
  const rows = data !== undefined && data.ok ? data.data : null;
  const approvals =
    rows === null
      ? []
      : [...rows]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((row) => approvalNeedsYouItem(row, input.nowMs));
  const items = [...approvals, ...missions];

  const approvalsUnknown =
    (data !== undefined && !data.ok) || (input.approvalsErrored && approvals.length === 0);
  const withdrawalsCopy = withdrawalsUnknownCopy(input.withdrawals);
  if (approvalsUnknown || withdrawalsCopy !== null) {
    const unknownCopy = !approvalsUnknown
      ? withdrawalsCopy
      : withdrawalsCopy === null
        ? NEEDS_YOU_UNKNOWN_COPY
        : NEEDS_YOU_ALL_UNKNOWN_COPY;
    return { status: "unknown", unknownCopy, count: null, items };
  }
  if (approvals.length > 0) return { status: "ready", unknownCopy: null, count: items.length, items };
  if (data === undefined || input.withdrawals.state === "loading") {
    return { status: "loading", unknownCopy: null, count: null, items };
  }
  return { status: "ready", unknownCopy: null, count: items.length, items };
}
