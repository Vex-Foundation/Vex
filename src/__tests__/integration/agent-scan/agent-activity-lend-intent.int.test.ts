/**
 * `agent_activity` GENERIC write path (`createAgentActivityIntent` /
 * `createAgentActivityPreBroadcastFailure`, in `./swap-intent.js`) — proves it
 * can actually create a `kind='lend'` row against the REAL migration 049
 * constraints (card K6, `w5-design.md` §3).
 *
 * `chain_family` defaults to `'eip155'` at the DB column level (migration
 * 045) and, until this card, `createPendingActivityEvent`/
 * `recordPreBroadcastFailure` had NO way to override it — every row created
 * through the generic path silently got `chain_family='eip155'`. Combined
 * with the NEW `agent_activity_kind_family_binding` CHECK (049: `kind IN
 * ('lend','prediction') => chain_family='solana' AND chain_id=20011000000`),
 * ANY `kind='lend'` row created through the (until-now swap-only) generic
 * path would have been REJECTED outright by the database. This suite proves
 * the fix (a `chainFamily` input field, now threaded into both INSERTs):
 *   - a `kind='lend'` intent event with `chainFamily:'solana'` succeeds and
 *     is stored with `chain_family='solana'`, `chain_id=20011000000`;
 *   - a `kind='lend'` intent event that OMITS `chainFamily` is REJECTED by
 *     the real CHECK (regression guard for the exact bug this card fixes);
 *   - the pre-broadcast-failure entry point behaves identically;
 *   - an ordinary EVM `kind='swap'` caller that never sets `chainFamily`
 *     (every existing Kyber/Uniswap call site) is UNCHANGED — still
 *     `chain_family='eip155'` by default.
 */
import { afterEach, describe, it, expect } from "vitest";
import { seedIntent, cleanupSeeded } from "./_fixtures.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../constants/solana-chain.js";

afterEach(async () => {
  await cleanupSeeded();
});

describe("agent_activity — generic write path threads chain_family (K6 fix, migration 049)", () => {
  it("kind='lend' + chainFamily:'solana' succeeds and stores the Solana synthetic chain id", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent("solana.lend.deposit");

    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "lend_deposit", kind: "lend",
      chainFamily: "solana",
      protocol: "jupiter", chainId: SOLANA_SYNTHETIC_CHAIN_ID, walletAddress, sessionId,
      tokenIn: { tokenAddress: "USDC_MINT", amountRaw: "1000000" },
    });

    expect(event.kind).toBe("lend");
    expect(event.chainFamily).toBe("solana");
    expect(event.chainId).toBe(SOLANA_SYNTHETIC_CHAIN_ID);
    expect(event.status).toBe("pending");
  });

  it("kind='lend' WITHOUT chainFamily is REJECTED by the real kind/family binding CHECK (regression guard)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent("solana.lend.deposit");

    await expect(
      repo.createPendingActivityEvent({
        protocolExecutionId, eventIndex: 0, eventRole: "lend_deposit", kind: "lend",
        // chainFamily omitted — defaults to 'eip155' at the column level.
        protocol: "jupiter", chainId: SOLANA_SYNTHETIC_CHAIN_ID, walletAddress, sessionId,
        tokenIn: { tokenAddress: "USDC_MINT", amountRaw: "1000000" },
      }),
    ).rejects.toThrow();
  });

  it("createAgentActivityIntent: a kind='lend' event with chainFamily:'solana' round-trips end to end", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const sessionId = `k6-lend-${Date.now()}`;
    const walletAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    const { executionId, events } = await repo.createAgentActivityIntent({
      toolId: "solana.lend.withdraw", namespace: "solana", intentParams: { asset: "USDC_MINT", amount: "500000" },
      events: [{
        eventIndex: 0, eventRole: "lend_withdraw", kind: "lend", chainFamily: "solana",
        protocol: "jupiter", chainId: SOLANA_SYNTHETIC_CHAIN_ID, walletAddress, sessionId,
        tokenOut: { tokenAddress: "USDC_MINT", amountRaw: "500000" },
      }],
    });

    expect(executionId).toBeGreaterThan(0);
    expect(events[0]!.chainFamily).toBe("solana");
    expect(events[0]!.tokenOutAddress).toBe("USDC_MINT");

    await repo.abortPlannedEvents(executionId, 0, "test cleanup — never actually signed");
  });

  it("createAgentActivityPreBroadcastFailure: kind='lend' + chainFamily:'solana' creates a hashless definitively_failed row", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const sessionId = `k6-lend-fail-${Date.now()}`;
    const walletAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    const { event } = await repo.createAgentActivityPreBroadcastFailure({
      toolId: "solana.lend.deposit", namespace: "solana", intentParams: { asset: "USDC_MINT", amount: "1000000" },
      event: {
        eventIndex: 0, eventRole: "lend_deposit", kind: "lend", chainFamily: "solana",
        protocol: "jupiter", chainId: SOLANA_SYNTHETIC_CHAIN_ID, walletAddress, sessionId,
        tokenIn: { tokenAddress: "USDC_MINT", amountRaw: "1000000" },
        failureCode: "route_not_found", failureReason: "provider rejected the deposit request",
      },
    });

    expect(event.status).toBe("definitively_failed");
    expect(event.chainFamily).toBe("solana");
    expect(event.txHash).toBeNull();
  });

  it("an EVM kind='swap' caller that never sets chainFamily is UNCHANGED — still defaults to 'eip155'", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent("kyberswap.swap.execute");

    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });

    expect(event.chainFamily).toBe("eip155");
  });
});
