/**
 * THE FILL MERGE RULE, AGAINST REAL POSTGRESQL.
 *
 * Four sources can observe the same fill: an authenticated account stream
 * frame, an order-repair read of the account's trades, a public
 * `recentTrades` reconciliation, and a replay of any of them. Three of the
 * four know the account's own half of the record; the public one does not.
 * Every property below is a database property that no fake client can prove:
 *
 *   - ECONOMICS ARE IMMUTABLE. A second report with a different price, size,
 *     notional, trade type, USD amount or trade time is refused, logged, and
 *     writes nothing. Overwriting would destroy the only copy of the truth.
 *   - KNOWLEDGE FILLS ONCE. The account-relative columns are written by the
 *     first observation that carries them and never again, in ONE statement
 *     (the whole-or-nothing CHECK is what makes half of them impossible), and
 *     the revision moves so the knowledge reaches a server that already holds
 *     the fill.
 *   - HELD ROWS ARE NOT ACTIVITY. A fill whose intent is unknown is written
 *     and excluded from the outbox by that null; only `attachLighterFillToIntent`
 *     grants the attribution, and only on the venue's own order id.
 *
 * Round-2 plan section 4 is the cross product this file walks.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { query, queryOne } from "@vex-agent/db/client.js";
import * as reportingRepo from "@vex-agent/db/repos/agentscan-reporting.js";
import {
  attachLighterFillToIntent,
  lighterFillIdentity,
  recordedLighterFillBaseSizeForIntent,
  recordLighterFillActivity,
  type LighterFillRecord,
} from "@vex-agent/tools/protocols/lighter/agentscan-activity.js";

const ENVIRONMENT = "core" as const;
const ACCOUNT = 743799;
const MARKET = 1;
const GENERATION = 0;
const IDENTITY = lighterFillIdentity({
  environment: ENVIRONMENT,
  accountIndex: ACCOUNT,
  marketIndex: MARKET,
  providerTradeId: "99",
});

const USDC = { venueAssetId: "lighter:core:asset:0", symbol: "USDC", decimals: 6 };
const ETH = { venueAssetId: "lighter:core:asset:1", symbol: "ETH", decimals: 18 };

/** A fill as a PUBLIC observation produces it: economics whole, account half absent. */
function publicRow(overrides: Partial<LighterFillRecord> = {}): LighterFillRecord {
  return {
    canonicalIdentity: IDENTITY,
    environment: ENVIRONMENT,
    accountIndex: ACCOUNT,
    marketIndex: MARKET,
    providerTradeId: "99",
    providerOrderId: "8",
    clientOrderId: "555",
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
    ...overrides,
  };
}

/** The same fill as an AUTHENTICATED observation produces it. */
function authenticatedRow(overrides: Partial<LighterFillRecord> = {}): LighterFillRecord {
  return publicRow({
    accountFacts: {
      positionSizeBefore: "-2.5",
      positionSignChanged: false,
      entryQuoteBefore: "-6000.000000",
      accountPnl: "1.989696",
      initialMarginFractionBefore: 3333,
    },
    positionEffect: "reduce",
    ...overrides,
  });
}

interface StoredFill {
  readonly price: string;
  readonly usd_amount: string;
  readonly trade_type: string;
  readonly position_size_before: string | null;
  readonly position_sign_changed: boolean | null;
  readonly entry_quote_before: string | null;
  readonly account_pnl: string | null;
  readonly position_effect: string | null;
  readonly revision: number;
  readonly execution_intent_id: string | null;
  readonly initial_margin_fraction_before: number | null;
  readonly updated_at: Date;
}

async function stored(): Promise<StoredFill> {
  const row = await queryOne<StoredFill>(
    `SELECT price, usd_amount, trade_type, position_size_before, position_sign_changed,
            entry_quote_before, account_pnl, position_effect, revision, execution_intent_id,
            initial_margin_fraction_before, updated_at
       FROM lighter_fills WHERE canonical_identity = $1`,
    [IDENTITY],
  );
  if (row === null) throw new Error("the fill row is gone");
  return row;
}

beforeEach(async () => {
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name")).toEqual({ name: "vex_test" });
  await reportingRepo.getReportingState();
  await query("TRUNCATE agentscan_outbox RESTART IDENTITY");
  await query("TRUNCATE lighter_fills RESTART IDENTITY CASCADE");
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

describe("the first observation", () => {
  it("stores Lighter's own trade facts and leaves the account half null", async () => {
    expect(await recordLighterFillActivity(publicRow())).toMatchObject({ kind: "recorded" });
    const row = await stored();
    expect(row.usd_amount).toBe("1000.20");
    expect(row.trade_type).toBe("trade");
    // A public row knows nothing about the account's position, and the
    // whole-or-nothing CHECK makes a partial answer impossible.
    expect(row.position_size_before).toBeNull();
    expect(row.position_sign_changed).toBeNull();
    expect(row.account_pnl).toBeNull();
    expect(row.position_effect).toBeNull();
    expect(Number(row.revision)).toBe(0);
  });

  it("stores the account half whole when the first observation is authenticated", async () => {
    expect(await recordLighterFillActivity(authenticatedRow())).toMatchObject({ kind: "recorded" });
    const row = await stored();
    expect(row.position_size_before).toBe("-2.5");
    expect(row.position_sign_changed).toBe(false);
    expect(row.entry_quote_before).toBe("-6000.000000");
    expect(row.account_pnl).toBe("1.989696");
    expect(row.position_effect).toBe("reduce");
    // Established at insert: no enrichment happened, so nothing to deliver.
    expect(Number(row.revision)).toBe(0);
  });

  it("refuses a trade time it cannot read rather than storing our clock", async () => {
    await expect(recordLighterFillActivity(publicRow({ tradedAt: "not-a-time" }))).rejects.toThrow();
  });
});

describe("re-observing the same fill", () => {
  it("is an idempotent duplicate when neither source knows more", async () => {
    await recordLighterFillActivity(publicRow());
    expect(await recordLighterFillActivity(publicRow())).toMatchObject({ kind: "duplicate" });
    expect(Number((await stored()).revision)).toBe(0);
  });

  it("fills the account half ONCE when an authenticated read follows a public one", async () => {
    await recordLighterFillActivity(publicRow());
    const merged = await recordLighterFillActivity(authenticatedRow());
    expect(merged).toMatchObject({ kind: "enriched", revision: 1 });

    const row = await stored();
    expect(row.position_size_before).toBe("-2.5");
    expect(row.position_effect).toBe("reduce");
    // ECONOMICS UNTOUCHED: the merge statement has no column for them.
    expect(row.price).toBe("2500.5");
    expect(row.usd_amount).toBe("1000.20");
  });

  it("never revises the account half once it exists, even with different values", async () => {
    await recordLighterFillActivity(publicRow());
    await recordLighterFillActivity(authenticatedRow());
    const second = await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "99.9",
        positionSignChanged: true,
        entryQuoteBefore: "1.0",
        accountPnl: "-999.999999",
        initialMarginFractionBefore: null,
      },
      positionEffect: "flip",
    }));
    expect(second).toMatchObject({ kind: "duplicate" });
    const row = await stored();
    expect(row.position_size_before).toBe("-2.5");
    expect(row.account_pnl).toBe("1.989696");
    expect(row.position_effect).toBe("reduce");
    expect(Number(row.revision)).toBe(1);
  });

  it("does not move the revision when a public row follows an authenticated one", async () => {
    await recordLighterFillActivity(authenticatedRow());
    expect(await recordLighterFillActivity(publicRow())).toMatchObject({ kind: "duplicate" });
    expect(Number((await stored()).revision)).toBe(0);
  });

  it.each([
    ["price", { price: "2600.0" }],
    ["base size", { baseSize: "0.5" }],
    ["quote notional", { quoteNotional: "1300" }],
    ["side", { side: "sell" as const }],
    ["block height", { blockHeight: "12346" }],
    ["trade type", { tradeType: "liquidation" as const }],
    ["Lighter's USD amount", { usdAmount: "1000.21" }],
    ["the trade time", { tradedAt: "2026-09-08T09:11:56.528Z" }],
  ])("refuses a contradictory %s and writes nothing", async (_label, override) => {
    await recordLighterFillActivity(publicRow());
    const outcome = await recordLighterFillActivity(authenticatedRow(override));
    expect(outcome.kind).toBe("conflict");

    const row = await stored();
    expect(row.price).toBe("2500.5");
    expect(row.usd_amount).toBe("1000.20");
    expect(row.trade_type).toBe("trade");
    // The refusal is total: the account half is NOT merged out of a record
    // whose economics disagree, because that record is not trustworthy.
    expect(row.position_size_before).toBeNull();
    expect(Number(row.revision)).toBe(0);
  });
});

describe("the leverage in force before the fill", () => {
  /**
   * MIGRATION 162'S COLUMN, against the CHECK itself.
   *
   * The fraction is the only honest source for "what leverage was this trade
   * taken at": the account's leverage NOW is a different number about a
   * different moment. It is also OPTIONAL in every sense that matters - a
   * public trade row has no account half at all, an authenticated one may omit
   * the field, and `marginFraction()` in `fill-position-effect.ts` hands on any
   * nonnegative safe integer, including values the column refuses. So the two
   * properties proved here are: a readable value is stored exactly, and an
   * unreadable one costs the ledger NOTHING - not the fill, not the fees, not
   * the attribution.
   */
  it("stores the fraction at insert when the first observation carries one", async () => {
    expect(await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: 1000,
      },
    }))).toMatchObject({ kind: "recorded" });
    // 1000 on the provider's 10000 scale is 10x, and it is stored as the
    // provider's own integer: no leverage is computed at the write.
    expect((await stored()).initial_margin_fraction_before).toBe(1000);
  });

  it.each([
    ["a zero the CHECK would refuse", 0],
    ["a value above the 10000 tick", 20_000],
    ["a negative value", -1],
    ["a non-integer", 1000.5],
    ["no value at all", null],
  ])("records the fill and stores the leverage as unknown on %s", async (_label, value) => {
    const outcome = await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: value,
      },
    }));
    // The fill is the fact. Failing its whole insert over an optional context
    // field - or clamping the field into a plausible-looking leverage - are
    // both worse than saying "unknown".
    expect(outcome).toMatchObject({ kind: "recorded" });
    const row = await stored();
    expect(row.initial_margin_fraction_before).toBeNull();
    expect(row.price).toBe("2500.5");
    expect(row.position_size_before).toBe("-2.5");
  });

  it("fills the fraction through the account merge, in the same statement", async () => {
    await recordLighterFillActivity(publicRow());
    expect((await stored()).initial_margin_fraction_before).toBeNull();

    expect(await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: 1000,
      },
    }))).toMatchObject({ kind: "enriched", revision: 1 });

    const row = await stored();
    expect(row.initial_margin_fraction_before).toBe(1000);
    expect(row.position_size_before).toBe("-2.5");
  });

  it("fills the fraction when the account half is ALREADY held and the merge cannot run", async () => {
    // The defect this pins: the merge refuses once `position_size_before` is
    // set, so a first authenticated observation without the fraction would
    // freeze the column at NULL for the life of the row.
    await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: null,
      },
    }));
    expect((await stored()).initial_margin_fraction_before).toBeNull();

    const second = await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: 1000,
      },
    }));

    // The outcome is what it was about the FILL: an ordinary duplicate. The
    // fraction is not on the AgentScan wire, so nothing was enriched for a
    // server and the revision does not move.
    expect(second).toMatchObject({ kind: "duplicate" });
    const row = await stored();
    expect(row.initial_margin_fraction_before).toBe(1000);
    expect(Number(row.revision)).toBe(0);
  });

  it("never revises a fraction it already holds", async () => {
    await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: 1000,
      },
    }));

    expect(await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: 5000,
      },
    }))).toMatchObject({ kind: "duplicate" });

    expect((await stored()).initial_margin_fraction_before).toBe(1000);
  });

  it("takes NOTHING from a report whose economics contradict the ledger", async () => {
    await recordLighterFillActivity(publicRow());
    const before = await stored();

    const outcome = await recordLighterFillActivity(authenticatedRow({
      price: "2600.0",
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: 1000,
      },
    }));

    // A contradicting report is a defect in whoever produced it. A field that
    // would have been free to take is still a field from a source the ledger
    // has just refused, so the refusal is total and the row is untouched.
    expect(outcome.kind).toBe("conflict");
    const row = await stored();
    expect(row.initial_margin_fraction_before).toBeNull();
    expect(row.updated_at.toISOString()).toBe(before.updated_at.toISOString());
    expect(Number(row.revision)).toBe(0);
  });

  it("does not move the revision or the outcome when only the fraction is news", async () => {
    await recordLighterFillActivity(publicRow());
    await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: null,
      },
    }));
    // One enrichment so far: the account half. The outbox owes exactly that.
    expect(Number((await stored()).revision)).toBe(1);

    expect(await recordLighterFillActivity(authenticatedRow({
      accountFacts: {
        positionSizeBefore: "-2.5",
        positionSignChanged: false,
        entryQuoteBefore: "-6000.000000",
        accountPnl: "1.989696",
        initialMarginFractionBefore: 1000,
      },
    }))).toMatchObject({ kind: "duplicate" });

    const row = await stored();
    expect(row.initial_margin_fraction_before).toBe(1000);
    // Bumping it here would enqueue an enrichment delivery carrying nothing
    // the server does not already have.
    expect(Number(row.revision)).toBe(1);
  });

  it("leaves a public re-observation unable to establish a fraction at all", async () => {
    await recordLighterFillActivity(publicRow());
    expect(await recordLighterFillActivity(publicRow())).toMatchObject({ kind: "duplicate" });
    expect((await stored()).initial_margin_fraction_before).toBeNull();
  });
});

describe("held fills and the attribution that releases them", () => {
  const HELD = publicRow({ executionIntentId: null, clientOrderId: null });

  it("is never enqueued for AgentScan while it has no intent", async () => {
    expect(await recordLighterFillActivity(HELD)).toMatchObject({ kind: "recorded" });
    // Reporting it would attribute trading to this agent on nothing but the
    // account index, which is a venue identity and not authorship.
    expect(await reportingRepo.enqueueEligibleLighterFills(false, GENERATION)).toEqual({
      kind: "applied",
      rows: 0,
    });
  });

  it("is enqueued once an attachment proves which Vex order produced it", async () => {
    await recordLighterFillActivity(HELD);
    expect(await attachLighterFillToIntent({
      canonicalIdentity: IDENTITY,
      intent: {
        intentId: "intent-7",
        environment: ENVIRONMENT,
        accountIndex: ACCOUNT,
        marketIndex: MARKET,
        // The account BOUGHT, so its own order id is the BID id.
        providerOrderId: "8",
        clientOrderIndex: "555",
      },
    })).toMatchObject({ kind: "attached" });

    const row = await stored();
    expect(row.execution_intent_id).toBe("intent-7");
    expect(await reportingRepo.enqueueEligibleLighterFills(false, GENERATION)).toEqual({
      kind: "applied",
      rows: 1,
    });
  });

  it.each([
    [
      "a different environment",
      { environment: "rhc" as const },
      "scope_mismatch",
    ],
    [
      "a different account",
      { accountIndex: 999_999 },
      "scope_mismatch",
    ],
    [
      "a different market",
      { marketIndex: 7 },
      "scope_mismatch",
    ],
    [
      "the counterparty's order id",
      { providerOrderId: "7" },
      "provider_order_id_mismatch",
    ],
  ])("refuses an attachment on %s", async (_label, override, reason) => {
    await recordLighterFillActivity(HELD);
    expect(await attachLighterFillToIntent({
      canonicalIdentity: IDENTITY,
      intent: {
        intentId: "intent-7",
        environment: ENVIRONMENT,
        accountIndex: ACCOUNT,
        marketIndex: MARKET,
        providerOrderId: "8",
        clientOrderIndex: "555",
        ...override,
      },
    })).toEqual({ kind: "refused", reason });
    expect((await stored()).execution_intent_id).toBeNull();
  });

  it("refuses to move a fill that already belongs to another intent", async () => {
    await recordLighterFillActivity(publicRow());
    expect(await attachLighterFillToIntent({
      canonicalIdentity: IDENTITY,
      intent: {
        intentId: "intent-7",
        environment: ENVIRONMENT,
        accountIndex: ACCOUNT,
        marketIndex: MARKET,
        providerOrderId: "8",
        clientOrderIndex: "555",
      },
    })).toEqual({ kind: "refused", reason: "attached_to_other_intent" });
    expect((await stored()).execution_intent_id).toBe("intent-1");
  });

  it("is idempotent when the same intent attaches twice", async () => {
    await recordLighterFillActivity(HELD);
    const attachment = {
      canonicalIdentity: IDENTITY,
      intent: {
        intentId: "intent-7",
        environment: ENVIRONMENT,
        accountIndex: ACCOUNT,
        marketIndex: MARKET,
        providerOrderId: "8",
        clientOrderIndex: "555",
      },
    };
    await attachLighterFillToIntent(attachment);
    expect(await attachLighterFillToIntent(attachment)).toMatchObject({ kind: "already_attached" });
  });

  it("refuses an attachment to a fill nobody has recorded", async () => {
    expect(await attachLighterFillToIntent({
      canonicalIdentity: "lighter:core:743799:1:404",
      intent: {
        intentId: "intent-7",
        environment: ENVIRONMENT,
        accountIndex: ACCOUNT,
        marketIndex: MARKET,
        providerOrderId: "8",
        clientOrderIndex: "555",
      },
    })).toEqual({ kind: "refused", reason: "unknown_fill" });
  });
});

describe("knowledge that arrives after delivery", () => {
  it("reaches the server as an enrichment row, exactly once", async () => {
    // Deliver the public fill first: its own outbox row is terminal from then
    // on, which is why the knowledge needs a row of its own.
    await recordLighterFillActivity(publicRow());
    expect(await reportingRepo.enqueueEligibleLighterFills(false, GENERATION)).toEqual({
      kind: "applied",
      rows: 1,
    });
    const base = await queryOne<{ id: string }>(
      `SELECT id FROM agentscan_outbox WHERE source_kind = 'lighter_fill'`,
    );
    await reportingRepo.markOutboxSent([Number(base?.id)], GENERATION);

    const merged = await recordLighterFillActivity(authenticatedRow());
    expect(merged).toMatchObject({ kind: "enriched", revision: 1 });

    // The same scan runs both halves: the fill diff (nothing new, its row is
    // terminal) and the enrichment diff, which now has a revision to deliver.
    expect(await reportingRepo.enqueueEligibleLighterFills(false, GENERATION)).toEqual({
      kind: "applied",
      rows: 1,
    });
    // A repeat of the same authenticated observation revises nothing, so the
    // revision stands still and no second row appears.
    await recordLighterFillActivity(authenticatedRow());
    expect(await reportingRepo.enqueueEligibleLighterFills(false, GENERATION)).toEqual({
      kind: "applied",
      rows: 0,
    });

    const rows = await query<{ source_kind: string; enrichment_revision: number | null }>(
      `SELECT source_kind, enrichment_revision FROM agentscan_outbox ORDER BY id`,
    );
    expect(rows.map((row) => [row.source_kind, Number(row.enrichment_revision)])).toEqual([
      ["lighter_fill", 0],
      ["lighter_fill_enrichment", 1],
    ]);
  });
});

describe("the base size an intent has recorded", () => {
  /** A second, distinct fill of the same order: its own trade id, its own identity. */
  function siblingRow(providerTradeId: string, baseSize: string, executionIntentId: string | null): LighterFillRecord {
    return publicRow({
      providerTradeId,
      baseSize,
      executionIntentId,
      canonicalIdentity: lighterFillIdentity({
        environment: ENVIRONMENT,
        accountIndex: ACCOUNT,
        marketIndex: MARKET,
        providerTradeId,
      }),
    });
  }

  it("is the exact decimal sum over the intent's fills, and zero for an intent with none", async () => {
    // The self-healing follow-up read is gated on this sum against the
    // quantity the venue reports as filled; an exact Postgres numeric sum is
    // what makes "the ledger is level" a statement about the database and
    // not about floating point.
    await recordLighterFillActivity(publicRow({ baseSize: "0.4" }));
    await recordLighterFillActivity(siblingRow("100", "0.25", "intent-1"));
    await recordLighterFillActivity(siblingRow("101", "0.9", null));
    await recordLighterFillActivity(siblingRow("102", "5", "intent-2"));

    expect(await recordedLighterFillBaseSizeForIntent("intent-1")).toBe("0.65");
    expect(await recordedLighterFillBaseSizeForIntent("intent-2")).toBe("5");
    expect(await recordedLighterFillBaseSizeForIntent("intent-none")).toBe("0");
  });
});
