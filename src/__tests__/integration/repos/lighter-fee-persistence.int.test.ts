import { requireValue } from "../../helpers/require-value.js";
import { beforeEach, describe, expect, it } from "vitest";
import { query, queryOne, withTransaction } from "@vex-agent/db/client.js";
import { runMigrations } from "@vex-agent/db/migrate.js";
import * as approvals from "@vex-agent/db/repos/approvals.js";
import * as fees from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import * as previews from "@vex-agent/db/repos/lighter-order-previews.js";
import * as orders from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import { buildLighterOrderPreview } from "@tools/lighter/order-preview.js";
import { evaluateLighterTradingCredentialReadiness } from "@tools/lighter/trading-credentials.js";
import type { LighterMarketDetail } from "@tools/lighter/types.js";
import { makeSession } from "../setup/fixtures.js";

const TERMS: fees.LighterFeeAuthorizationTerms = {
  collectorAccountIndex: 99, collectorL1Address: `0x${"2".repeat(40)}`,
  maxPerpsMakerFee: 1000, maxPerpsTakerFee: 1000, maxSpotMakerFee: 2500, maxSpotTakerFee: 2500,
  authorizationExpiryMs: 2_200_000_000_000, revoke: false, publicKey: "ab".repeat(40),
  currentTier: "plus", targetTier: null, exchangeMakerFeeTick: 50, exchangeTakerFeeTick: 50,
};
const WALLET = `0x${"1".repeat(40)}`;
const COLLECTOR_FEES = { integratorAccountIndex: 99, integratorMakerFee: 1000, integratorTakerFee: 1000 };
let sessionId: string;

async function createIntent(id = "fee-one", overrides: Partial<Parameters<typeof fees.createLighterFeeAuthorizationIntentWith>[1]> = {}) {
  return withTransaction((client) => fees.createLighterFeeAuthorizationIntentWith(client, {
    intentId: id, sessionId, environment: "core", walletAddress: WALLET, accountIndex: 42,
    apiKeyIndex: 7, terms: TERMS, expiresAt: new Date(Date.now() + 120_000), ...overrides,
  }));
}

async function decision(intentId: string, status: "approved" | "rejected" | "expired") {
  const approvalId = `approval-${intentId}`;
  await approvals.enqueue(approvalId, { command: "execute_tool", args: { toolId: "lighter.fees.approve", params: { intentId } } }, "Review trading fees", sessionId);
  return withTransaction((client) => fees.markLighterFeeAuthorizationDecisionWith(client, { intentId, sessionId, approvalId, status }));
}

beforeEach(async () => {
  // This lane's global setup creates the database; refuse any other target.
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name")).toEqual({ name: "vex_test" });
  // Preserve both migration ledgers while clearing these session-owned rows.
  await query("TRUNCATE sessions RESTART IDENTITY CASCADE");
  sessionId = await makeSession();
});

describe("Lighter fee persistence against isolated PostgreSQL", () => {
  it("applies migrations 118/119 and preserves one version row on rerun", async () => {
    const readVersions = () => query<{ version: number }>("SELECT version FROM schema_version WHERE version IN (118,119) ORDER BY version");
    expect(await readVersions()).toEqual([{ version: 118 }, { version: 119 }]);
    await runMigrations();
    expect(await readVersions()).toEqual([{ version: 118 }, { version: 119 }]);
    expect(await query<{ file: string }>("SELECT file FROM schema_migration_files WHERE version IN (118,119) ORDER BY file"))
      .toEqual([{ file: "118_lighter_order_integrator_fees.sql" }, { file: "119_lighter_fee_authorization_intents.sql" }]);
    expect(await queryOne<{ data_type: string }>("SELECT data_type FROM information_schema.columns WHERE table_name='lighter_order_execution_intents' AND column_name='integrator_fees_json'"))
      .toEqual({ data_type: "jsonb" });
  });

  it("roundtrips terms, decision, nonce and staged submission through compare-and-set transitions", async () => {
    const created = await createIntent();
    expect(created).toMatchObject({ terms: TERMS, approvalStatus: "approval_pending", executionState: "approval_pending", nonceValue: null });
    expect((await decision(created.intentId, "approved"))?.executionState).toBe("approved");
    const transition = (expectedStates: fees.LighterFeeAuthorizationState[], nextState: fees.LighterFeeAuthorizationState,
      extra: Partial<Parameters<typeof fees.transitionLighterFeeAuthorizationWith>[1]> = {}) => withTransaction((client) =>
        fees.transitionLighterFeeAuthorizationWith(client, { intentId: created.intentId, sessionId, expectedStates, nextState, ...extra }));
    expect(await transition(["approved"], "tier_ready", { sessionId: "wrong-session" })).toBeNull();
    expect((await transition(["approved"], "tier_ready"))?.executionState).toBe("tier_ready");
    expect(await transition(["approved"], "tier_ready")).toBeNull();
    expect((await transition(["tier_ready"], "signing", { nonceValue: "281474976710650", txExpiryMs: 1_900_000_060_000 }))?.nonceValue).toBe("281474976710650");
    expect((await transition(["signing"], "submission_staged", { txHash: "0xfee-test" }))?.txExpiryMs).toBe(1_900_000_060_000);
    expect((await transition(["submission_staged"], "submitted"))?.txHash).toBe("0xfee-test");
    const active = await transition(["submitted"], "active");
    expect(active?.verifiedAt).toBeInstanceOf(Date);
    expect(await fees.findLiveLighterFeeAuthorizationIntent("core", 42)).toBeNull();
    expect((await createIntent("fee-next"))?.approvalStatus).toBe("approval_pending");
  });

  it("prevents signing before approval and rejects staged submissions with no transaction hash", async () => {
    const created = await createIntent();
    expect(await withTransaction((client) => fees.transitionLighterFeeAuthorizationWith(client, {
      intentId: created.intentId, sessionId, expectedStates: ["approval_pending"], nextState: "signing", nonceValue: "10",
    }))).toBeNull();
    await decision(created.intentId, "approved");
    await expect(withTransaction((client) => fees.transitionLighterFeeAuthorizationWith(client, {
      intentId: created.intentId, sessionId, expectedStates: ["approved"], nextState: "submission_staged",
    }))).rejects.toMatchObject({ code: "23514" });
    expect((await fees.findLighterFeeAuthorizationIntent(created.intentId))?.executionState).toBe("approved");
  });

  it("refuses expired approval and releases the account slot after expiration", async () => {
    const stale = await createIntent("fee-expired", { expiresAt: new Date(Date.now() - 1000) });
    expect(await decision(stale.intentId, "approved")).toBeNull();
    await withTransaction((client) => fees.expirePendingLighterFeeAuthorizationWith(client, "core", 42));
    expect(await fees.findLighterFeeAuthorizationIntent(stale.intentId)).toMatchObject({ approvalStatus: "expired", executionState: "expired" });
    expect((await createIntent("fee-replacement")).executionState).toBe("approval_pending");
  });

  it("rejection releases the account slot without allowing a later approval", async () => {
    const created = await createIntent();
    expect((await decision(created.intentId, "rejected"))?.executionState).toBe("rejected");
    expect(await withTransaction((client) => fees.markLighterFeeAuthorizationDecisionWith(client, {
      intentId: created.intentId, sessionId, approvalId: `approval-${created.intentId}`, status: "approved",
    }))).toBeNull();
    expect((await createIntent("fee-replacement")).executionState).toBe("approval_pending");
  });

  it("enforces one live intent per deployment and account across concurrent sessions", async () => {
    const secondSession = await makeSession();
    const results = await Promise.allSettled([createIntent("fee-a"), createIntent("fee-b", { sessionId: secondSession })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "23505", constraint: "lighter_fee_authorization_one_live_account" } });
    expect((await createIntent("fee-rhc", { environment: "rhc" })).environment).toBe("rhc");
  });

  it("keeps an ambiguous signed intent in the live slot and refuses unsigned retirement", async () => {
    const created = await createIntent();
    await decision(created.intentId, "approved");
    const ambiguous = await withTransaction((client) => fees.transitionLighterFeeAuthorizationWith(client, {
      intentId: created.intentId, sessionId, expectedStates: ["approved"], nextState: "ambiguous", nonceValue: "11", txHash: "0xuncertain",
    }));
    expect(ambiguous).not.toBeNull();
    expect(await withTransaction((client) => fees.retireUnsignedLighterFeeAuthorizationWith(client, requireValue(ambiguous)))).toBe(false);
    await expect(createIntent("fee-duplicate")).rejects.toMatchObject({ code: "23505" });
  });

  it("roundtrips native order fee JSON from preview into its durable execution intent", async () => {
    const now = Date.now();
    const market: LighterMarketDetail = {
      market_id: 0, symbol: "ETH", market_type: "perp", status: "active", base_asset_id: 1, quote_asset_id: 0,
      maker_fee: "0", taker_fee: "0", liquidation_fee: "0", min_base_amount: "0.001", min_quote_amount: "1",
      supported_size_decimals: 4, supported_price_decimals: 2, supported_quote_decimals: 6,
      order_quote_limit: "1000000000", is_maker_fee_enabled: false, is_taker_fee_enabled: false,
    };
    const preview = buildLighterOrderPreview({ sessionId, environment: "core", accountIndex: 42, apiKeyIndex: 7,
      marketId: 0, side: "buy", baseAmount: "1", price: "2000", orderType: "market", timeInForce: "immediate-or-cancel",
      reduceOnly: false, orderExpiry: now + 600_000, clientOrderIndexPolicy: "vex_assigned_uint48", nowMs: now, integratorFees: COLLECTOR_FEES,
    }, { market, account: { code: 200, total: 1, accounts: [{ index: 42, status: 1, positions: [] }] },
      orderBook: { code: 200, total_asks: 0, total_bids: 0, asks: [], bids: [] } });
    await previews.create({ preview, liveSourceJson: { source: "integration_fixture" } });
    const stored = await previews.findById(sessionId, "core", preview.previewId);
    expect(stored?.integratorFees).toEqual(COLLECTOR_FEES);
    const readiness = evaluateLighterTradingCredentialReadiness({ environment: "core", accountIndex: 42, apiKeyIndex: 7, vaultCredentialId: "lighter/core/account-42/api-key-7" });
    if (!readiness.ready || !stored) throw new Error("Expected a stored public preview and valid opaque vault reference.");
    const intent = await orders.createApprovalPending({ intentId: "order-fee-test", preview: stored, credentialReadiness: readiness, expiresAt: stored.expiresAt });
    expect(intent?.integratorFees).toEqual(COLLECTOR_FEES);
    expect(await orders.findByIntentId(sessionId, "order-fee-test")).toMatchObject({ integratorFees: COLLECTOR_FEES, matchHash: preview.matchHash });
  });
});
