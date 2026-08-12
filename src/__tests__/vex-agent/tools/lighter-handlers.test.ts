import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type {
  LighterAccount,
  LighterAccountOrder,
  LighterCandle,
  LighterMarket,
  LighterMarketDetail,
  LighterSimpleOrder,
  LighterTrade,
} from "@tools/lighter/types.js";

const mocks = vi.hoisted(() => ({
  client: {
    getStatus: vi.fn(),
    getSystemConfig: vi.fn(),
    getMarkets: vi.fn(),
    getMarketDetails: vi.fn(),
    getAccount: vi.fn(),
    getAccountActiveOrders: vi.fn(),
    getAccountInactiveOrders: vi.fn(),
    getAccountTrades: vi.fn(),
    getApiKeys: vi.fn(),
    getOrderBookOrders: vi.fn(),
    getRecentTrades: vi.fn(),
    getCandles: vi.fn(),
  },
  previewsRepo: {
    create: vi.fn(),
    findFreshById: vi.fn(),
  },
  executionIntentsRepo: {
    findLiveByPreview: vi.fn(),
    createApprovalPendingWith: vi.fn(),
    findByIntentId: vi.fn(),
    markApprovalDecision: vi.fn(),
  },
  sessionLock: {
    withSessionControlLock: vi.fn(),
  },
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@tools/lighter/client.js", () => ({
  getLighterClient: () => mocks.client,
}));

vi.mock("@vex-agent/db/repos/lighter-order-previews.js", () => ({
  create: mocks.previewsRepo.create,
  findFreshById: mocks.previewsRepo.findFreshById,
}));

vi.mock("@vex-agent/db/repos/lighter-order-execution-intents.js", () => ({
  findLiveByPreview: mocks.executionIntentsRepo.findLiveByPreview,
  createApprovalPendingWith: mocks.executionIntentsRepo.createApprovalPendingWith,
  findByIntentId: mocks.executionIntentsRepo.findByIntentId,
  markApprovalDecision: mocks.executionIntentsRepo.markApprovalDecision,
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: mocks.sessionLock.withSessionControlLock,
}));

vi.mock("@utils/logger.js", () => ({
  default: mocks.logger,
}));

const { LIGHTER_HANDLERS } = await import("@vex-agent/tools/protocols/lighter/handlers.js");
const { projectAccountOrders } = await import("@vex-agent/tools/protocols/lighter/projectors.js");
const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: "session-1",
};

const APPROVED_CTX: ProtocolExecutionContext = {
  ...READ_CTX,
  approved: true,
  approvalId: "approval-1",
};

const UNSAFE_INTEGER = Number.MAX_SAFE_INTEGER + 1;
const UNSAFE_INTEGER_2 = Number.MAX_SAFE_INTEGER + 3;

const MARKET: LighterMarket = {
  symbol: "ETH-USD",
  market_id: 0,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 0,
  status: "active",
  taker_fee: "0.0003",
  maker_fee: "0.0001",
  liquidation_fee: "0.01",
  min_base_amount: "0.001",
  min_quote_amount: "10",
  supported_size_decimals: 4,
  supported_price_decimals: 2,
  supported_quote_decimals: 6,
  order_quote_limit: "100000",
  is_maker_fee_enabled: true,
  is_taker_fee_enabled: true,
};

const DETAIL: LighterMarketDetail = {
  ...MARKET,
  last_trade_price: 3500,
  daily_trades_count: 42,
  daily_base_token_volume: 10,
  daily_quote_token_volume: 35000,
  daily_price_low: 3400,
  daily_price_high: 3600,
  daily_price_change: 2.5,
  open_interest: 12345,
  size_decimals: 4,
  price_decimals: 2,
  quote_multiplier: 1,
  strategy_index: 7,
  funding_clamp_small: "0.001",
  funding_clamp_big: "0.005",
  base_interest_rate: "0.02",
};

const ACCOUNT: LighterAccount = {
  index: 42,
  l1_address: "0x1111111111111111111111111111111111111111",
  status: 1,
  collateral: "1000",
  available_balance: "750",
  positions: [
    { market_id: 0, symbol: "ETH", position: "1.25", avg_entry_price: "3000" },
  ],
  assets: [
    { asset_id: 1, symbol: "USDC", balance: "750" },
  ],
};

function order(id: number, price: string): LighterSimpleOrder {
  return {
    order_index: id,
    order_id: `order-${id}`,
    owner_account_index: 100 + id,
    initial_base_amount: "1",
    remaining_base_amount: "0.5",
    price,
    order_expiry: 1786233600000,
    transaction_time: 1786147200000 + id,
  };
}

function trade(id: number): LighterTrade {
  return {
    trade_id: id,
    trade_id_str: String(id),
    tx_hash: `0x${id}`,
    type: "trade",
    market_id: 0,
    size: "0.25",
    price: "3500",
    usd_amount: "875",
    ask_id: 10,
    ask_id_str: "10",
    bid_id: 11,
    bid_id_str: "11",
    ask_account_id: 12,
    bid_account_id: 13,
    is_maker_ask: true,
    block_height: 99,
    timestamp: 1786147200000 + id,
    transaction_time: 1786147200000 + id,
  };
}

function accountOrder(): LighterAccountOrder {
  return {
    order_index: UNSAFE_INTEGER,
    client_order_index: UNSAFE_INTEGER_2,
    order_id: String(UNSAFE_INTEGER),
    client_order_id: String(UNSAFE_INTEGER_2),
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "100",
    remaining_base_amount: "50",
    filled_base_amount: "50",
    filled_quote_amount: "15000000",
    price: "300000",
    side: "buy",
    type: "limit",
    time_in_force: "good_till_time",
    reduce_only: false,
    order_expiry: 1786233600000,
    status: "open",
    timestamp: 1786147200000,
    created_at: 1786147200000,
    updated_at: 1786147200001,
    transaction_time: 1786147200000,
  };
}

function candle(index: number): LighterCandle {
  return {
    t: 1786147200000 + index * 60_000,
    o: index,
    h: index + 1,
    l: index - 1,
    c: index + 0.5,
    v: index * 2,
    V: index * 2000,
    i: index,
  };
}

function previewRow() {
  return {
    previewId: "lighter-preview-1",
    sessionId: "session-1",
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "10000",
    priceInteger: "300000",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: 1893456000000,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-preview-v1",
    previewJson: { symbol: "ETH" },
    liveSourceJson: { source: "live_lighter_public_api" },
    createdAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
  } as const;
}

function executionIntentRow(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    previewId: "lighter-preview-1",
    protocolExecutionId: null,
    approvalId: null,
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "10000",
    priceInteger: "300000",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: 1893456000000,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-preview-v1",
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    decisionReason: null,
    decidedAt: null,
    nonceReservationId: null,
    nonceValue: null,
    createdAt: "2026-08-12T00:00:01.000Z",
    updatedAt: "2026-08-12T00:00:02.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function callJson(toolId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = LIGHTER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`missing handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success, result.output).toBe(true);
  return JSON.parse(result.output) as Record<string, unknown>;
}

async function callFail(toolId: string, params: Record<string, unknown>): Promise<string> {
  const handler = LIGHTER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`missing handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success).toBe(false);
  return result.output;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionLock.withSessionControlLock.mockImplementation(async (_sessionId, fn) => fn({}));
});

describe("Lighter agent read handlers", () => {
  it("prepares an approval-gated Lighter order create without signing or submitting", async () => {
    mocks.previewsRepo.findFreshById.mockResolvedValueOnce(previewRow());
    mocks.executionIntentsRepo.findLiveByPreview.mockResolvedValueOnce(null);
    mocks.executionIntentsRepo.createApprovalPendingWith.mockResolvedValueOnce(executionIntentRow());

    const result = await LIGHTER_HANDLERS["lighter.order.create.prepare"]!({
      environment: "rhc",
      previewId: "lighter-preview-1",
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    }, READ_CTX);

    expect(result.success, result.output).toBe(true);
    expect(mocks.previewsRepo.findFreshById).toHaveBeenCalledWith(
      "session-1",
      "rhc",
      "lighter-preview-1",
    );
    expect(mocks.executionIntentsRepo.createApprovalPendingWith).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        intentId: expect.stringMatching(/^lighter-exec-/),
        preview: expect.objectContaining({
          previewId: "lighter-preview-1",
          apiKeyIndex: 7,
        }),
        credentialReadiness: expect.objectContaining({
          ready: true,
          nonceScope: {
            environment: "rhc",
            accountIndex: 42,
            apiKeyIndex: 7,
          },
        }),
      }),
    );
    expect(result.preparedActionFollowUp).toEqual({
      toolName: "execute_tool",
      args: {
        toolId: "lighter.order.create",
        params: { intentId: "lighter-exec-00000000-0000-4000-8000-000000000001" },
      },
      expiresAt: "2030-01-01T00:00:00.000Z",
      approvalPreview: {
        toolName: "execute_tool",
        criticalArgs: expect.objectContaining({
          toolId: "lighter.order.create",
          intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
          environment: "rhc",
          accountIndex: 42,
          apiKeyIndex: 7,
          matchHash: "a".repeat(64),
        }),
      },
    });
    const data = JSON.parse(result.output) as Record<string, unknown>;
    expect(data).toMatchObject({
      source: "vex_lighter_local_execution_intent",
      status: "approval_prepared",
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
    });
  });

  it("refuses raw secret-shaped credential references during create preparation", async () => {
    mocks.previewsRepo.findFreshById.mockResolvedValueOnce(previewRow());

    const result = await LIGHTER_HANDLERS["lighter.order.create.prepare"]!({
      environment: "rhc",
      previewId: "lighter-preview-1",
      vaultCredentialId: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }, READ_CTX);

    expect(result.success).toBe(false);
    expect(result.output).toContain("opaque local vault reference");
    expect(result.output).not.toContain("0123456789abcdef");
    expect(mocks.executionIntentsRepo.createApprovalPendingWith).not.toHaveBeenCalled();
  });

  it("keeps lighter.order.create behind the protocol approval gate in restricted mode", async () => {
    const result = await executeProtocolTool({
      toolId: "lighter.order.create",
      params: { intentId: "lighter-exec-00000000-0000-4000-8000-000000000001" },
    }, READ_CTX);

    expect(result).toMatchObject({
      success: false,
      pendingApproval: true,
      actionKind: "external_post",
    });
    expect(mocks.executionIntentsRepo.findByIntentId).not.toHaveBeenCalled();
  });

  it("records an approved Lighter create decision but refuses before signer submission", async () => {
    mocks.executionIntentsRepo.findByIntentId.mockResolvedValueOnce(executionIntentRow());
    mocks.executionIntentsRepo.markApprovalDecision.mockResolvedValueOnce(executionIntentRow({
      approvalId: "approval-1",
      approvalStatus: "approved",
      decisionReason: "user approved exact Lighter order create intent",
      decidedAt: "2026-08-12T00:01:00.000Z",
    }));

    const result = await LIGHTER_HANDLERS["lighter.order.create"]!({
      intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    }, APPROVED_CTX);

    expect(mocks.executionIntentsRepo.markApprovalDecision).toHaveBeenCalledWith({
      intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
      decision: "approved",
      approvalId: "approval-1",
      reason: "user approved exact Lighter order create intent",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("No order was signed or submitted.");
  });

  it("reads system status and config for the requested environment", async () => {
    mocks.client.getStatus.mockResolvedValue({
      status: 200,
      network_id: 4663,
      timestamp: 1786147200000,
    });
    mocks.client.getSystemConfig.mockResolvedValue({
      code: 200,
      message: "ok",
      liquidity_pool_index: 1,
      staking_pool_index: 2,
      funding_fee_rebate_account_index: 3,
      market_maker_incentive_account_index: 4,
      liquidity_pool_cooldown_period: 5,
      staking_pool_lockup_period: 6,
      max_integrator_perps_maker_fee: 7,
      max_integrator_perps_taker_fee: 8,
      max_integrator_spot_maker_fee: 9,
      max_integrator_spot_taker_fee: 10,
    });

    const data = await callJson("lighter.system", { environment: "rhc" });

    expect(mocks.client.getStatus).toHaveBeenCalledWith("rhc");
    expect(mocks.client.getSystemConfig).toHaveBeenCalledWith("rhc");
    expect(data.environment).toBe("rhc");
    expect((data.status as Record<string, unknown>).networkId).toBe(4663);
    expect((data.systemConfig as Record<string, unknown>).liquidityPoolIndex).toBe(1);
  });

  it("lists markets with deterministic ordering, paging, and bounded output", async () => {
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        { ...MARKET, market_id: 56, symbol: "ZK" },
        { ...MARKET, market_id: 2, symbol: "SOL-USD", status: "inactive" },
        { ...MARKET, market_id: 2, symbol: "SOL-USD" },
        { ...MARKET, market_id: 1, symbol: "BTC-USD" },
        MARKET,
      ],
    });

    const data = await callJson("lighter.markets", {
      environment: "core",
      filter: "perp",
      limit: 2,
      page: 1,
    });

    expect(mocks.client.getMarkets).toHaveBeenCalledWith("core", { filter: "perp" });
    expect(data.count).toBe(2);
    expect(data.totalProviderRows).toBe(5);
    expect(data.truncated).toBe(true);
    expect(data.lastPage).toBe(3);
    expect(data.nextPage).toBe(2);
    expect(data.sorting).toEqual({ markets: "active_first_market_id_ascending" });
    expect(data.truncationNote).toContain("Request page 2");
    expect((data.markets as Record<string, unknown>[]).map((market) => market.symbol)).toEqual([
      "ETH-USD",
      "BTC-USD",
    ]);
  });

  it("rejects a market page past the live result set", async () => {
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        MARKET,
        { ...MARKET, market_id: 1, symbol: "BTC-USD" },
        { ...MARKET, market_id: 2, symbol: "SOL-USD" },
      ],
    });

    const output = await callFail("lighter.markets", {
      environment: "core",
      limit: 2,
      page: 10,
    });

    expect(output).toContain("page 10 is past the last page (2)");
    expect(output).toContain("Request page 2 or lower");
  });

  it("gets one market detail and refuses a missing market cleanly", async () => {
    mocks.client.getMarketDetails.mockResolvedValueOnce({
      code: 200,
      order_book_details: [DETAIL],
      spot_order_book_details: [],
    });

    const data = await callJson("lighter.market.get", {
      environment: "rhc",
      marketId: 0,
      filter: "all",
    });

    expect(mocks.client.getMarketDetails).toHaveBeenCalledWith("rhc", { marketId: 0, filter: "all" });
    expect(data.count).toBe(1);
    expect((data.details as Record<string, unknown>[])[0]?.lastTradePrice).toBe(3500);

    mocks.client.getMarketDetails.mockResolvedValueOnce({
      code: 200,
      order_book_details: [],
      spot_order_book_details: [],
    });
    const output = await callFail("lighter.market.get", { environment: "rhc", marketId: 999 });
    expect(output).toContain("No Lighter market detail found");
  });

  it("reads public account state by account index without credentials", async () => {
    mocks.client.getAccount.mockResolvedValue({
      code: 200,
      total: 1,
      accounts: [ACCOUNT],
    });

    const data = await callJson("lighter.account.get", {
      environment: "rhc",
      accountIndex: 42,
      activeOnly: true,
    });

    expect(mocks.client.getAccount).toHaveBeenCalledWith("rhc", {
      by: "index",
      value: 42,
      activeOnly: true,
    });
    expect((data.provenance as Record<string, unknown>).authenticated).toBe(false);
    expect(data.count).toBe(1);
    const account = (data.accounts as Record<string, unknown>[])[0]!;
    expect(account.accountIndex).toBe(42);
    expect(account.positionCount).toBe(1);
  });

  it("reads public positions by l1 address", async () => {
    mocks.client.getAccount.mockResolvedValue({
      code: 200,
      total: 1,
      accounts: [ACCOUNT],
    });

    const data = await callJson("lighter.positions", {
      environment: "core",
      l1Address: "0x1111111111111111111111111111111111111111",
    });

    expect(mocks.client.getAccount).toHaveBeenCalledWith("core", {
      by: "l1_address",
      value: "0x1111111111111111111111111111111111111111",
      activeOnly: undefined,
    });
    const account = (data.accounts as Record<string, unknown>[])[0]!;
    expect(account.count).toBe(1);
    expect(account.positions).toEqual(ACCOUNT.positions);
  });

  it("rejects ambiguous account lookup params before reaching the client", async () => {
    const output = await callFail("lighter.account.get", {
      environment: "core",
      accountIndex: 42,
      l1Address: "0x1111111111111111111111111111111111111111",
    });

    expect(output).toContain("Provide either accountIndex or l1Address, not both");
    expect(mocks.client.getAccount).not.toHaveBeenCalled();
  });

  it("reads authenticated open orders with credential-defaulted account provenance", async () => {
    mocks.client.getAccountActiveOrders.mockResolvedValue({
      code: 200,
      orders: [accountOrder()],
    });

    const data = await callJson("lighter.openOrders", {
      environment: "rhc",
      marketId: 0,
      filter: "perp",
      limit: 1,
    });

    expect(mocks.client.getAccountActiveOrders).toHaveBeenCalledWith("rhc", {
      marketId: 0,
      marketType: "perp",
    });
    expect(data.source).toBe("live_lighter_read_only_account_api");
    expect((data.provenance as Record<string, unknown>).authenticated).toBe(true);
    expect((data.provenance as Record<string, unknown>).credentialCapability).toBe("read_only_account_data");
    expect(data.accountIndexSource).toBe("credential");
    const order = (data.orders as Record<string, unknown>[])[0]!;
    expect(order.orderIndex).toBe(String(UNSAFE_INTEGER));
    expect(order.clientOrderIndex).toBe(String(UNSAFE_INTEGER_2));
  });

  it("reads authenticated order history for an explicit account", async () => {
    mocks.client.getAccountInactiveOrders.mockResolvedValue({
      code: 200,
      next_cursor: "cursor-1",
      orders: [accountOrder(), { ...accountOrder(), order_id: "2", client_order_id: "3" }],
    });

    const data = await callJson("lighter.orderHistory", {
      environment: "core",
      accountIndex: 42,
      limit: 1,
    });

    expect(mocks.client.getAccountInactiveOrders).toHaveBeenCalledWith("core", {
      accountIndex: 42,
      limit: 1,
    });
    expect(data.accountIndexSource).toBe("caller");
    expect(data.accountIndex).toBe(42);
    expect(data.truncated).toBe(true);
    expect(data.nextCursor).toBe("cursor-1");
    expect((data.orders as Record<string, unknown>[])).toHaveLength(1);
  });

  it("reads authenticated account trades with exact trade ids", async () => {
    const unsafeTrade: LighterTrade = {
      ...trade(1),
      trade_id: UNSAFE_INTEGER,
      trade_id_str: String(UNSAFE_INTEGER),
      ask_id: UNSAFE_INTEGER,
      ask_id_str: String(UNSAFE_INTEGER),
      bid_id: UNSAFE_INTEGER_2,
      bid_id_str: String(UNSAFE_INTEGER_2),
    };
    mocks.client.getAccountTrades.mockResolvedValue({
      code: 200,
      next_cursor: "cursor-1",
      trades: [unsafeTrade],
    });

    const data = await callJson("lighter.trades", {
      environment: "rhc",
      accountIndex: 42,
      limit: 1,
    });

    expect(mocks.client.getAccountTrades).toHaveBeenCalledWith("rhc", {
      accountIndex: 42,
      limit: 1,
      sortBy: "timestamp",
    });
    expect(data.source).toBe("live_lighter_read_only_account_api");
    const fill = (data.trades as Record<string, unknown>[])[0]!;
    expect(fill.tradeId).toBe(String(UNSAFE_INTEGER));
    expect(fill.tradeIdNumeric).toBeNull();
    expect(fill.askOrderId).toBe(String(UNSAFE_INTEGER));
    expect(fill.bidOrderId).toBe(String(UNSAFE_INTEGER_2));
  });

  it("reads public API-key nonce metadata with bounded rows", async () => {
    mocks.client.getApiKeys.mockResolvedValue({
      code: 200,
      api_keys: [
        {
          account_index: 42,
          api_key_index: 1,
          nonce: 1784732515923,
          public_key: "96432015bb5cb590489b59727a29deeca4a55d6f416cd28c48220ec3572a1fcfe0d6b21b9b1f852a",
          transaction_time: 1784732516903382,
        },
        {
          account_index: 42,
          api_key_index: 2,
          nonce: UNSAFE_INTEGER,
          public_key: "994b3b72a6a10aa0e549653fef776c0b89a29dd127a723b17d42f0b563ee1496ea78262e2899d573",
          transaction_time: UNSAFE_INTEGER,
        },
      ],
    });

    const data = await callJson("lighter.apiKeys.inspect", {
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 255,
      limit: 1,
    });

    expect(mocks.client.getApiKeys).toHaveBeenCalledWith("rhc", {
      accountIndex: 42,
      apiKeyIndex: 255,
    });
    expect(data.source).toBe("live_lighter_public_api");
    expect(data.accountIndex).toBe(42);
    expect(data.apiKeyIndex).toBe(255);
    expect(data.count).toBe(1);
    expect(data.totalProviderRows).toBe(2);
    expect(data.truncated).toBe(true);
    const key = (data.apiKeys as Record<string, unknown>[])[0]!;
    expect(key.apiKeyIndex).toBe(1);
    expect(key.nonce).toBe(1784732515923);
    expect(key.noncePrecision).toBe("safe");
    expect(key.publicKey).toContain("96432015");
  });

  it("refuses API-key metadata without accountIndex before provider reads", async () => {
    const output = await callFail("lighter.apiKeys.inspect", {
      environment: "core",
    });

    expect(output).toBe("Missing required: accountIndex.");
    expect(mocks.client.getApiKeys).not.toHaveBeenCalled();
  });

  it("creates a persisted order preview from live market, order book, and account reads", async () => {
    mocks.client.getMarketDetails.mockResolvedValue({
      code: 200,
      order_book_details: [DETAIL],
      spot_order_book_details: [],
    });
    mocks.client.getOrderBookOrders.mockResolvedValue({
      code: 200,
      total_asks: 1,
      asks: [order(1, "3500.50")],
      total_bids: 1,
      bids: [order(2, "3499.50")],
    });
    mocks.client.getAccount.mockResolvedValue({
      code: 200,
      accounts: [ACCOUNT],
    });
    mocks.previewsRepo.create.mockResolvedValue(undefined);

    const data = await callJson("lighter.order.preview", {
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketId: 0,
      side: "buy",
      baseAmount: "0.25",
      price: "3499.99",
      orderType: "limit",
      timeInForce: "good-till-time",
      reduceOnly: false,
      orderExpiry: Date.now() + 10 * 60 * 1000,
      clientOrderIndexPolicy: "vex_assigned_uint48",
    });

    expect(mocks.client.getMarketDetails).toHaveBeenCalledWith("rhc", {
      marketId: 0,
      filter: "all",
    });
    expect(mocks.client.getOrderBookOrders).toHaveBeenCalledWith("rhc", {
      marketId: 0,
      limit: 10,
    });
    expect(mocks.client.getAccount).toHaveBeenCalledWith("rhc", {
      by: "index",
      value: 42,
      activeOnly: true,
    });
    expect(mocks.previewsRepo.create).toHaveBeenCalledTimes(1);
    const persisted = mocks.previewsRepo.create.mock.calls[0]![0] as {
      readonly preview: { readonly matchHash: string };
    };
    expect(persisted.preview.matchHash).toBe(data.matchHash);
    expect(data.previewId).toMatch(/^lop_[0-9a-f]{24}$/);
    expect(data.source).toBe("live_lighter_public_api");
    expect((data.preview as Record<string, unknown>).symbol).toBe("ETH-USD");
    expect(((data.preview as Record<string, unknown>).baseAmount as Record<string, unknown>).integer).toBe("2500");
    expect(((data.preview as Record<string, unknown>).price as Record<string, unknown>).integer).toBe("349999");
  });

  it("refuses order preview without a host session id", async () => {
    const handler = LIGHTER_HANDLERS["lighter.order.preview"];
    expect(handler).toBeDefined();
    const result = await handler!({
      environment: "rhc",
      accountIndex: 42,
      marketId: 0,
      side: "buy",
      baseAmount: "0.25",
      price: "3499.99",
      orderType: "limit",
      timeInForce: "good-till-time",
      reduceOnly: false,
      orderExpiry: Date.now() + 10 * 60 * 1000,
      clientOrderIndexPolicy: "vex_assigned_uint48",
    }, { ...READ_CTX, sessionId: undefined });

    expect(result.success).toBe(false);
    expect(result.output).toContain("host session id");
    expect(mocks.client.getMarketDetails).not.toHaveBeenCalled();
    expect(mocks.previewsRepo.create).not.toHaveBeenCalled();
  });

  it("sorts order book orders into best price order before truncating", async () => {
    const asks = Object.freeze([
      order(1, "3503"),
      { ...order(2, "3501"), order_index: UNSAFE_INTEGER, order_id: String(UNSAFE_INTEGER) },
      order(3, "3502"),
    ]);
    const bids = Object.freeze([
      order(4, "3498"),
      { ...order(5, "3500"), order_index: UNSAFE_INTEGER_2, order_id: String(UNSAFE_INTEGER_2) },
      order(6, "3499"),
    ]);
    mocks.client.getOrderBookOrders.mockResolvedValue({
      code: 200,
      total_asks: 3,
      asks,
      total_bids: 3,
      bids,
    });

    const data = await callJson("lighter.orderbook", {
      environment: "rhc",
      marketId: 0,
      limit: 2,
    });

    expect(mocks.client.getOrderBookOrders).toHaveBeenCalledWith("rhc", { marketId: 0, limit: 2 });
    expect(data.shownAsks).toBe(2);
    expect(data.shownBids).toBe(2);
    expect(data.asksTruncated).toBe(true);
    expect(data.bidsTruncated).toBe(true);
    expect(data.sorting).toEqual({
      asks: "price_ascending",
      bids: "price_descending",
    });
    const projectedAsks = data.asks as Record<string, unknown>[];
    const projectedBids = data.bids as Record<string, unknown>[];
    expect(projectedAsks.map((row) => row.price)).toEqual(["3501", "3502"]);
    expect(projectedBids.map((row) => row.price)).toEqual(["3500", "3499"]);
    expect(projectedAsks[0]?.orderIndex).toBeNull();
    expect(projectedAsks[0]?.orderIndexPrecision).toBe("unsafe_provider_number_omitted");
    expect(projectedBids[0]?.orderIndex).toBeNull();
    expect(projectedBids[0]?.orderIndexPrecision).toBe("unsafe_provider_number_omitted");
  });

  it("reads recent trades with bounded rows and next cursor disclosure", async () => {
    const unsafeTrade: LighterTrade = {
      ...trade(1),
      trade_id: UNSAFE_INTEGER,
      trade_id_str: String(UNSAFE_INTEGER),
      ask_id: UNSAFE_INTEGER,
      ask_id_str: String(UNSAFE_INTEGER),
      bid_id: UNSAFE_INTEGER_2,
      bid_id_str: String(UNSAFE_INTEGER_2),
    };
    mocks.client.getRecentTrades.mockResolvedValue({
      code: 200,
      next_cursor: "cursor-1",
      trades: [unsafeTrade, trade(2), trade(3)],
    });

    const data = await callJson("lighter.recentTrades", {
      environment: "core",
      marketId: 0,
      limit: 2,
    });

    expect(mocks.client.getRecentTrades).toHaveBeenCalledWith("core", { marketId: 0, limit: 2 });
    expect(data.count).toBe(2);
    expect(data.totalProviderRows).toBe(3);
    expect(data.truncated).toBe(true);
    expect(data.nextCursor).toBe("cursor-1");
    const first = (data.trades as Record<string, unknown>[])[0]!;
    expect(first.tradeId).toBe(String(UNSAFE_INTEGER));
    expect(first.tradeIdPrecision).toBe("provider_string_canonical");
    expect(first.tradeIdNumeric).toBeNull();
    expect(first.tradeIdNumericPrecision).toBe("unsafe_provider_number_omitted");
    expect(first.askOrderId).toBe(String(UNSAFE_INTEGER));
    expect(first.askOrderIdNumeric).toBeNull();
    expect(first.askOrderIdNumericPrecision).toBe("unsafe_provider_number_omitted");
    expect(first.bidOrderId).toBe(String(UNSAFE_INTEGER_2));
    expect(first.bidOrderIdNumeric).toBeNull();
    expect(first.bidOrderIdNumericPrecision).toBe("unsafe_provider_number_omitted");
  });

  it("projects account order identifiers as exact provider strings", () => {
    const data = projectAccountOrders({
      code: 200,
      next_cursor: "cursor-1",
      orders: [accountOrder()],
    }, 1);

    const first = data.orders[0] as Record<string, unknown>;
    expect(data.nextCursor).toBe("cursor-1");
    expect(first.orderIndex).toBe(String(UNSAFE_INTEGER));
    expect(first.orderIndexPrecision).toBe("provider_string_canonical");
    expect(first.orderIndexNumeric).toBeNull();
    expect(first.orderIndexNumericPrecision).toBe("unsafe_provider_number_omitted");
    expect(first.clientOrderIndex).toBe(String(UNSAFE_INTEGER_2));
    expect(first.clientOrderIndexPrecision).toBe("provider_string_canonical");
    expect(first.clientOrderIndexNumeric).toBeNull();
    expect(first.clientOrderIndexNumericPrecision).toBe("unsafe_provider_number_omitted");
  });

  it("reads candles with millisecond timestamps and caps agent output to newest rows", async () => {
    mocks.client.getCandles.mockResolvedValue({
      code: 200,
      r: "1m",
      c: Array.from({ length: 105 }, (_, index) => candle(index)),
    });

    const data = await callJson("lighter.candles", {
      environment: "rhc",
      marketId: 0,
      resolution: "1m",
      startTimestamp: 1786147200000,
      endTimestamp: 1786153500000,
      countBack: 105,
      setTimestampToEnd: true,
    });

    expect(mocks.client.getCandles).toHaveBeenCalledWith("rhc", {
      marketId: 0,
      resolution: "1m",
      startTimestamp: 1786147200000,
      endTimestamp: 1786153500000,
      countBack: 105,
      setTimestampToEnd: true,
    });
    expect(data.count).toBe(100);
    expect(data.totalProviderRows).toBe(105);
    expect(data.truncated).toBe(true);
    expect((data.candles as Record<string, unknown>[])[0]?.index).toBe(5);
  });

  it("rejects missing or invalid params before reaching the client", async () => {
    const missingEnv = await callFail("lighter.orderbook", { marketId: 0 });
    expect(missingEnv).toContain("Missing required: environment");

    const secondsTimestamp = await callFail("lighter.candles", {
      environment: "rhc",
      marketId: 0,
      resolution: "1m",
      startTimestamp: 1786147200,
      endTimestamp: 1786150800,
    });
    expect(secondsTimestamp).toContain("epoch milliseconds");

    expect(mocks.client.getOrderBookOrders).not.toHaveBeenCalled();
    expect(mocks.client.getCandles).not.toHaveBeenCalled();
  });

  it("enforces the production runtime parameter gate before handlers run", async () => {
    const unknownParam = await executeProtocolTool({
      toolId: "lighter.markets",
      params: { environment: "rhc", unexpected: true },
    }, READ_CTX);
    expect(unknownParam.success).toBe(false);
    expect(unknownParam.output).toContain('Unknown parameter "unexpected"');
    expect(unknownParam.output).toContain("Allowed parameters: environment, marketId, filter, limit, page");

    const badEnvironment = await executeProtocolTool({
      toolId: "lighter.markets",
      params: { environment: "robinhood" },
    }, READ_CTX);
    expect(badEnvironment.success).toBe(false);
    expect(badEnvironment.output).toContain('Allowed values for "environment"');
    expect(badEnvironment.output).toContain("core, rhc");

    expect(mocks.client.getMarkets).not.toHaveBeenCalled();
  });

  it("returns a scrubbed failure when the public client rejects", async () => {
    mocks.client.getMarkets.mockRejectedValue(new Error("provider timeout after 10000ms"));

    const output = await callFail("lighter.markets", { environment: "rhc" });

    expect(output).toContain("Lighter markets unavailable");
    expect(output).toContain("provider timeout");
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "lighter.handler.error",
      expect.objectContaining({ toolId: "lighter.markets" }),
    );
  });
});
