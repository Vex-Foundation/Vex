/**
 * The AgentScan outbox's TWO gates, against real SQL and real rows: WHAT may be
 * reported (the eligibility predicate) and WHEN a confirmed row may be
 * (the readiness hold).
 *
 * Why real Postgres: both gates are SQL. The readiness gate in particular is a
 * hand-written mirror of `roleLegsIncomplete`, and the failure it guards against
 * is silent — a role whose arm is wrong reports an amountless confirmation, and
 * the server's single `pending -> terminal` merge window means the amounts that
 * arrive afterwards can NEVER reach it. So every amount-bearing role is
 * enumerated here, not sampled.
 *
 * Migration 078's two changes are pinned here too: the outbox status CHECK now
 * admits `superseded_unproven`, and `agent_activity.settled_block_time` exists
 * and is written only by a writer that actually read a block.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import { seedIntent, cleanupSeeded } from "../agent-scan/_fixtures.js";
import { enqueueAtCurrentGeneration, claimAtCurrentGeneration } from "./_reporting-tick.js";

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

beforeEach(async () => {
  const { execute } = await sql();
  await execute(`DELETE FROM agentscan_outbox`, []);
});

/**
 * Executions this file created OUTSIDE `seedIntent` — `createBridgeActivityIntent`
 * mints its own. Left behind they would be eligible rows in every later suite's
 * table-wide scan, which is exactly the kind of cross-file residue the shared
 * fixture's cleanup exists to prevent.
 */
const extraExecutionIds: number[] = [];

afterEach(async () => {
  const { execute } = await sql();
  await execute(`DELETE FROM agentscan_outbox`, []);
  // The vocabulary gate's marker is INSTALL state, not row state: leaving it set
  // would hand the next suite an install that has already backfilled, which is
  // exactly the cross-file residue the fixture cleanup below exists to prevent.
  await execute(`UPDATE agentscan_reporting_state SET backfill_enqueued_at = NULL WHERE id = 1`, []);
  if (extraExecutionIds.length > 0) {
    const ids = extraExecutionIds.splice(0, extraExecutionIds.length);
    await execute(`DELETE FROM agent_activity WHERE protocol_execution_id = ANY($1::bigint[])`, [ids]);
    await execute(`DELETE FROM protocol_executions WHERE id = ANY($1::bigint[])`, [ids]);
  }
  await cleanupSeeded();
});

/** Migration 049's kind/family binding: these kinds exist only on Solana. */
const SOLANA_ONLY_KINDS = new Set(["lend", "prediction"]);

const ERC20_IN = { tokenAddress: "0x" + "1".repeat(40), tokenSymbol: "USDC", tokenDecimals: 6, amountRaw: "2000000" };
const ERC20_OUT = { tokenAddress: "0x" + "2".repeat(40), tokenSymbol: "PT", tokenDecimals: 18, amountRaw: "1900000000000000000" };

/** The kinds this file drives through the generic write path. */
type SeedKind = "swap" | "lend" | "prediction" | "yield" | "launch" | "wrap" | "claim";

/**
 * The claim family spends nothing (`agent_activity_claim_family_no_input_leg`,
 * migration 102), so a claim row is seeded with its OUTPUT leg only. The
 * database refuses the swap-shaped fixture for these roles, which is the
 * constraint doing its job rather than a fixture inconvenience.
 */
const NO_INPUT_LEG_ROLES = new Set([
  "creator_fee_claim",
  "holder_reward_claim",
  "reward_distribution",
]);

/** One pending row of the given kind/role, through the real generic write path. */
async function seedPending(
  kind: SeedKind,
  eventRole: string,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const repo = await activityRepo();
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
  const event = await repo.createPendingActivityEvent({
    protocolExecutionId,
    eventIndex: 0,
    // The vocabulary under test is exactly what the predicate must accept, so
    // the roles are supplied as the domain union the repo declares.
    eventRole: eventRole as Parameters<ActivityRepo["createPendingActivityEvent"]>[0]["eventRole"],
    kind,
    protocol: SOLANA_ONLY_KINDS.has(kind) ? "jupiter" : "kyberswap",
    // Migration 049 binds `lend`/`prediction` to Solana's own chain id.
    chainId: SOLANA_ONLY_KINDS.has(kind) ? 20011000000 : 8453,
    chainFamily: SOLANA_ONLY_KINDS.has(kind) ? "solana" : "eip155",
    walletAddress,
    sessionId,
    ...(NO_INPUT_LEG_ROLES.has(eventRole) ? {} : { tokenIn: ERC20_IN }),
    tokenOut: ERC20_OUT,
    ...extra,
  });
  return event.id;
}

/**
 * Put the reporting state where a normal install sits AFTER its one-time
 * backfill for the widened vocabulary has run: version 2, marker present.
 *
 * Every incremental scan below assumes that state, because that is the steady
 * state; the gate itself - what an incremental scan may do BEFORE the marker -
 * has its own suite in `vocabulary-backfill-gate.int.test.ts`.
 */
async function markVocabularyBackfillComplete(): Promise<void> {
  const repo = await reportingRepo();
  const state = await repo.getReportingState();
  // The one transaction that owns both halves of the marker, exactly as the
  // periodic lane calls it. The stamp it writes is the VERSION the scan covered,
  // which is what the eligibility gate reads.
  await repo.enqueueBackfillAndMark({ startedAtGeneration: state.registrationGeneration });
}

/**
 * Give a pending row the signed hash a confirmed row must carry, without the
 * broadcast stamp: staging a Solana row demands blockhash evidence neither gate
 * under test reads. The EVM nonce rides along because a signed EVM leg is
 * required to have one.
 */
async function stampSignedHash(activityId: number): Promise<void> {
  const { execute } = await sql();
  await execute(
    `UPDATE agent_activity
        SET tx_hash = $2,
            nonce = CASE WHEN chain_family = 'eip155' THEN 1 ELSE NULL END,
            from_address = CASE WHEN chain_family = 'eip155' THEN $3 ELSE NULL END
      WHERE id = $1`,
    [activityId, `0x${activityId.toString(16).padStart(64, "0")}`, "0x" + "3".repeat(40)],
  );
}

/** Drive a pending row to `confirmed` WITHOUT amounts, the way a repair sweep does. */
async function confirmStatusOnly(
  activityId: number,
  source: "receipt_status_only_evm" | "receipt_status_only_solana" = "receipt_status_only_evm",
): Promise<void> {
  const repo = await activityRepo();
  await stampSignedHash(activityId);
  const confirmed = await repo.confirmActivityEventStatusOnly(activityId, source);
  expect(confirmed.applied).toBe(true);
}

/** Test-only direct SQL: write executed columns without going through a confirm guard. */
async function setColumns(activityId: number, columns: Record<string, string | null>): Promise<void> {
  const { execute } = await sql();
  const names = Object.keys(columns);
  const sets = names.map((name, index) => `${name} = $${index + 2}`).join(", ");
  await execute(
    `UPDATE agent_activity SET ${sets} WHERE id = $1`,
    [activityId, ...names.map((name) => columns[name] ?? null)],
  );
}

/** How many rows the scan enqueued for this activity id, at whatever status it holds. */
async function enqueuedFor(activityId: number): Promise<number> {
  const repo = await reportingRepo();
  await enqueueAtCurrentGeneration(false);
  const { queryOne } = await sql();
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM agentscan_outbox WHERE activity_id = $1`,
    [activityId],
  );
  return Number(row?.count ?? 0);
}

describe("eligibility — the reportable kind/role matrix", () => {
  const REPORTABLE: readonly (readonly ["swap" | "lend" | "prediction" | "yield" | "launch", string])[] = [
    ["swap", "swap"],
    ["swap", "swap_fee"],
    ["swap", "trench_fee"],
    ["lend", "lend_deposit"],
    ["lend", "lend_withdraw"],
    ["lend", "lend_borrow_operate"],
    ["prediction", "predict_buy"],
    ["prediction", "predict_sell"],
    ["prediction", "predict_claim"],
    ["prediction", "predict_close"],
    ["yield", "yield_pt"],
    ["yield", "yield_yt"],
    ["yield", "yield_py"],
    ["yield", "yield_lp"],
    ["yield", "yield_sy"],
    ["yield", "yield_claim"],
    ["launch", "token_launch"],
    ["launch", "trench_fee"],
  ];

  for (const [kind, eventRole] of REPORTABLE) {
    it(`enqueues a pending ${kind}/${eventRole} row`, async () => {
      const id = await seedPending(kind, eventRole);
      expect(await enqueuedFor(id)).toBe(1);
    });
  }

  /**
   * Migration 102's vocabulary, arm for arm with the server's `ROLES_BY_KIND`.
   * Every one of these needs the version gate satisfied first, which is what
   * `markVocabularyBackfillComplete` establishes.
   */
  const REPORTABLE_FAMILY: readonly (readonly [SeedKind, string])[] = [
    ["claim", "pools_claim"],
    ["claim", "creator_fee_claim"],
    ["claim", "holder_reward_claim"],
    ["claim", "reward_distribution"],
    ["launch", "launch_cancel"],
    ["swap", "vex_fee"],
    ["launch", "vex_fee"],
  ];

  for (const [kind, eventRole] of REPORTABLE_FAMILY) {
    it(`enqueues a pending ${kind}/${eventRole} row once the vocabulary backfill is marked`, async () => {
      await markVocabularyBackfillComplete();
      const id = await seedPending(kind, eventRole);
      expect(await enqueuedFor(id)).toBe(1);
    });
  }

  const NEVER_REPORTABLE: readonly (readonly ["swap" | "yield" | "launch" | "wrap", string])[] = [
    ["swap", "allowance"],
    ["swap", "allowance_reset"],
    ["yield", "allowance"],
    ["launch", "allowance"],
    ["wrap", "wrap"],
    ["wrap", "unwrap"],
  ];

  for (const [kind, eventRole] of NEVER_REPORTABLE) {
    it(`never enqueues ${kind}/${eventRole}`, async () => {
      const id = await seedPending(kind, eventRole);
      expect(await enqueuedFor(id)).toBe(0);
    });
  }

  it("enqueues the bridge family's Vex-signed and logical rows, but not its approval leg", async () => {
    const repo = await activityRepo();
    const { sessionId, walletAddress } = await seedIntent("khalani.bridge");
    const created = await repo.createBridgeActivityIntent({
      toolId: "khalani.bridge",
      namespace: "khalani",
      protocol: "khalani",
      intentParams: { marker: sessionId },
      walletAddress,
      sessionId,
      route: {
        fromChainId: 8453, fromChainSlug: "base", fromChainFamily: "eip155", fromToken: "0xusdc",
        toChainId: 42161, toChainSlug: "arbitrum", toChainFamily: "eip155", toToken: "0xusdce",
      },
      legs: [
        { eventIndex: 0, eventRole: "allowance", chainId: 8453, chainSlug: "base", chainFamily: "eip155", tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" } },
        { eventIndex: 1, eventRole: "bridge_deposit", chainId: 8453, chainSlug: "base", chainFamily: "eip155", tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" } },
        { eventIndex: 2, eventRole: "bridge_fee", chainId: 8453, chainSlug: "base", chainFamily: "eip155", tokenIn: { tokenSymbol: "USDC", amountRaw: "5000" } },
      ],
      expectedFill: {
        eventIndex: 3,
        chainId: 42161, chainSlug: "arbitrum", chainFamily: "eip155",
        tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" },
        tokenOut: { tokenSymbol: "USDC", amountRaw: "1999000" },
      },
    });
    if (created.outcome !== "created") throw new Error("expected the bridge intent to be created");
    extraExecutionIds.push(created.executionId);

    const byRole = new Map(created.legs.map((leg) => [leg.eventRole, leg.id]));
    expect(await enqueuedFor(byRole.get("bridge_deposit") ?? -1)).toBe(1);
    expect(await enqueuedFor(byRole.get("bridge_fee") ?? -1)).toBe(1);
    expect(await enqueuedFor(created.expectedFill.id)).toBe(1);
    expect(await enqueuedFor(byRole.get("allowance") ?? -1)).toBe(0);
  });
});

describe("readiness — a confirmed row waits for the money it owes", () => {
  /**
   * Every amount-bearing role, with the executed columns that COMPLETE it, and
   * the leg that is NOT enough on its own. Arm for arm with
   * `roleLegsIncomplete`: a role whose arm is wrong here reports an amountless
   * confirmation, and the server merges `pending -> terminal` exactly once, so
   * the amounts that arrive afterwards can never reach it.
   */
  const READINESS_CASES: readonly {
    readonly kind: "swap" | "lend" | "prediction" | "yield" | "launch";
    readonly eventRole: string;
    readonly partial: Record<string, string>;
    readonly complete: Record<string, string>;
  }[] = [
    ...(["swap"] as const).map((eventRole) => ({
      kind: "swap" as const, eventRole,
      partial: { executed_amount_in_raw: "2000000" },
      complete: { executed_amount_in_raw: "2000000", executed_amount_out_raw: "1900000000000000000" },
    })),
    ...(["lend_deposit", "lend_withdraw", "lend_borrow_operate"] as const).map((eventRole) => ({
      kind: "lend" as const, eventRole,
      partial: { executed_amount_in_raw: "2000000" },
      complete: { executed_amount_in_raw: "2000000", executed_amount_out_raw: "1900000000000000000" },
    })),
    ...(["predict_buy", "predict_sell", "predict_claim", "predict_close"] as const).map((eventRole) => ({
      kind: "prediction" as const, eventRole,
      partial: { executed_amount_in_raw: "2000000" },
      complete: { executed_amount_in_raw: "2000000", executed_amount_out_raw: "1900000000000000000" },
    })),
    ...(["yield_pt", "yield_yt", "yield_sy", "yield_py", "yield_lp"] as const).map((eventRole) => ({
      kind: "yield" as const, eventRole,
      partial: { executed_amount_in_raw: "2000000" },
      complete: { executed_amount_in_raw: "2000000", executed_amount_out_raw: "1900000000000000000" },
    })),
    // Output-only: a claim spends nothing, so an executed input proves nothing
    // and demanding one would hold every claim forever.
    {
      kind: "yield", eventRole: "yield_claim",
      partial: { executed_amount_in_raw: "2000000" },
      complete: { executed_amount_out_raw: "1900000000000000000" },
    },
    {
      kind: "launch", eventRole: "token_launch",
      partial: { executed_amount_in_raw: "2000000" },
      complete: { executed_amount_in_raw: "2000000", executed_amount_out_raw: "1900000000000000000" },
    },
  ];

  for (const { kind, eventRole, partial, complete } of READINESS_CASES) {
    it(`holds a confirmed ${eventRole} until its executed legs arrive`, async () => {
      const id = await seedPending(kind, eventRole);
      // The pending pair goes out immediately: there are no amounts to wait for.
      expect(await enqueuedFor(id)).toBe(1);

      await confirmStatusOnly(
        id,
        SOLANA_ONLY_KINDS.has(kind) ? "receipt_status_only_solana" : "receipt_status_only_evm",
      );
      expect(await enqueuedFor(id)).toBe(1);

      // A partial fill is still a hold: the wrong leg, or one of two, proves
      // nothing about what the transaction moved.
      await setColumns(id, partial);
      expect(await enqueuedFor(id)).toBe(1);

      await setColumns(id, { executed_amount_in_raw: null, executed_amount_out_raw: null, ...complete });
      expect(await enqueuedFor(id)).toBe(2);
    });
  }

  for (const eventRole of ["yield_py", "yield_lp"] as const) {
    it(`holds a confirmed ${eventRole} until its SECOND leg arrives too`, async () => {
      const id = await seedPending("yield", eventRole, {
        tokenOut2: {
          tokenAddress: "0x" + "4".repeat(40), tokenSymbol: "YT",
          tokenDecimals: 18, amountRaw: "1900000000000000000",
        },
      });
      expect(await enqueuedFor(id)).toBe(1);
      await confirmStatusOnly(id);

      // First legs alone are NOT enough once the row declared a second leg.
      await setColumns(id, {
        executed_amount_in_raw: "2000000",
        executed_amount_out_raw: "1900000000000000000",
      });
      expect(await enqueuedFor(id)).toBe(1);

      await setColumns(id, { executed_amount_out2_raw: "1899000000000000000" });
      expect(await enqueuedFor(id)).toBe(2);
    });
  }

  /**
   * The SQL mirror's LEND arm, against the row shape Morpho Blue and Jupiter
   * /operate actually write: exactly ONE token populated, because a single
   * operation either sends (supply, supply_collateral, repay) or receives
   * (withdraw, withdraw_collateral, borrow). The VAULT shape of the same two
   * roles populates both tokens and is covered by READINESS_CASES above.
   * Demanding both legs held every such confirmed row for the full grace and
   * then re-swept it forever for an amount that was never coming.
   */
  for (const eventRole of ["lend_deposit", "lend_withdraw", "lend_borrow_operate"] as const) {
    for (const side of ["in", "out"] as const) {
      it(`releases a confirmed single-leg ${eventRole} once its ${side} leg is whole`, async () => {
        const id = await seedPending("lend", eventRole);
        // Strip the side this operation does not move - the shape the handler writes.
        const absent = side === "in" ? "token_out_address" : "token_in_address";
        const presentAmount = side === "in" ? "executed_amount_in_raw" : "executed_amount_out_raw";
        const absentAmount = side === "in" ? "executed_amount_out_raw" : "executed_amount_in_raw";
        await setColumns(id, { [absent]: null });
        expect(await enqueuedFor(id)).toBe(1);

        await confirmStatusOnly(id, "receipt_status_only_solana");
        expect(await enqueuedFor(id)).toBe(1);

        // The leg the row never declared must not release it either.
        await setColumns(id, { [absentAmount]: "2000000" });
        expect(await enqueuedFor(id)).toBe(1);

        await setColumns(id, { [absentAmount]: null, [presentAmount]: "2000000" });
        expect(await enqueuedFor(id)).toBe(2);
      });
    }
  }

  it("holds a confirmed bridge_deposit for its INPUT only", async () => {
    const repo = await activityRepo();
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent("khalani.bridge");
    const { execute } = await sql();
    // The generic write path bars `kind='bridge'`, so the row is created as a
    // swap leg and moved onto the bridge binding by direct SQL — the gates
    // under test read only kind/role/status/amounts.
    const leg = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "khalani", chainId: 8453, walletAddress, sessionId, tokenIn: ERC20_IN,
    });
    await execute(
      `UPDATE agent_activity
          SET kind = 'bridge', event_role = 'bridge_deposit',
              from_chain_id = 8453, from_chain_slug = 'base',
              to_chain_id = 42161, to_chain_slug = 'arbitrum'
        WHERE id = $1`,
      [leg.id],
    );
    expect(await enqueuedFor(leg.id)).toBe(1);
    await confirmStatusOnly(leg.id);
    expect(await enqueuedFor(leg.id)).toBe(1);

    // An OUTPUT never arrives on a deposit — it lands on the fill row, on the
    // destination chain. Only the input releases it.
    await setColumns(leg.id, { executed_amount_out_raw: "1999000" });
    expect(await enqueuedFor(leg.id)).toBe(1);

    await setColumns(leg.id, { executed_amount_in_raw: "2000000" });
    expect(await enqueuedFor(leg.id)).toBe(2);
  });

  it("releases a row whose decoder declined by name", async () => {
    const repo = await activityRepo();
    const id = await seedPending("swap", "swap");
    await confirmStatusOnly(id);
    expect(await enqueuedFor(id)).toBe(0);

    const declined = await repo.noteSettlementDeclined(id, "amounts_undecodable");
    expect(declined.applied).toBe(true);
    expect(await enqueuedFor(id)).toBe(1);
  });

  it("releases a row whose amounts are disputed (conflict_quarantined)", async () => {
    const id = await seedPending("swap", "swap");
    await confirmStatusOnly(id);
    expect(await enqueuedFor(id)).toBe(0);

    // The quarantine writer leaves the disputed amount columns alone, so the
    // release has to come from the provenance — and the mapper withholds the
    // executed amounts of exactly this row.
    await setColumns(id, { settlement_source: "conflict_quarantined" });
    expect(await enqueuedFor(id)).toBe(1);
  });

  it("releases a row whose grace elapsed, without waiting for it", async () => {
    const { execute } = await sql();
    const id = await seedPending("swap", "swap");
    await confirmStatusOnly(id);
    expect(await enqueuedFor(id)).toBe(0);

    // A controlled DB timestamp, not a real wait: 16 minutes is past the
    // 15-minute grace.
    await execute(
      `UPDATE agent_activity SET confirmed_at = NOW() - make_interval(mins => 16) WHERE id = $1`,
      [id],
    );
    expect(await enqueuedFor(id)).toBe(1);
  });

  it("holds nothing back on pending, failed, or superseded rows", async () => {
    const repo = await activityRepo();
    const { execute } = await sql();

    const failed = await seedPending("swap", "swap");
    await stampSignedHash(failed);
    const failResult = await repo.failActivityEvent(failed, {
      failureCode: "mined_revert",
      failureReason: "the transaction reverted on chain",
    });
    expect(failResult.applied).toBe(true);

    const superseded = await seedPending("swap", "swap");
    await execute(`UPDATE agent_activity SET status = 'superseded_unproven' WHERE id = $1`, [superseded]);

    // No amounts anywhere, and both terminal pairs go out immediately.
    expect(await enqueuedFor(failed)).toBe(1);
    expect(await enqueuedFor(superseded)).toBe(1);
  });
});

/**
 * READINESS for migration 102's family, arm for arm with `roleLegsIncomplete`
 * and with what the AgentScan server will accept.
 *
 * The stakes are the same as everywhere else in this file: the server merges
 * `pending -> terminal` exactly once, so an amount that misses its own confirmed
 * event is lost to it forever. An arm that releases too early reports a claim
 * with no payout; an arm that holds a role with no amounts to wait for holds it
 * for the whole grace and then reports it amountless anyway.
 */
describe("readiness: the launchpad family", () => {
  const CLAIM_OUT = "1900000000000000000";
  const PAIRED_OUT = "4500000";

  for (const eventRole of ["pools_claim", "creator_fee_claim", "holder_reward_claim"] as const) {
    it(`holds a confirmed ${eventRole} until its payout is proven`, async () => {
      await markVocabularyBackfillComplete();
      const id = await seedPending("claim", eventRole);
      expect(await enqueuedFor(id)).toBe(1);

      await confirmStatusOnly(id);
      expect(await enqueuedFor(id)).toBe(1);

      // An INPUT amount proves nothing here and the row could not carry one
      // anyway: a claim spends nothing.
      await setColumns(id, { executed_amount_out_raw: CLAIM_OUT });
      expect(await enqueuedFor(id)).toBe(2);
    });

    it(`holds a confirmed ${eventRole} that declared a SECOND payout until both arrive`, async () => {
      await markVocabularyBackfillComplete();
      const id = await seedPending("claim", eventRole, {
        tokenOut2: {
          tokenAddress: "0x" + "4".repeat(40),
          tokenSymbol: "USDC",
          tokenDecimals: 6,
          amountRaw: PAIRED_OUT,
        },
      });
      // The pending pair goes out first, as it does for every other role: there
      // are no amounts to wait for yet.
      expect(await enqueuedFor(id)).toBe(1);
      await confirmStatusOnly(id);

      await setColumns(id, { executed_amount_out_raw: CLAIM_OUT });
      expect(await enqueuedFor(id)).toBe(1);

      await setColumns(id, { executed_amount_out2_raw: PAIRED_OUT });
      expect(await enqueuedFor(id)).toBe(2);
    });
  }

  it("never holds a reward_distribution: the caller is paid nothing to wait for", async () => {
    await markVocabularyBackfillComplete();
    const id = await seedPending("claim", "reward_distribution");
    expect(await enqueuedFor(id)).toBe(1);

    await confirmStatusOnly(id);
    // Straight through with no amounts: requiring one would hold every honest
    // distribute for the full grace and report it amountless at the end of it.
    expect(await enqueuedFor(id)).toBe(2);
  });

  it("holds a launch_cancel that declared a refund token, and releases one that did not", async () => {
    await markVocabularyBackfillComplete();
    const withRefund = await seedPending("launch", "launch_cancel");
    expect(await enqueuedFor(withRefund)).toBe(1);
    await confirmStatusOnly(withRefund);
    expect(await enqueuedFor(withRefund)).toBe(1);
    await setColumns(withRefund, { executed_amount_out_raw: CLAIM_OUT });
    expect(await enqueuedFor(withRefund)).toBe(2);

    const withoutRefund = await seedPending("launch", "launch_cancel");
    await setColumns(withoutRefund, { token_out_address: null });
    expect(await enqueuedFor(withoutRefund)).toBe(1);
    await confirmStatusOnly(withoutRefund);
    expect(await enqueuedFor(withoutRefund)).toBe(2);
  });

  it("never holds a vex_fee leg: its one amount rides the row's own input side", async () => {
    await markVocabularyBackfillComplete();
    const id = await seedPending("swap", "vex_fee");
    expect(await enqueuedFor(id)).toBe(1);
    await confirmStatusOnly(id);
    expect(await enqueuedFor(id)).toBe(2);
  });
});

describe("migration 078 — the outbox status CHECK and the settled block time", () => {
  it("the outbox accepts a superseded_unproven pair and still rejects an unknown status", async () => {
    const { execute } = await sql();
    const id = await seedPending("swap", "swap");
    await execute(`UPDATE agent_activity SET status = 'superseded_unproven' WHERE id = $1`, [id]);
    expect(await enqueuedFor(id)).toBe(1);

    await expect(
      execute(`INSERT INTO agentscan_outbox (activity_id, status) VALUES ($1, 'invented_status')`, [id]),
    ).rejects.toThrow();
  });

  it("noteSettledBlockTime writes once, on a confirmed row only", async () => {
    const repo = await activityRepo();
    const { queryOne } = await sql();
    const id = await seedPending("swap", "swap");

    const blockTime = "2026-08-12T09:15:00.000Z";
    // A pending row has not settled, so there is no settling block to record.
    expect(await repo.noteSettledBlockTime(id, blockTime)).toBe(false);

    await confirmStatusOnly(id);
    expect(await repo.noteSettledBlockTime(id, blockTime)).toBe(true);
    // Write-once: a second reader of the same block never overwrites the first.
    expect(await repo.noteSettledBlockTime(id, "2026-08-12T09:16:00.000Z")).toBe(false);

    const row = await queryOne<{ settled_block_time: Date; confirmed_at: Date }>(
      `SELECT settled_block_time, confirmed_at FROM agent_activity WHERE id = $1`,
      [id],
    );
    expect(row?.settled_block_time?.toISOString()).toBe(blockTime);
    // The local observation clock is untouched by the block-time write.
    expect(row?.confirmed_at?.toISOString()).not.toBe(blockTime);
  });

  it("a handler confirm leaves the block time null, so the report carries no confirmation time", async () => {
    const repo = await activityRepo();
    const { queryOne } = await sql();
    const reporting = await reportingRepo();
    const { mapActivityToEvent } = await import("../../../vex-agent/agentscan/mapper.js");

    const id = await seedPending("swap", "swap");
    await stampSignedHash(id);
    const confirmed = await repo.confirmActivityEvent(id, {
      executedAmountInRaw: "2000000",
      executedAmountOutRaw: "1900000000000000000",
    });
    expect(confirmed.applied).toBe(true);

    const stored = await queryOne<Record<string, unknown>>(
      `SELECT * FROM agent_activity WHERE id = $1`,
      [id],
    );
    expect(stored?.settled_block_time).toBeNull();

    await enqueueAtCurrentGeneration(false);
    const claimed = (await claimAtCurrentGeneration()).filter((c) => c.activityId === id);
    const confirmedPair = claimed.find((c) => c.status === "confirmed");
    expect(confirmedPair?.activity).toBeTruthy();
    const event = mapActivityToEvent(confirmedPair?.activity ?? {}, { status: "confirmed" });
    expect(event.confirmedAt).toBeNull();
    expect(event.executedInRaw).toBe("2000000");
  });
});
