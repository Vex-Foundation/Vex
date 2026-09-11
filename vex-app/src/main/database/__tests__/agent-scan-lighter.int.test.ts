/**
 * `getAgentScan`'s LIGHTER ARM against a REAL PostgreSQL.
 *
 * ## Why the mocked suites beside this one are not enough
 *
 * They prove the builder EMITS a correlated `EXISTS` and that the mapper turns
 * a row into an entry. They cannot prove that the compiled statement runs, that
 * the `EXISTS` really emits one row when two wallets resolve to ONE Lighter
 * account (a JOIN would emit two, and a text assertion cannot tell the
 * difference), that a held fill is really unreachable, that the LATERAL finds
 * the market state, or that walking the mixed timeline with the production page
 * size neither skips nor repeats a row across the arm seam. Every one of those
 * is a property of the database.
 *
 * So this suite seeds the real tables - two onboarding workflows resolving to
 * the SAME account, one execution intent, attributed / foreign / held fills,
 * an open market state and a closed one, and `agent_activity` rows on either
 * side of the fill in time - and drives the production `getAgentScan` over them
 * on a schema with every migration applied, migration 162 included.
 *
 * ## What is mocked, and why only that
 *
 * `@vex-lib/wallet.js` is the OS keystore boundary, which a test process cannot
 * have. Everything else is real: the compiled SQL of both arms, the keyset
 * ordering, the merge, the mapping and the DTO.
 */

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inventory: two EVM wallets that BOTH onboard to the same Lighter account, and
 * one that never does. Hoisted, because the keystore mock factory is hoisted
 * above every module-level binding.
 */
const INVENTORY = vi.hoisted(() => ({
  WALLET_A: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
  WALLET_B: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb",
  WALLET_A_ID: "evm_a",
  WALLET_B_ID: "evm_b",
}));
const { WALLET_A, WALLET_B } = INVENTORY;

vi.mock("../../logger/index.js", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
  configureLogger: (): void => undefined,
  redact: (value: unknown): unknown => value,
  redactArgs: (value: unknown): unknown => value,
}));

vi.mock("@vex-lib/wallet.js", () => {
  const entries = {
    evm: [
      { id: INVENTORY.WALLET_A_ID, address: INVENTORY.WALLET_A, label: "a" },
      { id: INVENTORY.WALLET_B_ID, address: INVENTORY.WALLET_B, label: "b" },
    ],
    solana: [],
  } as const;
  return {
    listWallets: (family: "evm" | "solana") => entries[family],
    getWalletById: (family: "evm" | "solana", id: string) =>
      entries[family].find((entry) => entry.id === id) ?? null,
  };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: (): Promise<{
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  } | null> => {
    const url = process.env.VEX_DB_URL;
    if (url === undefined || url === "") return Promise.resolve(null);
    const parsed = new URL(url);
    return Promise.resolve({
      host: parsed.hostname,
      port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//, ""),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
  },
}));

import { ok } from "@shared/ipc/result.js";
import {
  AGENT_SCAN_PAGE_SIZE,
  type AgentScanCursor,
  type AgentScanEntry,
  type AgentScanFilters,
  type AgentScanLighterFillEntry,
} from "@shared/schemas/agent-scan-feed.js";
import { getAgentScan } from "../agent-scan-db.js";
import { withClient } from "../sessions/connection.js";

const CORRELATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
/** The account BOTH inventory wallets resolve to - the duplicate-mapping hazard. */
const ACCOUNT_INDEX = 24_226;
/** An account the inventory never onboards: its fills are somebody else's. */
const FOREIGN_ACCOUNT_INDEX = 99_001;
const MARKET_INDEX = 1;
const CLOSED_MARKET_INDEX = 2;

async function sql<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await withClient(async (client) => {
    const rows = await client.query<T>(text, [...values]);
    return ok(rows.rows);
  });
  if (!result.ok) throw new Error(`statement failed: ${text}`);
  return result.data;
}

let sessionId = "";
let otherSessionId = "";
let executionId = 0;
let intentId = "";
let suiteTag = "";

/** The fills this suite inserted, by their seeded `provider_trade_id`. */
function isSeededFill(entry: AgentScanEntry): entry is AgentScanLighterFillEntry {
  return entry.source === "lighter_fill" && entry.intentId.includes(suiteTag);
}

async function read(
  filters: AgentScanFilters = {},
  cursor: AgentScanCursor | null = null,
) {
  const outcome = await getAgentScan({ cursor, filters }, CORRELATION_ID);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("read failed");
  expect(outcome.data.status).toBe("available");
  if (outcome.data.status !== "available") throw new Error("read unavailable");
  return outcome.data;
}

/**
 * One `lighter_fills` row. Every NOT NULL column migration 152 declares is
 * supplied: seeding through raw SQL still has to produce rows production could
 * really write.
 */
async function seedFill(input: {
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly providerTradeId: string;
  readonly secondsAgo: number;
  readonly intent: string | null;
  readonly marginFraction: number | null;
}): Promise<void> {
  await sql(
    `INSERT INTO lighter_fills (
       canonical_identity, environment, account_index, market_index,
       provider_trade_id, provider_order_id, execution_intent_id,
       market_symbol, side, price, base_size, quote_notional,
       base_asset_id, base_asset_symbol, base_asset_decimals,
       quote_asset_id, quote_asset_symbol, quote_asset_decimals,
       block_height, trade_type, traded_at, usd_amount,
       position_size_before, position_sign_changed, entry_quote_before,
       account_pnl, position_effect, initial_margin_fraction_before,
       fee_side, integrator_fee_tick_authorized, integrator_fee_tick_observed,
       integrator_fee_asset_id, integrator_fee_asset_symbol, integrator_fee_asset_decimals,
       integrator_fee_estimated_raw, integrator_fee_estimate_basis,
       integrator_fee_estimate_tick_source, integrator_fee_charged_raw,
       integrator_fee_estimated_usd, exchange_fee_tick_observed,
       exchange_fee_charged_raw, exchange_fee_estimated_usd, observed_at
     ) VALUES (
       $1, 'core', $2, $3,
       $4, '112233', $5,
       'ETH', 'buy', '2598.09', '0.0050', '12.99045',
       'eth', 'ETH', 18,
       'usdc', 'USDC', 6,
       '10453221', 'trade', NOW() - ($6 || ' seconds')::interval, '12.99',
       '0', false, '0',
       '0', 'open', $7,
       'taker', 250, 250,
       'usdc', 'USDC', 6,
       '3247', 'quote_notional',
       'observed', '3247',
       '0.003247', 100,
       '1299', '0.001299', NOW()
     )`,
    [
      `lighter:core:${input.accountIndex}:${input.marketIndex}:${input.providerTradeId}`,
      input.accountIndex,
      input.marketIndex,
      input.providerTradeId,
      input.intent,
      String(input.secondsAgo),
      input.marginFraction,
    ],
  );
}

/**
 * One `agent_activity` swap row, `secondsAgo` back in the feed's ordering.
 *
 * Left `pending`: migration 044's `agent_activity_confirmed_has_hash` and
 * `_confirmed_swap_has_executed_legs` require a real settlement record beside a
 * confirmed row, and nothing this suite asserts depends on the lifecycle. The
 * nonce is not decoration either - 045 refuses a locally-signed EVM row that
 * staged a `tx_hash` without one.
 */
async function seedSwap(txHash: string, secondsAgo: number): Promise<void> {
  await sql(
    `INSERT INTO agent_activity
       (protocol_execution_id, event_index, event_role, kind, protocol,
        chain_id, chain_slug, chain_family, status, wallet_address, session_id,
        token_in_symbol, amount_in_raw, tx_hash, nonce, created_at)
     VALUES ($1, $2::int, 'swap', 'swap', 'kyberswap',
             8453, 'base', 'eip155', 'pending', $3, $4,
             'USDC', '1000000', $5, $6::bigint, NOW() - ($7 || ' seconds')::interval)`,
    [
      executionId,
      secondsAgo,
      WALLET_A.toLowerCase(),
      sessionId,
      txHash,
      secondsAgo,
      String(secondsAgo),
    ],
  );
}

beforeEach(async () => {
  sessionId = randomUUID();
  otherSessionId = randomUUID();
  suiteTag = sessionId.slice(0, 8);
  intentId = `lighter-exec-${sessionId}`;

  await sql(
    "INSERT INTO sessions (id, mode, scope) VALUES ($1, 'agent', 'vex_studio'), ($2, 'agent', 'vex_studio')",
    [sessionId, otherSessionId],
  );
  const executions = await sql<{ id: number }>(
    `INSERT INTO protocol_executions (tool_id, namespace, session_id, success)
     VALUES ('kyberswap.swap', 'kyberswap', $1, true) RETURNING id`,
    [sessionId],
  );
  executionId = executions[0]?.id ?? 0;

  // TWO wallets, ONE resolved account. Migration 124 is unique on
  // (environment, wallet_address) only, and its CHECK requires the address
  // LOWERCASE - the inventory holds the checksummed form.
  await sql(
    `INSERT INTO lighter_onboarding_workflows
       (environment, wallet_address, workflow_state, resolved_account_index)
     VALUES ('core', $1, 'ready_to_trade', $3),
            ('core', $2, 'deposit_l2_pending', $3)`,
    [WALLET_A.toLowerCase(), WALLET_B.toLowerCase(), ACCOUNT_INDEX],
  );

  // A real order-execution intent, with the preview it is required to reference
  // (migration 114/115). Seeding through raw SQL still has to produce rows
  // production could really write, and the session narrowing this suite
  // exercises is resolved THROUGH this row.
  const previewId = `lighter-preview-${sessionId}`;
  const matchHash = "a".repeat(64);
  await sql(
    `INSERT INTO lighter_order_previews
       (preview_id, session_id, match_hash, environment, account_index, api_key_index,
        market_index, side, base_amount_integer, price_integer, order_type,
        time_in_force, reduce_only, order_expiry_ms, client_order_index_policy,
        provider_version, preview_json, live_source_json, expires_at)
     VALUES ($1, $2, $3, 'core', $4, 4,
             $5, 'buy', '50000', '259809', 'market',
             'immediate-or-cancel', FALSE, 0, 'sequential',
             'test', '{}'::jsonb, '{}'::jsonb, NOW() + INTERVAL '1 hour')`,
    [previewId, sessionId, matchHash, ACCOUNT_INDEX, MARKET_INDEX],
  );
  await sql(
    `INSERT INTO lighter_order_execution_intents
       (intent_id, session_id, preview_id, match_hash, environment, account_index,
        api_key_index, market_index, side, base_amount_integer, price_integer,
        order_type, time_in_force, reduce_only, order_expiry_ms,
        client_order_index_policy, provider_version, credential_ref_json,
        execution_state, expires_at)
     VALUES ($1, $2, $3, $4, 'core', $5,
             4, $6, 'buy', '50000', '259809',
             'market', 'immediate-or-cancel', FALSE, 0,
             'sequential', 'test', '{}'::jsonb,
             'filled', NOW() + INTERVAL '1 hour')`,
    [intentId, sessionId, previewId, matchHash, ACCOUNT_INDEX, MARKET_INDEX],
  );

  // The attributed fill, the foreign account's fill, and a HELD one.
  await seedFill({
    accountIndex: ACCOUNT_INDEX,
    marketIndex: MARKET_INDEX,
    providerTradeId: `1${suiteTag.replace(/\D/g, "0")}1`,
    secondsAgo: 20,
    intent: intentId,
    marginFraction: 1000,
  });
  await seedFill({
    accountIndex: FOREIGN_ACCOUNT_INDEX,
    marketIndex: MARKET_INDEX,
    providerTradeId: `2${suiteTag.replace(/\D/g, "0")}2`,
    secondsAgo: 19,
    intent: intentId,
    marginFraction: 1000,
  });
  await seedFill({
    accountIndex: ACCOUNT_INDEX,
    marketIndex: MARKET_INDEX,
    providerTradeId: `3${suiteTag.replace(/\D/g, "0")}3`,
    secondsAgo: 18,
    intent: null,
    marginFraction: 1000,
  });

  await sql(
    `INSERT INTO lighter_position_market_state
       (environment, account_index, market_index, observed_at, observation_id, open, position)
     VALUES ('core', $1, $2, NOW(), $3, TRUE, $4::jsonb),
            ('core', $1, $5, NOW(), $3, FALSE, NULL)`,
    [
      ACCOUNT_INDEX,
      MARKET_INDEX,
      randomUUID(),
      JSON.stringify({
        marketIndex: MARKET_INDEX,
        marketSymbol: "ETH",
        size: "0.0050",
        entryPrice: "2598.09",
        unrealizedPnl: "-0.0077",
        realizedPnl: "0",
        liquidationPrice: "2365.93",
        initialMarginFraction: 1000,
        marginMode: "isolated",
      }),
      CLOSED_MARKET_INDEX,
    ],
  );

  // One activity row on each side of the fill in time.
  await seedSwap(`0xbefore-${suiteTag}`, 30);
  await seedSwap(`0xafter-${suiteTag}`, 10);
});

afterEach(async () => {
  await sql("DELETE FROM lighter_fills WHERE account_index IN ($1, $2)", [
    ACCOUNT_INDEX,
    FOREIGN_ACCOUNT_INDEX,
  ]);
  await sql("DELETE FROM lighter_position_market_state WHERE account_index = $1", [
    ACCOUNT_INDEX,
  ]);
  await sql("DELETE FROM lighter_order_execution_intents WHERE session_id = $1", [sessionId]);
  await sql("DELETE FROM lighter_order_previews WHERE session_id = $1", [sessionId]);
  await sql("DELETE FROM lighter_onboarding_workflows WHERE resolved_account_index = $1", [
    ACCOUNT_INDEX,
  ]);
  await sql("DELETE FROM agent_activity WHERE protocol_execution_id = $1", [executionId]);
  await sql("DELETE FROM protocol_executions WHERE id = $1", [executionId]);
  await sql("DELETE FROM sessions WHERE id IN ($1, $2)", [sessionId, otherSessionId]);
});

describe("the Lighter arm against a real database", () => {
  /**
   * THE DUPLICATE-MAPPING HAZARD. Two of the inventory's wallets resolve to one
   * Lighter account, which migration 124 permits. A JOIN over the workflow
   * table would emit this fill TWICE, with the same cursor id behind each copy;
   * the correlated `EXISTS` emits it once.
   */
  it("returns the attributed fill EXACTLY ONCE despite two wallets resolving to one account", async () => {
    const page = await read();
    const fills = page.entries.filter(isSeededFill);
    expect(fills).toHaveLength(1);
  });

  it("maps every field of the attributed fill", async () => {
    const page = await read();
    const fill = page.entries.filter(isSeededFill)[0];
    expect(fill).toBeDefined();
    if (fill === undefined) return;
    expect(fill.environment).toBe("core");
    expect(fill.marketIndex).toBe(MARKET_INDEX);
    expect(fill.marketSymbol).toBe("ETH");
    expect(fill.spot).toBe(false);
    expect(fill.side).toBe("buy");
    expect(fill.tradeType).toBe("trade");
    expect(fill.positionEffect).toBe("open");
    expect(fill.baseSize).toBe("0.0050");
    expect(fill.price).toBe("2598.09");
    expect(fill.quoteNotional).toBe("12.99045");
    expect(fill.usdAmount).toBe("12.99");
    expect(fill.blockHeight).toBe("10453221");
    expect(fill.baseAsset).toEqual({ symbol: "ETH", decimals: 18 });
    expect(fill.quoteAsset).toEqual({ symbol: "USDC", decimals: 6 });
    expect(fill.positionSizeBefore).toBe("0");
    expect(fill.entryQuoteBefore).toBe("0");
    expect(fill.accountPnl).toBe("0");
    // Migration 162's column, read back through the unit owner's display rule.
    expect(fill.leverage).toEqual({ initialMarginFraction: 1000, display: "10.00" });
    expect(fill.feeSide).toBe("taker");
    expect(fill.integratorFee.charged).toEqual({ raw: "3247", symbol: "USDC", decimals: 6 });
    expect(fill.integratorFee.estimate?.basis).toBe("quote_notional");
    expect(fill.integratorFee.estimate?.tickSource).toBe("observed");
    expect(fill.exchangeFee.charged).toEqual({ raw: "1299", symbol: "USDC", decimals: 6 });
    expect(fill.intentId).toBe(intentId);
    expect(fill.providerOrderId).toBe("112233");
  });

  /**
   * Two rows that must NEVER appear: a fill on an account the inventory does
   * not onboard, and a HELD fill Vex has not proven an owner for. Either would
   * attribute somebody's trading to the agent.
   */
  it("never returns a foreign account's fill or a held one", async () => {
    const page = await read();
    const fills = page.entries.filter(
      (entry): entry is AgentScanLighterFillEntry => entry.source === "lighter_fill",
    );
    // Only the attributed row survives; the other two share this suite's tag in
    // their trade ids but have no intent or no onboarded account.
    expect(fills.map((fill) => fill.intentId)).toEqual([intentId]);
    const held = await sql<{ count: string }>(
      "SELECT COUNT(*) AS count FROM lighter_fills WHERE account_index = $1 AND execution_intent_id IS NULL",
      [ACCOUNT_INDEX],
    );
    // The held row really is in the table - the feed's silence about it is the
    // predicate working, not the fixture missing.
    expect(held[0]?.count).toBe("1");
  });

  it("interleaves the fill between the activity rows by TIME", async () => {
    const page = await read();
    const timeline = page.entries
      .filter((entry) =>
        (entry.source === "agent_activity" && entry.txHash?.includes(suiteTag) === true)
        || isSeededFill(entry))
      .map((entry) => (entry.source === "lighter_fill" ? "fill" : entry.txHash));
    expect(timeline).toEqual([`0xafter-${suiteTag}`, "fill", `0xbefore-${suiteTag}`]);
  });

  it("keeps the fill when the read is narrowed to the session that ordered it", async () => {
    const page = await read({ sessionId });
    expect(page.entries.filter(isSeededFill)).toHaveLength(1);
  });

  it("drops the fill when the read is narrowed to a DIFFERENT session", async () => {
    const page = await read({ sessionId: otherSessionId });
    expect(page.entries.filter(isSeededFill)).toHaveLength(0);
  });

  it("reports the market's open position with its observation time", async () => {
    const page = await read();
    const fill = page.entries.filter(isSeededFill)[0];
    expect(fill?.positionNow?.open).toBe(true);
    expect(fill?.positionNow?.position).toEqual({
      size: "0.0050",
      entryPrice: "2598.09",
      unrealizedPnl: "-0.0077",
      realizedPnl: "0",
      liquidationPrice: "2365.93",
      leverage: { initialMarginFraction: 1000, display: "10.00" },
      marginMode: "isolated",
    });
    expect(typeof fill?.positionNow?.observedAt).toBe("string");
  });

  /** Migration 152 stores `open = false, position = NULL` for an observed closure. */
  it("reports a CLOSED market as observed-closed, not as unobserved", async () => {
    await seedFill({
      accountIndex: ACCOUNT_INDEX,
      marketIndex: CLOSED_MARKET_INDEX,
      providerTradeId: `4${suiteTag.replace(/\D/g, "0")}4`,
      secondsAgo: 15,
      intent: intentId,
      marginFraction: 5000,
    });
    const page = await read();
    const closed = page.entries
      .filter(isSeededFill)
      .find((fill) => fill.marketIndex === CLOSED_MARKET_INDEX);
    expect(closed?.positionNow?.open).toBe(false);
    expect(closed?.positionNow?.position).toBeNull();
    expect(closed?.leverage).toEqual({ initialMarginFraction: 5000, display: "2.00" });
  });

  it("reports NO observation at all for a market Vex has never observed", async () => {
    await seedFill({
      accountIndex: ACCOUNT_INDEX,
      marketIndex: 7,
      providerTradeId: `5${suiteTag.replace(/\D/g, "0")}5`,
      secondsAgo: 14,
      intent: intentId,
      marginFraction: null,
    });
    const page = await read();
    const unobserved = page.entries
      .filter(isSeededFill)
      .find((fill) => fill.marketIndex === 7);
    expect(unobserved?.positionNow).toBeNull();
    // No fraction was recorded, so the leverage is unknown - never a 0, never
    // the current one.
    expect(unobserved?.leverage).toBeNull();
  });

  it("routes by kind: `swap` excludes the arm, `lighter_fill` returns only it", async () => {
    const swaps = await read({ kinds: ["swap"] });
    expect(swaps.entries.filter(isSeededFill)).toHaveLength(0);
    expect(
      swaps.entries.some(
        (entry) => entry.source === "agent_activity" && entry.txHash?.includes(suiteTag) === true,
      ),
    ).toBe(true);

    const fills = await read({ kinds: ["lighter_fill"] });
    expect(fills.entries.filter(isSeededFill)).toHaveLength(1);
    // `lighter_fill` is a FEED kind, not an `agent_activity.kind`, so the other
    // arm matches nothing for it.
    expect(fills.entries.every((entry) => entry.source === "lighter_fill")).toBe(true);
  });

  /**
   * THE SEAM. Walking a mixed timeline with the PRODUCTION page size must visit
   * every row exactly once: an arm exhausting before the other, and a page
   * ending on either arm, are the two places a keyset merge can skip or repeat.
   */
  it("walks the mixed timeline with the real page size, skipping and repeating nothing", async () => {
    // Enough rows to cross the page size several times, on both arms.
    const extraFills = AGENT_SCAN_PAGE_SIZE + 5;
    for (let i = 0; i < extraFills; i += 1) {
      await seedFill({
        accountIndex: ACCOUNT_INDEX,
        marketIndex: MARKET_INDEX,
        providerTradeId: `9${String(i).padStart(4, "0")}${suiteTag.replace(/\D/g, "0")}`,
        secondsAgo: 100 + i * 2,
        intent: intentId,
        marginFraction: 1000,
      });
    }
    for (let i = 0; i < AGENT_SCAN_PAGE_SIZE; i += 1) {
      await seedSwap(`0xwalk-${suiteTag}-${String(i)}`, 101 + i * 2);
    }

    const seen: string[] = [];
    let cursor: AgentScanCursor | null = null;
    for (let page = 0; page < 20; page += 1) {
      const data = await read({}, cursor);
      expect(data.entries.length).toBeLessThanOrEqual(AGENT_SCAN_PAGE_SIZE);
      for (const entry of data.entries) seen.push(`${entry.source}:${entry.id}`);
      if (!data.hasMore) break;
      cursor = data.nextCursor;
      expect(cursor).not.toBeNull();
      if (cursor === null) break;
    }

    // NOTHING REPEATED: the keyset boundary is applied to both arms, so a row
    // on one arm can never be handed out again by the other's page.
    expect(new Set(seen).size).toBe(seen.length);

    // NOTHING SKIPPED: every eligible fill of this suite was visited.
    const eligible = await sql<{ id: string }>(
      `SELECT id::text AS id FROM lighter_fills
        WHERE account_index = $1 AND execution_intent_id IS NOT NULL`,
      [ACCOUNT_INDEX],
    );
    for (const fill of eligible) {
      expect(seen).toContain(`lighter_fill:${fill.id}`);
    }
  });
});
