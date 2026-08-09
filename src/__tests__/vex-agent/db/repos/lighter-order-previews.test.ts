import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  buildLighterOrderPreview,
  type LighterOrderPreviewInput,
} from "@tools/lighter/order-preview.js";
import type {
  LighterAccountResponse,
  LighterMarketDetail,
  LighterOrderBookOrdersResponse,
} from "@tools/lighter/types.js";

type QueryOneMock = Mock<
  (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>
>;
type ExecuteMock = Mock<(sql: string, params?: unknown[]) => Promise<number>>;

let mockQueryOne: QueryOneMock;
let mockExecute: ExecuteMock;

function resetMocks() {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockExecute = vi
    .fn<(sql: string, params?: unknown[]) => Promise<number>>()
    .mockResolvedValue(1);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: (sql: string, params?: unknown[]) => mockExecute(sql, params),
}));

const repo = await import("@vex-agent/db/repos/lighter-order-previews.js");

beforeEach(() => {
  resetMocks();
});

const NOW = 1786233600000;
const SESSION_ID = "session-1";

const MARKET: LighterMarketDetail = {
  symbol: "ETH",
  market_id: 0,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 0,
  status: "active",
  taker_fee: "0",
  maker_fee: "0",
  liquidation_fee: "0",
  min_base_amount: "0.001",
  min_quote_amount: "100",
  supported_size_decimals: 4,
  supported_price_decimals: 2,
  supported_quote_decimals: 6,
  order_quote_limit: "1000000000000",
  is_maker_fee_enabled: true,
  is_taker_fee_enabled: true,
};

const ORDER_BOOK: LighterOrderBookOrdersResponse = {
  code: 200,
  total_asks: 0,
  asks: [],
  total_bids: 0,
  bids: [],
};

const ACCOUNT: LighterAccountResponse = {
  code: 200,
  accounts: [{ index: 42, positions: [] }],
};

const INPUT: LighterOrderPreviewInput = {
  sessionId: SESSION_ID,
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  marketId: 0,
  side: "buy",
  baseAmount: "1",
  price: "3000",
  orderType: "limit",
  timeInForce: "good-till-time",
  reduceOnly: false,
  orderExpiry: NOW + 10 * 60 * 1000,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  nowMs: NOW,
};

function preview() {
  return buildLighterOrderPreview(
    INPUT,
    { market: MARKET, orderBook: ORDER_BOOK, account: ACCOUNT },
  );
}

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const built = preview();
  return {
    preview_id: built.previewId,
    session_id: SESSION_ID,
    match_hash: built.matchHash,
    environment: "rhc",
    account_index: "42",
    api_key_index: 7,
    market_index: 0,
    side: "buy",
    base_amount_integer: "10000",
    price_integer: "300000",
    order_type: "limit",
    time_in_force: "good-till-time",
    reduce_only: false,
    trigger_price_integer: null,
    order_expiry_ms: String(INPUT.orderExpiry),
    client_order_index_policy: "vex_assigned_uint48",
    provider_version: built.identity.providerVersion,
    preview_json: built.preview,
    live_source_json: { source: "live_lighter_public_api" },
    created_at: new Date("2026-08-10T00:00:00.000Z"),
    expires_at: new Date("2026-08-10T00:02:00.000Z"),
    ...overrides,
  };
}

describe("lighter order previews repo", () => {
  it("inserts preview columns in migration order with bounded JSON payloads", async () => {
    const built = preview();
    await repo.create({
      preview: built,
      liveSourceJson: { source: "live_lighter_public_api", endpoints: ["/api/v1/orderBookDetails"] },
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO lighter_order_previews");
    expect(sql).toContain(
      "preview_id, session_id, match_hash, environment, account_index, api_key_index,\n  market_index, side, base_amount_integer, price_integer, order_type, time_in_force",
    );
    expect(sql).toContain("$18::jsonb, $19::jsonb");
    expect(params).toEqual([
      built.previewId,
      SESSION_ID,
      built.matchHash,
      "rhc",
      42,
      7,
      0,
      "buy",
      "10000",
      "300000",
      "limit",
      "good-till-time",
      false,
      null,
      INPUT.orderExpiry,
      "vex_assigned_uint48",
      built.identity.providerVersion,
      expect.stringContaining("quoteNotional"),
      expect.stringContaining("live_lighter_public_api"),
      built.expiresAt,
    ]);
  });

  it("stores null api_key_index when the preview identity has no API-key index", async () => {
    const built = buildLighterOrderPreview(
      { ...INPUT, apiKeyIndex: null },
      { market: MARKET, orderBook: ORDER_BOOK, account: ACCOUNT },
    );

    await repo.create({ preview: built, liveSourceJson: { source: "live_lighter_public_api" } });

    const [, params] = mockExecute.mock.calls[0]!;
    expect(params![5]).toBeNull();
  });

  it("finds only fresh previews matching session, environment, and match_hash", async () => {
    const built = preview();
    await repo.findLatestFreshByMatch(SESSION_ID, "rhc", built.matchHash);

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("FROM lighter_order_previews");
    expect(sql).toContain("WHERE session_id = $1");
    expect(sql).toContain("AND environment = $2");
    expect(sql).toContain("AND match_hash = $3");
    expect(sql).toContain("AND expires_at > NOW()");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(params).toEqual([SESSION_ID, "rhc", built.matchHash]);
  });

  it("maps fresh preview rows without leaking SQL timestamp types", async () => {
    const built = preview();
    mockQueryOne.mockResolvedValueOnce(row());

    const found = await repo.findLatestFreshByMatch(SESSION_ID, "rhc", built.matchHash);

    expect(found).toMatchObject({
      previewId: built.previewId,
      sessionId: SESSION_ID,
      matchHash: built.matchHash,
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      side: "buy",
      baseAmountInteger: "10000",
      priceInteger: "300000",
      createdAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-08-10T00:02:00.000Z",
    });
    expect(found?.previewJson).toMatchObject({ symbol: "ETH" });
    expect(found?.liveSourceJson).toEqual({ source: "live_lighter_public_api" });
  });

  it("returns null when no fresh row matches", async () => {
    const result = await repo.findLatestFreshByMatch(SESSION_ID, "core", "a".repeat(64));
    expect(result).toBeNull();
  });
});
