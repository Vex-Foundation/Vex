/**
 * THE CONSOLE'S RECENT ACTIVITY ROWS (docs/design/H3-DESKTOP.md sections 1.5
 * and 2.2; Appendix A.3): the newest few entries of the activity feed (the
 * Agent Scan read, `vex:portfolio:listAgentScan`), each as one line, its
 * status square and its status word.
 *
 * THE WORDS ARE AGENT SCAN'S OWN, never H3's sample words:
 *
 *   - an activity row ends in `activityOutcome`'s word, the one Agent Scan
 *     shows: Confirmed (H3's FILLED: desktop knows a transaction
 *     confirmed, not an order filled), "Submitted, awaiting confirmation" or
 *     Pending (H3's RUNNING), Failed, Refunded or "Status unknown" (H3's DID
 *     NOT EXECUTE), else the row's own bounded source word;
 *   - a Lighter fill ends in Filled, the venue's word Agent Scan gives
 *     a fill (`AgentScanLighterRow`): the venue matched it and its economics
 *     are final.
 *
 * THE SQUARE IS THE STATUS's (section 2.2): status green for Confirmed and
 * Filled, status red for Failed, Refunded and "Status unknown", the muted
 * grey for a row still in flight and for a word this build does not map. The
 * word stays ink.
 *
 * THE LINE says what happened from the entry's own fields: the kind in words,
 * then the token it spent and the token it got ("Swap USDC → ETH"), each the
 * main-resolved label Agent Scan shows (`legSymbolText`); a leg that
 * names no token is left out rather than drawn as a dash. No amount: the line
 * is a pointer to the row, and Agent Scan holds the figures with their
 * honesty rules (contract C20). A fill is Agent Scan's compact line,
 * "Buy 0.0050 ETH".
 *
 * Pure: the clock arrives as `nowMs`.
 */

import {
  FEED_ACTIVITY_KINDS,
  NEUTRAL_ACTIVITY_KIND,
  type FeedActivityKind,
} from "@shared/agent-activity-vocabulary.js";
import type {
  AgentScanActivityEntry,
  AgentScanEntry,
} from "@shared/schemas/agent-scan-feed.js";
import { legSymbolText } from "../appShell/screens/agent-scan/agent-scan-display.js";
import { lighterCompactTradeText } from "../appShell/screens/agent-scan/agent-scan-lighter-display.js";
import { activityOutcome } from "../appShell/screens/agent-scan/agent-scan-outcome.js";

/** How many rows the console shows: H3 draws four. */
export const CONSOLE_ACTIVITY_ROWS = 4;

/** Which status colour the row's square takes (section 2.2). */
export type ConsoleActivityMark = "success" | "danger" | "running";

export interface ConsoleActivityRow {
  /** Stable React key: the arm and the arm's own id. */
  readonly key: string;
  /** What happened, in one line. */
  readonly title: string;
  /** The status word, Agent Scan's. */
  readonly word: string;
  readonly mark: ConsoleActivityMark;
}

/**
 * Each kind in words, sentence case: Agent Scan's kind badge, read as
 * a word (`ActivityBadge`'s labels). Total over the feed's vocabulary, so a
 * kind the engine adds is a type error here, not a blank line.
 */
const KIND_WORD: Readonly<Record<FeedActivityKind, string>> = {
  swap: "Swap",
  bridge: "Bridge",
  lend: "Lend",
  prediction: "Predict",
  wrap: "Wrap",
  yield: "Yield",
  launch: "Launch",
  claim: "Claim",
  transfer: "Transfer",
  transaction: "Transaction",
  exchange: "Exchange",
  activity: "Activity",
};

const FEED_KINDS: ReadonlySet<string> = new Set<string>(FEED_ACTIVITY_KINDS);

function kindWord(kind: string): string {
  const key = kind.trim().toLowerCase();
  return KIND_WORD[FEED_KINDS.has(key) ? (key as FeedActivityKind) : NEUTRAL_ACTIVITY_KIND];
}

/** A leg's token label, or null when the leg names none. */
function legToken(leg: AgentScanActivityEntry["input"]): string | null {
  const text = legSymbolText(leg);
  return text === "-" ? null : text;
}

/** "Swap USDC → ETH", "Transfer USDC", "Transaction". */
export function activityLine(entry: AgentScanActivityEntry): string {
  const kind = kindWord(entry.activityKind);
  const spent = legToken(entry.input);
  const got = legToken(entry.output);
  if (spent !== null && got !== null) return `${kind} ${spent} → ${got}`;
  const one = spent ?? got;
  return one === null ? kind : `${kind} ${one}`;
}

/** The square for an activity row's outcome. */
function markOf(entry: AgentScanActivityEntry, nowMs: number): { word: string; mark: ConsoleActivityMark } {
  const outcome = activityOutcome(entry, nowMs);
  if (outcome.state === "done") return { word: outcome.word, mark: "success" };
  if (outcome.state === "error" || outcome.word === "Refunded") {
    return { word: outcome.word, mark: "danger" };
  }
  return { word: outcome.word, mark: "running" };
}

/** One feed entry as a console row. */
export function consoleActivityRowOf(entry: AgentScanEntry, nowMs: number): ConsoleActivityRow {
  if (entry.source === "lighter_fill") {
    return {
      key: `lighter_fill:${entry.id}`,
      title: lighterCompactTradeText(entry),
      word: "Filled",
      mark: "success",
    };
  }
  return { key: `agent_activity:${entry.id}`, title: activityLine(entry), ...markOf(entry, nowMs) };
}

/** The newest rows, at most `CONSOLE_ACTIVITY_ROWS`, in the feed's own order. */
export function consoleActivityRowsOf(
  entries: readonly AgentScanEntry[],
  nowMs: number,
): readonly ConsoleActivityRow[] {
  return entries.slice(0, CONSOLE_ACTIVITY_ROWS).map((entry) => consoleActivityRowOf(entry, nowMs));
}
