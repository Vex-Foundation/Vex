/**
 * How an Agent Scan ACTIVITY row ends: the state word, its fill and the
 * consequence under it (docs/design/R3-MINIMAL.md sections 1.6 and 9.2, and
 * the money outcome words of appendix B).
 *
 * The words say only what the row proves:
 *
 *  - `confirmed` reads "Confirmed".
 *  - `failed` reads "Failed" (a refunded bridge reads "Refunded": the funds
 *    came back, which is neither a completed bridge nor a loss).
 *  - `pending` with proof that something was sent (a transaction hash on the
 *    row or a leg, or a node that has it in its mempool) reads "Submitted,
 *    awaiting confirmation"; without that proof it keeps its source word,
 *    "Pending". "Not submitted" is never said: no row proves nothing left.
 *  - What Vex cannot currently establish reads "Status unknown": a pending
 *    row whose checks could not conclude (verification stalled), whose
 *    checks fell behind (tracking delayed), or whose nonce another
 *    transaction took (appears superseded), and a row no longer tracked as
 *    in flight (superseded). Never "Failed": nobody knows that.
 *  - Any other status keeps its own word.
 *
 * The consequence keeps the existing attention words ("in mempool",
 * "verification stalled", "tracking delayed", "appears superseded",
 * "superseded") with their full statements as titles, then the next thing
 * that happens or should ("checked again automatically", "ask Vex before
 * retrying", "ask Vex what happened"). Precedence among the pending signals is
 * unchanged: the most specific true statement wins (mempool, superseded,
 * stalled, delayed).
 */

import type { AgentScanActivityEntry } from "@shared/schemas/agent-scan-feed.js";
import { isBridgeTrackingStale } from "@shared/bridge-tracking.js";
import type { ScanOutcome, ScanOutcomeNote } from "./ScanRowParts.js";
import { timestampText } from "./agent-scan-display.js";

export const CHECKED_AGAIN = "checked again automatically";
export const ASK_BEFORE_RETRY = "ask Vex before retrying";
export const ASK_WHAT_HAPPENED = "ask Vex what happened";

/** The pending row's most specific attention signal, or null. */
export type PendingSignal =
  | "in_mempool"
  | "appears_superseded"
  | "verification_stalled"
  | "tracking_delayed"
  | null;

/** Which attention signal a pending row carries (the same precedence as before R3). */
export function pendingSignal(
  entry: AgentScanActivityEntry,
  nowMs: number = Date.now(),
): PendingSignal {
  if (entry.status !== "pending") return null;
  if (entry.pendingReason === "in_mempool") return "in_mempool";
  if (entry.pendingReason === "nonce_superseded") return "appears_superseded";
  if (entry.stalledVerification) return "verification_stalled";
  if (isBridgeTrackingStale(entry.lastCheckedAt, entry.createdAt, nowMs)) {
    return "tracking_delayed";
  }
  return null;
}

/** True when the row itself proves a transaction left: a hash on it or on a leg. */
export function hasSubmittedProof(entry: AgentScanActivityEntry): boolean {
  if (entry.explorerUrl !== null) return true;
  return entry.legs.some((leg) => leg.txHash !== null && leg.txHash.length > 0);
}

/** A raw status in sentence case, bounded: the source word for what we do not map. */
function sourceWord(status: string): string {
  const trimmed = status.trim().slice(0, 32).replace(/_/g, " ");
  if (trimmed.length === 0) return "Status unknown";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function lastCheckedPhrase(entry: AgentScanActivityEntry): string | null {
  return entry.lastCheckedAt !== null ? timestampText(entry.lastCheckedAt) : null;
}

const SUPERSEDED_TITLE =
  "Another transaction from this wallet used this one's nonce; what it did has not been checked.";

export function activityOutcome(
  entry: AgentScanActivityEntry,
  nowMs: number = Date.now(),
): ScanOutcome {
  const status = entry.status;
  if (status === "confirmed") {
    return { state: "done", word: "Confirmed", notes: [] };
  }
  if (status === "failed") {
    if (entry.failureCode === "bridge_refunded") {
      return {
        state: "idle",
        word: "Refunded",
        notes: [
          {
            text: "returned to the origin chain",
            title: "Funds returned to the origin chain - not a completed bridge",
          },
        ],
      };
    }
    return {
      state: "error",
      word: "Failed",
      notes: [{ text: ASK_WHAT_HAPPENED, title: entry.failureCode ?? undefined }],
    };
  }
  if (status === "superseded_unproven") {
    return {
      state: "error",
      word: "Status unknown",
      notes: [
        {
          text: "superseded",
          title: `${SUPERSEDED_TITLE} Vex has stopped tracking this as in flight - the outcome is unproven.`,
        },
        { text: ASK_BEFORE_RETRY },
      ],
    };
  }
  if (status === "pending") {
    const checked = lastCheckedPhrase(entry);
    const signal = pendingSignal(entry, nowMs);
    switch (signal) {
      case "in_mempool":
        return {
          state: "listening",
          word: "Submitted, awaiting confirmation",
          notes: [
            {
              text: "in mempool",
              title:
                checked !== null
                  ? `Known to a node and waiting for inclusion - last checked ${checked}. Vex re-checks this automatically.`
                  : "Known to a node and waiting for inclusion. Vex re-checks this automatically.",
            },
            { text: CHECKED_AGAIN },
          ],
        };
      case "appears_superseded":
        return {
          state: "error",
          word: "Status unknown",
          notes: [{ text: "appears superseded", title: SUPERSEDED_TITLE }, { text: ASK_BEFORE_RETRY }],
        };
      case "verification_stalled":
        return {
          state: "error",
          word: "Status unknown",
          notes: [
            {
              text: "verification stalled",
              title:
                entry.stalledReason !== null
                  ? `Repeated checks could not confirm this yet (${entry.stalledReason}). Still pending - nothing has failed.`
                  : "Repeated checks could not confirm this yet. Still pending - nothing has failed.",
            },
            { text: ASK_BEFORE_RETRY },
          ],
        };
      case "tracking_delayed":
        return {
          state: "error",
          word: "Status unknown",
          notes: [
            {
              text: "tracking delayed",
              title:
                checked !== null
                  ? `Tracking delayed - last checked ${checked}`
                  : "Tracking delayed - not yet checked since this started",
            },
            { text: CHECKED_AGAIN },
          ],
        };
      case null:
        break;
    }
    const notes: readonly ScanOutcomeNote[] = [{ text: CHECKED_AGAIN }];
    return hasSubmittedProof(entry)
      ? { state: "listening", word: "Submitted, awaiting confirmation", notes }
      : { state: "listening", word: "Pending", notes };
  }
  return { state: "idle", word: sourceWord(status), notes: [] };
}
