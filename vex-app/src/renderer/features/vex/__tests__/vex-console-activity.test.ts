/**
 * The console's recent activity rows (docs/design/H3-DESKTOP.md sections 1.5
 * and 2.2; Appendix A.3). Pins:
 *   - the status word is Agent Scan's own (`activityOutcome`), never
 *     H3's sample word: Confirmed, "Submitted, awaiting confirmation",
 *     Pending, Failed, Refunded, "Status unknown"; Filled for a Lighter fill;
 *   - the square's colour follows the status: green for Confirmed and Filled,
 *     red for Failed, Refunded and "Status unknown", the running grey for
 *     what is in flight and for a word this build does not map;
 *   - the line is the kind in words and the tokens the entry names, a leg
 *     that names none left out; never an amount;
 *   - at most four rows, in the feed's order.
 */

import { describe, expect, it } from "vitest";
import type { AgentScanActivityEntry, AgentScanEntry } from "@shared/schemas/agent-scan-feed.js";
import type { AgentScanLighterFillEntry } from "@shared/schemas/agent-scan-lighter-entry.js";
import {
  CONSOLE_ACTIVITY_ROWS,
  activityLine,
  consoleActivityRowOf,
  consoleActivityRowsOf,
} from "../vex-console-activity.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

const leg = (symbol: string | null): AgentScanActivityEntry["input"] => ({
  address: null,
  symbol,
  displaySymbol: symbol,
  decimals: null,
  amountHuman: symbol === null ? null : "1",
  amountRaw: null,
  executedAmountHuman: null,
  executedAmountRaw: null,
  displayAmount: symbol === null ? null : "1",
  usdEst: null,
});

function entry(over: Partial<AgentScanActivityEntry> = {}): AgentScanActivityEntry {
  return {
    source: "agent_activity",
    id: "1",
    createdAt: "2026-11-04T11:58:00.000Z",
    activityKind: "swap",
    eventRole: "swap",
    status: "confirmed",
    protocol: null,
    chainId: 8453,
    chainFamily: "evm",
    chainSlug: "base",
    fromChain: null,
    toChain: null,
    input: leg("USDC"),
    output: leg("ETH"),
    amountBasis: null,
    vexFee: null,
    usdFeeEst: null,
    failureCode: null,
    failureReason: null,
    txHash: null,
    explorerUrl: null,
    providerOrderId: null,
    legs: [],
    lastCheckedAt: "2026-11-04T11:59:00.000Z",
    stalledVerification: false,
    stalledReason: null,
    pendingReason: null,
    ...over,
  };
}

describe("activityLine", () => {
  it("says the kind and the tokens it spent and got, never an amount", () => {
    expect(activityLine(entry())).toBe("Swap USDC → ETH");
    expect(activityLine(entry({ activityKind: "bridge", output: leg("USDC") }))).toBe(
      "Bridge USDC → USDC",
    );
  });

  it("leaves out a leg that names no token, and keeps the kind alone with none", () => {
    expect(activityLine(entry({ activityKind: "transfer", output: leg(null) }))).toBe("Transfer USDC");
    expect(activityLine(entry({ activityKind: "transaction", input: leg(null), output: leg(null) }))).toBe(
      "Transaction",
    );
  });

  it("reads a kind this build has never heard of as the neutral word", () => {
    expect(activityLine(entry({ activityKind: "teleport" }))).toBe("Activity USDC → ETH");
  });
});

describe("consoleActivityRowOf", () => {
  it("ends a confirmed row in Confirmed on the green square", () => {
    expect(consoleActivityRowOf(entry(), NOW)).toMatchObject({ word: "Confirmed", mark: "success" });
  });

  it("ends a row in flight in its in-flight word on the running square", () => {
    const sent = entry({ status: "pending", explorerUrl: "https://basescan.org/tx/0x1" });
    expect(consoleActivityRowOf(sent, NOW)).toMatchObject({
      word: "Submitted, awaiting confirmation",
      mark: "running",
    });
    expect(consoleActivityRowOf(entry({ status: "pending" }), NOW)).toMatchObject({
      word: "Pending",
      mark: "running",
    });
  });

  it("ends a row that did not execute in Failed, Refunded or Status unknown on the red square", () => {
    expect(consoleActivityRowOf(entry({ status: "failed" }), NOW)).toMatchObject({
      word: "Failed",
      mark: "danger",
    });
    expect(
      consoleActivityRowOf(entry({ status: "failed", failureCode: "bridge_refunded" }), NOW),
    ).toMatchObject({ word: "Refunded", mark: "danger" });
    expect(consoleActivityRowOf(entry({ status: "superseded_unproven" }), NOW)).toMatchObject({
      word: "Status unknown",
      mark: "danger",
    });
  });

  it("keeps a word it does not map on the running grey", () => {
    expect(consoleActivityRowOf(entry({ status: "queued_somewhere" }), NOW)).toMatchObject({
      word: "Queued somewhere",
      mark: "running",
    });
  });

  it("ends a Lighter fill in Filled, its compact trade line, on the green square", () => {
    const fill = {
      source: "lighter_fill",
      id: "77",
      side: "buy",
      baseSize: "0.0050",
      baseAsset: { symbol: "ETH" },
    } as unknown as AgentScanLighterFillEntry;
    expect(consoleActivityRowOf(fill, NOW)).toEqual({
      key: "lighter_fill:77",
      title: "Buy 0.0050 ETH",
      word: "Filled",
      mark: "success",
    });
  });
});

describe("consoleActivityRowsOf", () => {
  it("takes the newest four in the feed's order", () => {
    const entries: AgentScanEntry[] = Array.from({ length: 6 }, (_, i) => entry({ id: String(i) }));
    const rows = consoleActivityRowsOf(entries, NOW);
    expect(CONSOLE_ACTIVITY_ROWS).toBe(4);
    expect(rows.map((row) => row.key)).toEqual([
      "agent_activity:0",
      "agent_activity:1",
      "agent_activity:2",
      "agent_activity:3",
    ]);
  });
});
