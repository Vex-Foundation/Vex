/**
 * THE VEX FEE ON THE FEED ROW (R1 Step 2), against a REAL Postgres.
 *
 * The owner's report: relay/khalani/uniswap/trench charge the fee as its own
 * on-chain transfer, that leg is not a feed row, and so the row the user and the
 * agent actually read showed no fee at all — while the money had demonstrably
 * left the wallet. The fixtures beside this suite
 * (`src/__tests__/tools/relay/fixtures/`, `.../khalani/fixtures/`) are his real
 * captures; the fee amount below is their byte-exact `feeAmountRaw`.
 *
 * A mocked SQL string proves none of this. The projection is a LATERAL with a
 * window function and three switching CASEs, so the only thing that establishes
 * it compiles and returns what the mappers expect is running it.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { execute } from "@vex-agent/db/client.js";

import { cleanupSeeded, seedIntent } from "./_fixtures.js";

/** The owner's real relay capture: 2_500_000_000_000 wei of ETH. */
const FEE_RAW = "2500000000000";
const FEE_HUMAN = "0.0000025";
const CHAIN_ID = 8453;

const trackedExecutions: number[] = [];

afterEach(async () => {
  await cleanupSeeded();
  if (trackedExecutions.length === 0) return;
  const ids = trackedExecutions.splice(0, trackedExecutions.length);
  await execute(`DELETE FROM agent_activity WHERE protocol_execution_id = ANY($1::bigint[])`, [ids]);
  await execute(`DELETE FROM protocol_executions WHERE id = ANY($1::bigint[])`, [ids]);
});

interface Seeded {
  readonly logicalId: number;
  readonly walletAddress: string;
  readonly sessionId: string;
}

/**
 * One bridge execution: the logical `bridge_fill_expected` row plus a
 * `bridge_fee` leg in the given status. The fee leg is deliberately NOT a feed
 * row — that is the whole problem being fixed.
 */
async function seedBridgeWithFeeLeg(
  feeStatus: "pending" | "confirmed",
  logicalStatus: "pending" | "confirmed" | "definitively_failed" = "pending",
  extraFeeLegs = 0,
): Promise<Seeded> {
  const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
  const sessionId = `vex-fee-projection-${randomUUID()}`;
  const walletAddress = `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
  const feeLeg = {
    eventRole: "bridge_fee" as const,
    chainId: CHAIN_ID,
    chainSlug: "base",
    chainFamily: "eip155" as const,
    tokenIn: {
      tokenAddress: "0x0000000000000000000000000000000000000000",
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      amountRaw: FEE_RAW,
      amountHuman: FEE_HUMAN,
    },
  };
  const result = await repo.createBridgeActivityIntent({
    toolId: "relay.bridge",
    namespace: "relay",
    protocol: "relay",
    intentParams: { marker: sessionId },
    walletAddress,
    sessionId,
    route: {
      fromChainId: CHAIN_ID,
      fromChainSlug: "base",
      fromChainFamily: "eip155",
      fromToken: "0x0000000000000000000000000000000000000000",
      toChainId: 42161,
      toChainSlug: "arbitrum",
      toChainFamily: "eip155",
      toToken: "0x0000000000000000000000000000000000000000",
    },
    legs: [
      {
        eventIndex: 0,
        eventRole: "bridge_deposit",
        chainId: CHAIN_ID,
        chainSlug: "base",
        chainFamily: "eip155",
        tokenIn: { tokenSymbol: "ETH", amountRaw: "997500000000000" },
      },
      ...Array.from({ length: extraFeeLegs + 1 }, (_, index) => ({
        ...feeLeg,
        eventIndex: index + 1,
      })),
    ],
    expectedFill: {
      eventIndex: extraFeeLegs + 2,
      chainId: 42161,
      chainSlug: "arbitrum",
      chainFamily: "eip155",
      tokenIn: { tokenSymbol: "ETH", amountRaw: "997500000000000" },
      tokenOut: { tokenSymbol: "ETH", amountRaw: "985231717592935" },
    },
  });
  if (result.outcome !== "created") throw new Error("expected a created bridge intent");
  trackedExecutions.push(result.executionId);

  // Drive the fee legs through the REAL write protocol rather than raw SQL:
  // 044/045's terminal-state CHECKs (hash + confirmed_at, an EVM signed leg's
  // nonce) are exactly what the staged-broadcast primitives exist to satisfy,
  // and a fixture that bypassed them would prove the projection works on rows
  // production can never produce.
  const feeLegs = result.legs.filter((leg) => leg.eventRole === "bridge_fee");
  let nonce = 1;
  for (const leg of feeLegs) {
    await repo.markActivityBroadcast(leg.id, {
      txHash: `0x${String(leg.id).padStart(64, "0")}`,
      fromAddress: walletAddress,
      nonce: nonce++,
    });
    if (feeStatus === "confirmed") {
      await repo.confirmActivityEvent(leg.id, {
        executedAmountInRaw: FEE_RAW,
        executedAmountInHuman: FEE_HUMAN,
      });
    }
  }
  if (logicalStatus === "confirmed") {
    await repo.confirmBridgeExpectedFill({
      executionId: result.executionId,
      txHash: `0x${String(result.expectedFill.id).padStart(64, "0")}`,
      evidenceSource: "relay_status",
      providerStatus: "success",
    });
  } else if (logicalStatus === "definitively_failed") {
    await repo.failActivityEvent(result.expectedFill.id, {
      failureCode: "bridge_failed",
      failureReason: "fixture: provider reported a terminal failure",
    });
  }

  return { logicalId: result.expectedFill.id, walletAddress, sessionId };
}

async function feedRow(seeded: Seeded): Promise<Record<string, unknown> | undefined> {
  const { getTransactions } = await import("../../../vex-agent/db/repos/transactions.js");
  const page = await getTransactions({
    addresses: [seeded.walletAddress],
    sessionId: seeded.sessionId,
    limit: 20,
  });
  return page.items.find((row) => row.id === seeded.logicalId) as Record<string, unknown> | undefined;
}

/** The owner's live launch: 0.001267 ETH in, of which 25 bps is the Vex fee leg. */
const LAUNCH_IN_RAW = "1267000000000000";
const LAUNCH_FEE_RAW = "3167500000000";
const LAUNCH_FEE_HUMAN = "0.0000031675";

interface SeededLaunch extends Seeded {
  readonly feeLegId: number;
}

/**
 * One Trench launch execution: the `token_launch` row plus its `trench_fee`
 * leg. BOTH rows carry `kind = 'launch'` (migration 063's kind↔role CHECK), and
 * that is precisely why the fee leg has to be excluded on its ROLE — a kind
 * filter cannot tell them apart.
 */
async function seedLaunchWithFeeLeg(
  launchOutcome: "confirmed" | "failed",
): Promise<SeededLaunch> {
  const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
  const intent = await seedIntent("trench.launch");
  const common = {
    protocolExecutionId: intent.protocolExecutionId,
    kind: "launch" as const,
    protocol: "trench",
    chainId: CHAIN_ID,
    chainSlug: "base",
    chainFamily: "eip155" as const,
    walletAddress: intent.walletAddress,
    sessionId: intent.sessionId,
  };
  const launch = await repo.createPendingActivityEvent({
    ...common,
    eventIndex: 0,
    eventRole: "token_launch",
    tokenIn: {
      tokenAddress: "0x0000000000000000000000000000000000000000",
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      amountRaw: LAUNCH_IN_RAW,
      amountHuman: "0.001267",
    },
  });
  const feeLeg = await repo.createPendingActivityEvent({
    ...common,
    eventIndex: 1,
    eventRole: "trench_fee",
    tokenIn: {
      tokenAddress: "0x0000000000000000000000000000000000000000",
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      amountRaw: LAUNCH_FEE_RAW,
      amountHuman: LAUNCH_FEE_HUMAN,
    },
  });

  await repo.markActivityBroadcast(feeLeg.id, {
    txHash: `0x${String(feeLeg.id).padStart(64, "1")}`,
    fromAddress: intent.walletAddress,
    nonce: 1,
  });
  await repo.confirmActivityEvent(feeLeg.id, {
    executedAmountInRaw: LAUNCH_FEE_RAW,
    executedAmountInHuman: LAUNCH_FEE_HUMAN,
  });

  await repo.markActivityBroadcast(launch.id, {
    txHash: `0x${String(launch.id).padStart(64, "2")}`,
    fromAddress: intent.walletAddress,
    nonce: 2,
  });
  if (launchOutcome === "confirmed") {
    await repo.confirmLaunchWithOutputIdentity(launch.id, {
      executedAmountInRaw: LAUNCH_IN_RAW,
      executedAmountInHuman: "0.001267",
      executedAmountOutRaw: "105721000000000000000000",
      executedAmountOutHuman: "105721",
      tokenOutAddress: "0x1234567890abcdef1234567890abcdef12345678",
      tokenOutSymbol: "PUSSY",
      tokenOutDecimals: 18,
    });
  } else {
    await repo.failActivityEvent(launch.id, {
      failureCode: "mined_revert",
      failureReason: "fixture: the create reverted on chain",
    });
  }

  return {
    logicalId: launch.id,
    feeLegId: feeLeg.id,
    walletAddress: intent.walletAddress,
    sessionId: intent.sessionId,
  };
}

async function feedRows(seeded: Seeded) {
  const { getTransactions } = await import("../../../vex-agent/db/repos/transactions.js");
  const page = await getTransactions({
    addresses: [seeded.walletAddress],
    sessionId: seeded.sessionId,
    limit: 20,
  });
  return page.items;
}

/**
 * OWNER REVISION 2026-08-05: the Vex-fee leg is not a row of its own on ANY
 * surface. The live screenshot showed "LAUNCH-FEE 0.0000031675 ETH → —" sitting
 * above the launch it was 25 bps of — one charge presented as a second action,
 * with no counterparty to show. The charge belongs to its parent's row.
 *
 * This suite proves it against REAL Postgres for the agent feed, whose
 * role-exclusion predicate the UI feed's now mirrors. The UI feed
 * (`vex-app/src/main/database/agent-scan-db-query.ts`) has no real-Postgres
 * harness in this repository; its counterpart assertions are SQL-text pins in
 * `vex-app/src/main/database/__tests__/agent-scan-db.test.ts`.
 */
describe("Vex fee — the fee leg is never its own feed row", () => {
  it("shows ONE row for a confirmed launch, carrying the fee its own leg paid", async () => {
    const seeded = await seedLaunchWithFeeLeg("confirmed");
    const rows = await feedRows(seeded);

    expect(rows.map((r) => r.id)).toEqual([seeded.logicalId]);
    expect(rows.some((r) => r.id === seeded.feeLegId)).toBe(false);
    expect(rows[0]?.vexFeeAmountRaw).toBe(LAUNCH_FEE_RAW);
    expect(rows[0]?.vexFeeAmountHuman).toBe(LAUNCH_FEE_HUMAN);
    expect(rows[0]?.vexFeeTokenSymbol).toBe("ETH");
  });

  it("keeps a CHARGED fee visible when the launch itself FAILED (A9)", async () => {
    // The fee transfer is its own confirmed transaction — the money left the
    // wallet. Now that it has no row of its own, the failed parent's row is the
    // ONLY place it can appear; if that row dropped it, a real charge would
    // become invisible.
    const seeded = await seedLaunchWithFeeLeg("failed");
    const rows = await feedRows(seeded);

    expect(rows.map((r) => r.id)).toEqual([seeded.logicalId]);
    expect(rows[0]?.status).toBe("definitively_failed");
    expect(rows[0]?.vexFeeAmountRaw).toBe(LAUNCH_FEE_RAW);
  });
});

describe("Vex fee — the separate leg reaches the logical feed row", () => {
  it("reports a CONFIRMED sibling fee leg on a row that carries no fee columns of its own", async () => {
    const seeded = await seedBridgeWithFeeLeg("confirmed");
    const row = await feedRow(seeded);

    expect(row?.vexFeeAmountRaw).toBe(FEE_RAW);
    expect(row?.vexFeeAmountHuman).toBe(FEE_HUMAN);
    expect(row?.vexFeeTokenSymbol).toBe("ETH");
    expect(row?.vexFeeTokenDecimals).toBe(18);
  });

  it("reports NOTHING while the fee leg is still pending — a planned fee is not a collected one", async () => {
    const seeded = await seedBridgeWithFeeLeg("pending");
    const row = await feedRow(seeded);

    expect(row?.vexFeeAmountRaw).toBeNull();
    expect(row?.vexFeeTokenSymbol).toBeNull();
  });

  it("keeps reporting a CONFIRMED fee after the parent bridge fails — the money did leave the wallet", async () => {
    // The fee transfer is its OWN confirmed transaction, and it necessarily
    // confirms before the fill outcome exists. Blanking it because the parent
    // later failed or refunded would deny a charge the user actually paid.
    const seeded = await seedBridgeWithFeeLeg("confirmed", "definitively_failed");
    const row = await feedRow(seeded);

    expect(row?.vexFeeAmountRaw).toBe(FEE_RAW);
  });

  it("FAILS CLOSED on two confirmed fee legs rather than reporting one and hiding the other", async () => {
    // Reporting one exact-looking fee while knowingly omitting another is a
    // money field stating less than the truth with no marker. Summing is not an
    // option until split-fee semantics are defined.
    const seeded = await seedBridgeWithFeeLeg("confirmed", "pending", 1);
    const row = await feedRow(seeded);

    expect(row?.vexFeeAmountRaw).toBeNull();
    expect(row?.vexFeeAmountHuman).toBeNull();
    expect(row?.vexFeeTokenSymbol).toBeNull();
  });

  it("never assembles a MIXED tuple — every fee field comes from the one winning source", async () => {
    const seeded = await seedBridgeWithFeeLeg("confirmed");
    const row = await feedRow(seeded);

    // All six switch on one discriminator, so either every field is populated
    // from the sibling or none is. A symbol without its amount, or an amount
    // without its decimals, must be unrepresentable.
    const populated = [
      row?.vexFeeAmountRaw,
      row?.vexFeeAmountHuman,
      row?.vexFeeTokenSymbol,
      row?.vexFeeTokenDecimals,
    ].filter((value) => value !== null && value !== undefined);
    expect(populated).toHaveLength(4);
  });
});
