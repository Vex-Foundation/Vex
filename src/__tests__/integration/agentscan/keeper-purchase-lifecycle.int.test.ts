/**
 * THE TWO-TRANSACTION LAUNCH, from the moment its payout is owed to the moment
 * it is proven - against real Postgres, through the real writers, in the orders
 * the real lanes actually produce.
 *
 * `eligibility-readiness.int.test.ts` pins the readiness GATE by setting
 * `settlement_source` directly. What this file pins is how a row comes to carry
 * that column at all, which is where the lifecycle was broken:
 *
 *  - the generic status-only receipt sweep confirms a pending launch from its
 *    hash after ~90 seconds and can WIN the race against the handler's own
 *    finalizer, whose CAS requires `status = 'pending'`. The obligation was
 *    installed only by that finalizer, so the miss left `settlement_source`
 *    NULL and the reporting grace then sent a TERMINAL launch event with no
 *    payout - before the keeper had acted, and spending the server's single
 *    `pending -> terminal` merge window so the real figure could never reach it;
 *  - a launch confirmed WITH the obligation before any reporting tick ran
 *    produced no snapshot at all: the diff scan enqueues `(activity, a.status)`,
 *    the terminal half is held, and the pending half was only ever produced by a
 *    tick that ran while the row was still pending. The activity was invisible
 *    on AgentScan for the whole keeper wait.
 *
 * Real Postgres because every one of those is a CAS, a predicate or a set query.
 * The outbox is drained through the real drain with a RECORDING client, so what
 * is asserted is the event that would go on the wire rather than a row count.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import { seedIntent, cleanupSeeded } from "../agent-scan/_fixtures.js";
import { neverAskedCapabilities, neverPostedObservations } from "../../helpers/agentscan-client.js";
import { enqueueAtCurrentGeneration } from "./_reporting-tick.js";
import type {
  AgentscanClient,
  SendEventsInput,
  SendOutcome,
} from "../../../vex-agent/agentscan/client.js";
import type { AgentscanEvent } from "../../../vex-agent/agentscan/mapper.js";

type ActivityRepo = typeof import("../../../vex-agent/db/repos/agent-activity.js");
type ReportingRepo = typeof import("../../../vex-agent/db/repos/agentscan-reporting.js");

async function activityRepo(): Promise<ActivityRepo> {
  return import("@vex-agent/db/repos/agent-activity.js");
}
async function reportingRepo(): Promise<ReportingRepo> {
  return import("../../../vex-agent/db/repos/agentscan-reporting.js");
}
async function sql(): Promise<typeof import("@vex-agent/db/client.js")> {
  return import("@vex-agent/db/client.js");
}

const VIRTUAL = {
  tokenAddress: `0x${"a".repeat(40)}`,
  tokenSymbol: "VIRTUAL",
  tokenDecimals: 18,
  amountRaw: "997500000000000000",
};
const AGENT_TOKEN = `0x${"b".repeat(40)}`;
/** What `Launched.initialPurchasedAmount` proved - the tokens the launch delivered. */
const KEEPER_PURCHASE_RAW = "4210000000000000000000";

beforeEach(async () => {
  const { execute } = await sql();
  await execute(`DELETE FROM agentscan_outbox`, []);
});

afterEach(async () => {
  const { execute } = await sql();
  await execute(`DELETE FROM agentscan_outbox`, []);
  await execute(`UPDATE agentscan_reporting_state SET backfill_enqueued_at = NULL WHERE id = 1`, []);
  await cleanupSeeded();
});

/** Records every event the drain would put on the wire; answers every batch OK. */
class RecordingClient implements AgentscanClient {
  readonly events: AgentscanEvent[] = [];
  readonly fetchCapabilities = neverAskedCapabilities;
  readonly postLighterPositionObservations = neverPostedObservations;

  async sendEvents(input: SendEventsInput): Promise<SendOutcome> {
    this.events.push(...input.events);
    return { kind: "ok", accepted: input.events.length, duplicates: 0, rejectedIndexes: [], agentHealth: null };
  }
}

interface StagedLaunch {
  readonly id: number;
  readonly txHash: string;
}

/**
 * One Virtuals `preLaunch` row as the handler leaves it the instant its hash is
 * staged: pending, hash on the row, no output identity (the agent token does not
 * exist until the receipt names it).
 */
async function stageLaunch(): Promise<StagedLaunch> {
  const repo = await activityRepo();
  const { execute } = await sql();
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent("virtuals.launch.execute");
  const event = await repo.createPendingActivityEvent({
    protocolExecutionId,
    eventIndex: 0,
    eventRole: "token_launch",
    kind: "launch",
    protocol: "virtuals",
    chainId: 8453,
    chainFamily: "eip155",
    walletAddress,
    sessionId,
    tokenIn: VIRTUAL,
  });
  const txHash = `0x${event.id.toString(16).padStart(64, "0")}`;
  await execute(
    `UPDATE agent_activity SET tx_hash = $2, nonce = 1, from_address = $3 WHERE id = $1`,
    [event.id, txHash, walletAddress],
  );
  return { id: event.id, txHash };
}

/** What the handler's finalizer writes when its bounded keeper wait elapsed. */
function owedIdentity(): Parameters<ActivityRepo["confirmLaunchWithOutputIdentity"]>[1] {
  return {
    executedAmountInRaw: VIRTUAL.amountRaw,
    executedAmountOutRaw: null,
    outputPendingReason: "keeper_purchase",
    tokenOutAddress: AGENT_TOKEN,
    tokenOutSymbol: "OTAKU",
  };
}

/** One full reporting tick: the incremental diff scan, then the real drain. */
async function tick(client: RecordingClient): Promise<void> {
  const repo = await reportingRepo();
  const { drainOutbox } = await import("@vex-agent/sync/agentscan-report/drain.js");
  const state = await repo.getReportingState();
  await enqueueAtCurrentGeneration(false);
  await drainOutbox(client, "isolated-agent-hash", "isolated-ingest-token", state.registrationGeneration);
}

/** The wire events this activity produced, in the order the drain sent them. */
function eventsFor(client: RecordingClient, launch: StagedLaunch): readonly AgentscanEvent[] {
  return client.events.filter((event) => event.txHash === launch.txHash);
}

/** Age the row's confirmation past the 15-minute readiness grace. */
async function agePastGrace(id: number): Promise<void> {
  const { execute } = await sql();
  await execute(
    `UPDATE agent_activity SET confirmed_at = NOW() - make_interval(mins => 16) WHERE id = $1`,
    [id],
  );
}

async function settlementSourceOf(id: number): Promise<string | null> {
  const { queryOne } = await sql();
  const row = await queryOne<{ settlement_source: string | null }>(
    `SELECT settlement_source FROM agent_activity WHERE id = $1`,
    [id],
  );
  return row?.settlement_source ?? null;
}

describe("the keeper obligation survives every way a launch can be confirmed", () => {
  it("holds the terminal report when the STATUS-ONLY sweep confirms before the handler's finalizer", async () => {
    const repo = await activityRepo();
    const client = new RecordingClient();
    const launch = await stageLaunch();

    // The generic repair sweep proves inclusion from the hash and writes no
    // amounts - and it gets there first.
    const sweep = await repo.confirmActivityEventStatusOnly(launch.id, "receipt_status_only_evm");
    expect(sweep.applied).toBe(true);

    // The handler's own finalizer then arrives with the ONE fact nobody else
    // has: the payout is owed by the venue's keeper. Its CAS misses, because
    // the row is no longer pending - and the obligation must not miss with it.
    const finalized = await repo.confirmLaunchWithOutputIdentity(launch.id, owedIdentity());
    expect(finalized.applied).toBe(false);
    expect(await settlementSourceOf(launch.id)).toBe("keeper_purchase_pending");

    // A grace cannot bound a keeper. Past it, the row still owes its payout, so
    // NOTHING terminal may go on the wire - and the activity is still visible,
    // as the pending snapshot the server can promote later.
    await agePastGrace(launch.id);
    await tick(client);
    const held = eventsFor(client, launch);
    expect(held.map((event) => event.status)).toEqual(["pending"]);

    // The keeper sweep observes `Launched` and writes what it delivered. NOW the
    // terminal event goes, and it carries the money.
    const settled = await repo.settleLaunchKeeperPurchaseByTxHash(launch.txHash, KEEPER_PURCHASE_RAW);
    expect(settled).toBe(true);
    await tick(client);
    const all = eventsFor(client, launch);
    expect(all.map((event) => event.status)).toEqual(["pending", "confirmed"]);
    expect(all[1]?.executedOutRaw).toBe(KEEPER_PURCHASE_RAW);
    // Exactly once: the server merges `pending -> terminal` a single time and
    // silently drops a repeat, so a third tick must add nothing.
    await tick(client);
    expect(eventsFor(client, launch)).toHaveLength(2);
  });

  it("reports the PENDING snapshot when the first tick only runs AFTER the launch confirmed owing", async () => {
    const repo = await activityRepo();
    const client = new RecordingClient();
    const launch = await stageLaunch();

    // No tick ran between the row's creation and its confirmation - the ordinary
    // case for a launch that confirms inside one sync interval.
    const finalized = await repo.confirmLaunchWithOutputIdentity(launch.id, owedIdentity());
    expect(finalized.applied).toBe(true);
    expect(await settlementSourceOf(launch.id)).toBe("keeper_purchase_pending");

    // The first tick therefore has a CONFIRMED row whose terminal event is held.
    // It must still report the activity, as the pending snapshot the server
    // needs something to promote onto - otherwise the launch is invisible for
    // the whole keeper wait.
    await tick(client);
    const first = eventsFor(client, launch);
    expect(first.map((event) => event.status)).toEqual(["pending"]);
    // A pending snapshot of a confirmed row carries NO executed amounts and no
    // confirmation time: the mapper reports the snapshot, never the live row.
    expect(first[0]?.executedOutRaw).toBeNull();
    expect(first[0]?.confirmedAt).toBeNull();

    // A second tick while the payout is still owed adds nothing at all.
    await tick(client);
    expect(eventsFor(client, launch)).toHaveLength(1);

    await repo.settleLaunchKeeperPurchaseByTxHash(launch.txHash, KEEPER_PURCHASE_RAW);
    await tick(client);
    const settled = eventsFor(client, launch);
    expect(settled.map((event) => event.status)).toEqual(["pending", "confirmed"]);
    expect(settled[1]?.executedOutRaw).toBe(KEEPER_PURCHASE_RAW);
  });

  it("emits no second pending snapshot when a tick already sent one while the row was pending", async () => {
    const repo = await activityRepo();
    const client = new RecordingClient();
    const launch = await stageLaunch();

    await tick(client);
    expect(eventsFor(client, launch).map((event) => event.status)).toEqual(["pending"]);

    await repo.confirmLaunchWithOutputIdentity(launch.id, owedIdentity());
    await tick(client);
    expect(eventsFor(client, launch)).toHaveLength(1);

    await repo.concludeLaunchKeeperSettlementByTxHash(launch.txHash, "cancelled");
    await tick(client);
    const all = eventsFor(client, launch);
    expect(all.map((event) => event.status)).toEqual(["pending", "confirmed"]);
    // A cancellation proves nothing was ever delivered, which is a payout of
    // zero rather than an unknown one.
    expect(all[1]?.executedOutRaw).toBe("0");
  });
});

describe("markLaunchKeeperPurchaseOwedByTxHash", () => {
  it("establishes the obligation on a row that is still PENDING, before any confirmer can see it", async () => {
    const repo = await activityRepo();
    const launch = await stageLaunch();

    expect(await repo.markLaunchKeeperPurchaseOwedByTxHash(launch.txHash)).toBe(true);
    expect(await settlementSourceOf(launch.id)).toBe("keeper_purchase_pending");

    // The status-only sweep is explicitly not allowed to clear it: it proved
    // inclusion and learned nothing about the amounts.
    const sweep = await repo.confirmActivityEventStatusOnly(launch.id, "receipt_status_only_evm");
    expect(sweep.applied).toBe(true);
    expect(await settlementSourceOf(launch.id)).toBe("keeper_purchase_pending");
  });

  it("is idempotent, and REFUSES to reopen a settled or concluded launch", async () => {
    const repo = await activityRepo();
    const settledLaunch = await stageLaunch();

    expect(await repo.markLaunchKeeperPurchaseOwedByTxHash(settledLaunch.txHash)).toBe(true);
    // A repeat is the same fact, not a failure - the recovery sweep may run
    // after the handler already wrote it.
    expect(await repo.markLaunchKeeperPurchaseOwedByTxHash(settledLaunch.txHash)).toBe(true);

    await repo.confirmLaunchWithOutputIdentity(settledLaunch.id, owedIdentity());
    await repo.settleLaunchKeeperPurchaseByTxHash(settledLaunch.txHash, KEEPER_PURCHASE_RAW);
    expect(await repo.markLaunchKeeperPurchaseOwedByTxHash(settledLaunch.txHash)).toBe(false);
    expect(await settlementSourceOf(settledLaunch.id)).toBe("keeper_settlement_observed");

    const concluded = await stageLaunch();
    await repo.markLaunchKeeperPurchaseOwedByTxHash(concluded.txHash);
    await repo.confirmLaunchWithOutputIdentity(concluded.id, owedIdentity());
    await repo.concludeLaunchKeeperSettlementByTxHash(concluded.txHash, "amount_unreadable");
    expect(await repo.markLaunchKeeperPurchaseOwedByTxHash(concluded.txHash)).toBe(false);
    expect(await settlementSourceOf(concluded.id)).toBe("amounts_incomplete");
  });

  it("never touches a row of another role that happens to share the hash lookup", async () => {
    const repo = await activityRepo();
    const { execute } = await sql();
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const swap = await repo.createPendingActivityEvent({
      protocolExecutionId,
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: "kyberswap",
      chainId: 8453,
      chainFamily: "eip155",
      walletAddress,
      sessionId,
      tokenIn: VIRTUAL,
      tokenOut: { tokenAddress: AGENT_TOKEN, tokenSymbol: "OTAKU", tokenDecimals: 18, amountRaw: "1" },
    });
    const txHash = `0x${swap.id.toString(16).padStart(64, "0")}`;
    await execute(
      `UPDATE agent_activity SET tx_hash = $2, nonce = 1, from_address = $3 WHERE id = $1`,
      [swap.id, txHash, walletAddress],
    );

    expect(await repo.markLaunchKeeperPurchaseOwedByTxHash(txHash)).toBe(false);
    expect(await settlementSourceOf(swap.id)).toBeNull();
  });
});
