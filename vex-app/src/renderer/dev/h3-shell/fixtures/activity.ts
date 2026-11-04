/**
 * ACTIVITY FIXTURES - the activity feed every harness state answers
 * (`portfolio.listAgentScan`), so Vex's console has recent activity to draw:
 * a confirmed swap, a bridge submitted and still awaiting confirmation, and a
 * transfer that failed, newest first, each in one of the three status
 * colours (docs/design/H3-DESKTOP.md section 2.2).
 *
 * FIXTURE DATA, NEVER SHOWN AS REAL. Typed by the real DTO
 * (`shared/schemas/agent-scan-feed.ts`); the hashes are plainly made up. The
 * Portfolio state answers its own feed (`fixtures/portfolio.ts`) over this
 * one.
 */

import type { AgentScanActivityEntry, AgentScanDto } from "@shared/schemas/agent-scan-feed.js";
import { isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";

const BASE = 8453;
const ARBITRUM = 42161;

const leg = (symbol: string, amount: string | null): AgentScanActivityEntry["input"] => ({
  address: null,
  symbol,
  displaySymbol: symbol,
  decimals: null,
  amountHuman: amount,
  amountRaw: null,
  executedAmountHuman: amount,
  executedAmountRaw: null,
  displayAmount: amount,
  usdEst: null,
});

const NO_LEG: AgentScanActivityEntry["input"] = {
  address: null,
  symbol: null,
  displaySymbol: null,
  decimals: null,
  amountHuman: null,
  amountRaw: null,
  executedAmountHuman: null,
  executedAmountRaw: null,
  displayAmount: null,
  usdEst: null,
};

function entry(
  id: string,
  at: number,
  over: Partial<AgentScanActivityEntry>,
): AgentScanActivityEntry {
  return {
    source: "agent_activity",
    id,
    createdAt: isoAt(at),
    activityKind: "swap",
    eventRole: "swap",
    status: "confirmed",
    protocol: null,
    chainId: BASE,
    chainFamily: "evm",
    chainSlug: "base",
    fromChain: null,
    toChain: null,
    input: NO_LEG,
    output: NO_LEG,
    amountBasis: null,
    vexFee: null,
    usdFeeEst: null,
    failureCode: null,
    failureReason: null,
    txHash: null,
    explorerUrl: null,
    providerOrderId: null,
    legs: [],
    lastCheckedAt: isoAt(at + MINUTE),
    stalledVerification: false,
    stalledReason: null,
    pendingReason: null,
    ...over,
  };
}

export const ACTIVITY_FEED: AgentScanDto = fixture("activity-feed", {
  status: "available",
  entries: [
    entry("h3-fixture-activity-swap", -40 * MINUTE, {
      protocol: "kyberswap",
      input: leg("USDC", "50"),
      output: leg("ETH", "0.0143"),
      txHash: `0x5a17${"0".repeat(56)}c0de`,
    }),
    entry("h3-fixture-activity-bridge", -2 * 60 * MINUTE, {
      activityKind: "bridge",
      eventRole: "bridge_fill_expected",
      status: "pending",
      protocol: "relay",
      fromChain: { chainId: BASE, slug: "base" },
      toChain: { chainId: ARBITRUM, slug: "arbitrum" },
      input: leg("USDC", "100"),
      output: leg("USDC", null),
      txHash: `0xb41d${"0".repeat(56)}9e11`,
      explorerUrl: `https://basescan.org/tx/0xb41d${"0".repeat(56)}9e11`,
      lastCheckedAt: isoAt(-MINUTE),
    }),
    entry("h3-fixture-activity-send", -26 * 60 * MINUTE, {
      activityKind: "transfer",
      eventRole: "wallet_transfer",
      status: "failed",
      input: leg("USDC", "25"),
      failureCode: "execution_reverted",
    }),
  ],
  nextCursor: null,
  hasMore: false,
});
