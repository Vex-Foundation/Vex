/**
 * FEE ENRICHMENT AFTER DELIVERY, AGAINST REAL POSTGRESQL.
 *
 * The defect (review round 1, gap A): `enrichLighterFillChargedFees` writes the
 * exact charged fee the provider eventually reports, and the fill's own outbox
 * row is `sent_at` and terminal by then. The fill diff scan excludes any fill
 * that already has a row - correctly, because a fill's economics are immutable
 * and a second report of it would be a duplicate - so the exact figure never
 * reached AgentScan and the read model summed estimates forever.
 *
 * The fix is an explicit enrichment row keyed on (fill, revision), and every
 * property that makes it safe is a database property: the revision is bumped
 * by the same UPDATE that proves the fee, the unique index admits one row per
 * (fill, kind, status, revision), and the CHECK constraint refuses an
 * enrichment row that names no revision or an ordinary row that names one.
 * None of that is provable against a fake client, so it is proved here.
 *
 * H0 correction 4 is what the shape has to satisfy: enrichment never
 * creates another fill and never changes established economics.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { query, queryOne } from "@vex-agent/db/client.js";
import * as reportingRepo from "@vex-agent/db/repos/agentscan-reporting.js";
import {
  enrichLighterFillChargedFees,
  lighterFillIdentity,
  recordLighterFillActivity,
  type LighterFillRecord,
} from "@vex-agent/tools/protocols/lighter/agentscan-activity.js";

const ENVIRONMENT = "core" as const;
const ACCOUNT = 743799;
const MARKET = 1;
const GENERATION = 0;

const USDC = { venueAssetId: "lighter:core:asset:0", symbol: "USDC", decimals: 6 };
const ETH = { venueAssetId: "lighter:core:asset:1", symbol: "ETH", decimals: 18 };

function fillRecord(providerTradeId: string): LighterFillRecord {
  return {
    canonicalIdentity: lighterFillIdentity({
      environment: ENVIRONMENT,
      accountIndex: ACCOUNT,
      marketIndex: MARKET,
      providerTradeId,
    }),
    environment: ENVIRONMENT,
    accountIndex: ACCOUNT,
    marketIndex: MARKET,
    providerTradeId,
    providerOrderId: "8",
    clientOrderId: "77",
    executionIntentId: "intent-1",
    marketSymbol: "ETH-USD",
    side: "buy",
    price: "2500.5",
    baseSize: "0.4",
    quoteNotional: "1000.2",
    baseAsset: ETH,
    quoteAsset: USDC,
    blockHeight: "12345",
    tradeType: "trade",
    tradedAt: "2026-09-08T09:11:56.527Z",
    transactionTimeUs: "1788858716531726",
    usdAmount: "1000.20",
    accountFacts: null,
    positionEffect: null,
    feeSide: "taker",
    integratorFeeTickAuthorized: 1000,
    integratorFeeTickObserved: 350,
    integratorFeeAsset: USDC,
    integratorFeeEstimatedRaw: "350070",
    integratorFeeEstimateBasis: "quote_notional",
    integratorFeeEstimateTickSource: "observed",
    integratorFeeChargedRaw: null,
    exchangeFeeTickObserved: 100,
    exchangeFeeChargedRaw: null,
    integratorFeeEstimatedUsd: "0.350070",
    exchangeFeeEstimatedUsd: "0.100020",
    collectorAccountIndex: 743799,
    feeAuthorizationIntentId: "fee-intent-1",
    spot: false,
  };
}

interface OutboxRow {
  readonly sourceKind: string;
  readonly revision: number | null;
  readonly sent: boolean;
}

async function outboxRows(): Promise<OutboxRow[]> {
  const rows = await query<{
    source_kind: string;
    enrichment_revision: number | null;
    sent_at: Date | null;
  }>(
    `SELECT source_kind, enrichment_revision, sent_at FROM agentscan_outbox
      ORDER BY id`,
  );
  return rows.map((row) => ({
    sourceKind: row.source_kind,
    revision: row.enrichment_revision === null ? null : Number(row.enrichment_revision),
    sent: row.sent_at !== null,
  }));
}

async function fillRevision(fillId: number): Promise<number> {
  const row = await queryOne<{ revision: number }>(
    `SELECT revision FROM lighter_fills WHERE id = $1`,
    [fillId],
  );
  return Number(row?.revision);
}

/** Record a fill, enqueue it, and mark it sent - the state gap A starts from. */
async function deliveredFill(providerTradeId = "99"): Promise<number> {
  const outcome = await recordLighterFillActivity(fillRecord(providerTradeId));
  expect(outcome.kind).toBe("recorded");
  expect(await reportingRepo.enqueueEligibleLighterFills(false, GENERATION)).toEqual({
    kind: "applied",
    rows: 1,
  });
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM agentscan_outbox WHERE lighter_fill_id = $1 AND source_kind = 'lighter_fill'`,
    [outcome.fillId],
  );
  expect(await reportingRepo.markOutboxSent([Number(row?.id)], GENERATION)).toMatchObject({
    kind: "applied",
  });
  return outcome.fillId;
}

beforeEach(async () => {
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name")).toEqual({ name: "vex_test" });
  // The singleton has to exist before it can be set: the repo creates it
  // lazily, and a scan against a missing state row enqueues nothing at all.
  await reportingRepo.getReportingState();
  await query("TRUNCATE agentscan_outbox RESTART IDENTITY");
  await query("TRUNCATE lighter_fills RESTART IDENTITY CASCADE");
  // The vocabulary gate's two halves: migration 152 stamped the database at 4,
  // and a backfill that covered 4 has completed, so the incremental scan runs.
  await query(
    `UPDATE agentscan_reporting_state
        SET vocabulary_version = 4,
            backfill_vocabulary_version = 4,
            backfill_enqueued_at = NOW(),
            registration_generation = $1
      WHERE id = 1`,
    [GENERATION],
  );
});

describe("the enrichment write", () => {
  it("bumps the revision exactly once per fee it actually proves", async () => {
    const fillId = await deliveredFill();
    expect(await fillRevision(fillId)).toBe(0);

    expect(await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    })).toBe(true);
    expect(await fillRevision(fillId)).toBe(1);

    // The same enrichment again proves nothing new: the `IS NULL` guard refuses
    // to revise an amount already proven, so no row moves and the revision
    // stands still. This is the property that makes the outbox key safe.
    expect(await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    })).toBe(false);
    expect(await fillRevision(fillId)).toBe(1);
  });

  it("refuses to revise a proven amount even when the new figure differs", async () => {
    const fillId = await deliveredFill();
    await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    });

    expect(await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "999999",
    })).toBe(false);

    const row = await queryOne<{ integrator_fee_charged_raw: string }>(
      `SELECT integrator_fee_charged_raw FROM lighter_fills WHERE id = $1`,
      [fillId],
    );
    expect(row?.integrator_fee_charged_raw).toBe("350070");
    expect(await fillRevision(fillId)).toBe(1);
  });
});

describe("delivering the enrichment", () => {
  it("produces exactly ONE pending enrichment row for a fee proven after delivery", async () => {
    await deliveredFill();
    expect(await outboxRows()).toEqual([
      { sourceKind: "lighter_fill", revision: null, sent: true },
    ]);

    await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    });
    const enqueued = await reportingRepo.enqueueEligibleLighterFills(false, GENERATION);

    expect(enqueued).toEqual({ kind: "applied", rows: 1 });
    expect(await outboxRows()).toEqual([
      { sourceKind: "lighter_fill", revision: null, sent: true },
      { sourceKind: "lighter_fill_enrichment", revision: 1, sent: false },
    ]);
  });

  it("produces NO second row for a repeat of the same enrichment", async () => {
    await deliveredFill();
    await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    });
    await reportingRepo.enqueueEligibleLighterFills(false, GENERATION);

    await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    });
    const second = await reportingRepo.enqueueEligibleLighterFills(false, GENERATION);

    expect(second).toEqual({ kind: "applied", rows: 0 });
    expect(await outboxRows()).toHaveLength(2);
  });

  it("gives a genuinely NEW fee its own row at the next revision", async () => {
    await deliveredFill();
    await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    });
    await reportingRepo.enqueueEligibleLighterFills(false, GENERATION);

    // The exchange's own charge is proven later than the integrator's. That is
    // a second fact, not a repeat, and it gets its own delivery.
    await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      exchangeFeeChargedRaw: "-250",
    });
    await reportingRepo.enqueueEligibleLighterFills(false, GENERATION);

    expect(await outboxRows()).toEqual([
      { sourceKind: "lighter_fill", revision: null, sent: true },
      { sourceKind: "lighter_fill_enrichment", revision: 1, sent: false },
      { sourceKind: "lighter_fill_enrichment", revision: 2, sent: false },
    ]);
  });

  it("does NOT enqueue an enrichment while the fill itself is still unsent", async () => {
    // Nothing to update: the fill's own row has not gone out, and the mapper
    // reads the ledger at claim time, so the exact fee travels on the fill.
    const outcome = await recordLighterFillActivity(fillRecord("101"));
    await reportingRepo.enqueueEligibleLighterFills(false, GENERATION);
    await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("101").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    });

    const again = await reportingRepo.enqueueEligibleLighterFills(false, GENERATION);

    expect(again).toEqual({ kind: "applied", rows: 0 });
    expect(await outboxRows()).toEqual([
      { sourceKind: "lighter_fill", revision: null, sent: false },
    ]);
    expect(await fillRevision(outcome.fillId)).toBe(1);
  });

  it("claims the enrichment with its revision and the ledger row it updates", async () => {
    const fillId = await deliveredFill();
    await enrichLighterFillChargedFees({
      canonicalIdentity: fillRecord("99").canonicalIdentity,
      integratorFeeChargedRaw: "350070",
    });
    await reportingRepo.enqueueEligibleLighterFills(false, GENERATION);

    const claimed = await reportingRepo.claimDueOutbox(10, GENERATION);

    expect(claimed.kind).toBe("claimed");
    const events = claimed.kind === "claimed" ? claimed.events : [];
    const enrichment = events.find((event) => event.sourceKind === "lighter_fill_enrichment");
    expect(enrichment).toMatchObject({ fillId, enrichmentRevision: 1, activityId: null });
    expect(enrichment?.fill?.integrator_fee_charged_raw).toBe("350070");
  });
});

describe("what the schema refuses outright", () => {
  it("refuses an enrichment row that names no revision", async () => {
    const fillId = await deliveredFill();
    await expect(query(
      `INSERT INTO agentscan_outbox (source_kind, lighter_fill_id, status, backfill)
       VALUES ('lighter_fill_enrichment', $1, 'confirmed', FALSE)`,
      [fillId],
    )).rejects.toThrow(/agentscan_outbox_source_reference/);
  });

  it("refuses an ordinary fill row that names one", async () => {
    const fillId = await deliveredFill();
    await expect(query(
      `INSERT INTO agentscan_outbox (source_kind, lighter_fill_id, enrichment_revision, status, backfill)
       VALUES ('lighter_fill', $1, 1, 'confirmed', FALSE)`,
      [fillId],
    )).rejects.toThrow(/agentscan_outbox_source_reference/);
  });

  it("refuses a second enrichment row for the same fill and revision", async () => {
    const fillId = await deliveredFill();
    await query(
      `INSERT INTO agentscan_outbox (source_kind, lighter_fill_id, enrichment_revision, status, backfill)
       VALUES ('lighter_fill_enrichment', $1, 1, 'confirmed', FALSE)`,
      [fillId],
    );
    await expect(query(
      `INSERT INTO agentscan_outbox (source_kind, lighter_fill_id, enrichment_revision, status, backfill)
       VALUES ('lighter_fill_enrichment', $1, 1, 'confirmed', FALSE)`,
      [fillId],
    )).rejects.toThrow(/uniq_agentscan_outbox_lighter_fill_pair/);
  });

  it("keeps the fill's own row and its enrichment out of each other's way", async () => {
    // Same fill id, same status, different kinds: the revision slot is what
    // separates them, and 0 belongs to the fill alone.
    const fillId = await deliveredFill();
    await query(
      `INSERT INTO agentscan_outbox (source_kind, lighter_fill_id, enrichment_revision, status, backfill)
       VALUES ('lighter_fill_enrichment', $1, 1, 'confirmed', FALSE)`,
      [fillId],
    );
    expect(await outboxRows()).toEqual([
      { sourceKind: "lighter_fill", revision: null, sent: true },
      { sourceKind: "lighter_fill_enrichment", revision: 1, sent: false },
    ]);
  });
});
