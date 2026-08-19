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
    getNextNonce: vi.fn(),
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
    findLatestFresh: vi.fn(),
  },
  executionIntentsRepo: {
    findLiveByPreview: vi.fn(),
    createApprovalPendingWith: vi.fn(),
    findByIntentId: vi.fn(),
    markApprovalDecision: vi.fn(),
    listUnresolved: vi.fn(),
    findByIntentIdAnySession: vi.fn(),
    markRepairResolved: vi.fn(),
  },
  nonceStateRepo: {
    find: vi.fn(),
    releaseReservation: vi.fn(),
    recordExecutionObserved: vi.fn(),
  },
  approvalsRepo: {
    getByIdForSession: vi.fn(),
  },
  approvalIntentsRepo: {
    getByApprovalId: vi.fn(),
  },
  sessionLock: {
    withSessionControlLock: vi.fn(),
  },
  onboarding: {
    buildReaders: vi.fn(),
    resolveStatus: vi.fn(),
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
  findLatestFresh: mocks.previewsRepo.findLatestFresh,
}));

vi.mock("@vex-agent/db/repos/lighter-order-execution-intents.js", () => ({
  findLiveByPreview: mocks.executionIntentsRepo.findLiveByPreview,
  createApprovalPendingWith: mocks.executionIntentsRepo.createApprovalPendingWith,
  findByIntentId: mocks.executionIntentsRepo.findByIntentId,
  markApprovalDecision: mocks.executionIntentsRepo.markApprovalDecision,
  listUnresolved: mocks.executionIntentsRepo.listUnresolved,
  findByIntentIdAnySession: mocks.executionIntentsRepo.findByIntentIdAnySession,
  markRepairResolved: mocks.executionIntentsRepo.markRepairResolved,
  LIGHTER_ORDER_UNRESOLVED_EXECUTION_STATES: [
    "signed",
    "submitted",
    "api_accepted",
    "sequencer_pending",
    "ambiguous",
  ],
}));

vi.mock("@vex-agent/db/repos/lighter-nonce-state.js", () => ({
  find: mocks.nonceStateRepo.find,
  releaseReservation: mocks.nonceStateRepo.releaseReservation,
  recordExecutionObserved: mocks.nonceStateRepo.recordExecutionObserved,
}));

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: mocks.approvalsRepo.getByIdForSession,
}));

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: mocks.approvalIntentsRepo.getByApprovalId,
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: mocks.sessionLock.withSessionControlLock,
}));

vi.mock("@tools/lighter/wallet-funding/onboarding-readers.js", () => ({
  buildLighterOnboardingReaders: mocks.onboarding.buildReaders,
}));

vi.mock("@tools/lighter/wallet-funding/onboarding-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/lighter/wallet-funding/onboarding-status.js")>()),
  resolveLighterOnboardingStatus: mocks.onboarding.resolveStatus,
}));

vi.mock("@utils/logger.js", () => ({
  default: mocks.logger,
}));

const { LIGHTER_HANDLERS } = await import("@vex-agent/tools/protocols/lighter/handlers.js");
const { projectAccountOrders } = await import("@vex-agent/tools/protocols/lighter/projectors.js");
const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
const { configureLighterTradingCredentialScopeResolver } = await import(
  "@vex-agent/tools/protocols/lighter/trading-credential-scope.js"
);
const { configureLighterReadOnlyAccountAuthResolver } = await import(
  "@vex-agent/tools/protocols/lighter/read-account-auth.js"
);
const { configureLighterKeyRegistrationExecutor } = await import(
  "@vex-agent/tools/protocols/lighter/key-registration-execution.js"
);
const { configureLighterManagedTradingReadinessResolver } = await import(
  "@vex-agent/tools/protocols/lighter/managed-trading-readiness.js"
);
const { validatePreparedActionFollowUp } = await import(
  "@vex-agent/tools/registry/prepared-action-follow-ups.js"
);

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
const FULL_CTX: ProtocolExecutionContext = {
  ...READ_CTX,
  sessionPermission: "full",
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
    previewJson: {
      symbol: "ETH",
      baseAmount: { display: "1", integer: "10000", decimals: 4 },
      price: { display: "3000", integer: "300000", decimals: 2 },
      quoteNotional: { display: "3000", integer: "3000000000", decimals: 6 },
    },
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

function approvalQueueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    toolCall: {
      command: "execute_tool",
      args: {
        toolId: "lighter.order.create",
        params: {
          intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
        },
      },
    },
    reasoning: "Lighter order create prepared; approval required.",
    status: "approved",
    sessionId: "session-1",
    toolCallId: "tool-call-1",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-08-12T00:00:03.000Z",
    resolvedAt: "2026-08-12T00:00:04.000Z",
    ...overrides,
  };
}

function approvalIntentAuditRow(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-1",
    sessionId: "session-1",
    missionRunId: null,
    toolCallId: "tool-call-1",
    actionKind: "external_post",
    riskLevel: "high",
    previewJson: {
      toolName: "order.create",
      namespace: "lighter",
      criticalArgs: {
        orderSummary:
          "Buy 1 ETH at limit price 3000 (est. notional 3000) on Robinhood Chain Lighter (rhc); "
          + "good-till-time; expires 2030-01-01T00:00:00.000Z. API acceptance is not final execution.",
        marketSymbol: "ETH",
        baseAmountDisplay: "1",
        priceDisplay: "3000",
        notionalDisplay: "3000",
        orderExpiryIso: "2030-01-01T00:00:00.000Z",
        toolId: "lighter.order.create",
        intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
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
        previewId: "lighter-preview-1",
        matchHash: "a".repeat(64),
      },
    },
    policyJson: {},
    expiresAt: "2030-01-01T00:00:00.000Z",
    idempotencyKey: null,
    createdAt: "2026-08-12T00:00:03.000Z",
    decidedAt: "2026-08-12T00:00:04.000Z",
    decision: "approved",
    decisionReason: "user approved exact Lighter order create intent",
    executionStatus: "dispatching",
    executionResultHash: null,
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
  delete process.env.LIGHTER_RHC_READ_ONLY_AUTH_TOKEN;
  delete process.env.LIGHTER_CORE_READ_ONLY_AUTH_TOKEN;
  configureLighterTradingCredentialScopeResolver({
    findSavedScope: () => null,
    findDefaultScope: () => null,
  });
  configureLighterManagedTradingReadinessResolver(null);
  configureLighterReadOnlyAccountAuthResolver(null);
  mocks.sessionLock.withSessionControlLock.mockImplementation(async (_sessionId, fn) => fn({}));
  mocks.approvalsRepo.getByIdForSession.mockResolvedValue(approvalQueueRow());
  mocks.approvalIntentsRepo.getByApprovalId.mockResolvedValue(approvalIntentAuditRow());
  mocks.onboarding.buildReaders.mockReturnValue({ marker: "onboarding-readers" });
});

describe("Lighter agent read handlers", () => {
  it("asks a new user only for their desired USDC deposit amount", async () => {
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "5000000",
      walletCanAcquireSettlement: true,
      accountExists: false,
      accountIndex: null,
      accountCollateralUnits: "0",
      tradingKeyRegistered: false,
      requiredCollateralUnits: "1000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [
          { kind: "approve_settlement_asset", reason: "approval" },
          { kind: "deposit", reason: "first deposit" },
          { kind: "register_trading_key", reason: "secure setup" },
        ],
        ready: false,
        blocked: null,
        depositUnits: "1000000",
        acquireUnits: null,
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
    });

    expect(mocks.onboarding.resolveStatus).toHaveBeenCalledWith(
      { marker: "onboarding-readers" },
      expect.objectContaining({ requiredCollateralUnits: 1_000_000n }),
    );
    expect(data.depositAmountProvided).toBe(false);
    expect(data.fundingRoute).toEqual({
      kind: "ask_for_deposit_amount",
      toolId: null,
      params: null,
    });
    expect(data.userGuidance).toContain("How much USDC do you want to deposit?");
    expect(data.userGuidance).not.toContain("provide your account index");
    expect(data.userGuidance).not.toContain("choose an API-key index");
  });

  it("routes a known trade shortfall directly to the deposit approval card", async () => {
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "2070000",
      walletCanAcquireSettlement: true,
      accountExists: true,
      accountIndex: 42,
      accountCollateralUnits: "1000000",
      tradingKeyRegistered: true,
      requiredCollateralUnits: "2000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [
          { kind: "approve_settlement_asset", reason: "approval" },
          { kind: "deposit", reason: "top up" },
        ],
        ready: false,
        blocked: null,
        depositUnits: "1000000",
        acquireUnits: null,
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      amountIn: "2",
    });

    expect(data.fundingAssessment).toMatchObject({
      decision: "prepare_deposit",
      requiredCollateralDisplay: "2 USDC",
      lighterCollateralDisplay: "1 USDC",
      walletSettlementDisplay: "2.07 USDC",
      depositAmountIn: "1",
      depositDisplay: "1 USDC",
    });
    expect(data.fundingRoute).toEqual({
      kind: "prepare_deposit_approval",
      toolId: "lighter.deposit.prepare",
      params: { environment: "core", amountIn: "1" },
    });
    expect(data.userGuidance).toContain("Immediately call lighter.deposit.prepare");
    expect(data.userGuidance).toContain('amountIn "1"');
    expect(data.userGuidance).toContain("Do not ask whether to prepare it");
    expect(data.userGuidance).toContain("approval card is the user's consent");
  });

  it("checks the live market minimum and stops before funding a sub-minimum trade", async () => {
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [{
        ...MARKET,
        market_id: 16,
        symbol: "SUI-USD",
        min_quote_amount: "10",
      }],
    });
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "2070000",
      walletCanAcquireSettlement: true,
      accountExists: true,
      accountIndex: 42,
      accountCollateralUnits: "1000000",
      tradingKeyRegistered: true,
      requiredCollateralUnits: "2000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [
          { kind: "approve_settlement_asset", reason: "approval" },
          { kind: "deposit", reason: "top up" },
        ],
        ready: false,
        blocked: null,
        depositUnits: "1000000",
        acquireUnits: null,
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      amountIn: "2",
      marketSymbol: "SUI",
    });

    expect(mocks.client.getMarkets).toHaveBeenCalledWith("core", { filter: "all" });
    expect(data.tradeMinimumAssessment).toEqual({
      decision: "below_lighter_trade_minimum",
      marketId: 16,
      marketSymbol: "SUI-USD",
      requestedTradeDisplay: "2 USDC",
      minimumTradeDisplay: "10 USDC",
      combinedAvailableDisplay: "3.07 USDC",
      combinedBalanceMeetsMinimum: false,
    });
    expect(data.fundingRoute).toEqual({
      kind: "show_below_lighter_trade_minimum",
      toolId: null,
      params: null,
    });
    expect(data.userGuidance).toContain("Do not prepare a deposit or approval card");
    expect(data.userGuidance).toContain("requested trade 2 USDC");
    expect(data.userGuidance).toContain("Lighter market minimum 10 USDC");
    expect(data.userGuidance).toContain("current Lighter collateral 1 USDC");
    expect(data.userGuidance).toContain("Vex wallet USDC 2.07 USDC");
    expect(data.userGuidance).toContain("combined available USDC 3.07 USDC");
    expect(data.userGuidance).toContain("combined are also below the venue minimum");
  });

  it("reports both live balances and stops when wallet USDC cannot cover the deposit", async () => {
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "250000",
      walletCanAcquireSettlement: true,
      accountExists: true,
      accountIndex: 42,
      accountCollateralUnits: "1000000",
      tradingKeyRegistered: true,
      requiredCollateralUnits: "2000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [
          { kind: "acquire_settlement_asset", reason: "acquire" },
          { kind: "approve_settlement_asset", reason: "approval" },
          { kind: "deposit", reason: "top up" },
        ],
        ready: false,
        blocked: null,
        depositUnits: "1000000",
        acquireUnits: "750000",
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      amountIn: "2",
    });

    expect(data.fundingAssessment).toMatchObject({
      decision: "insufficient_wallet_settlement_asset",
      requiredCollateralDisplay: "2 USDC",
      lighterCollateralDisplay: "1 USDC",
      walletSettlementDisplay: "0.25 USDC",
      depositDisplay: "1 USDC",
      walletDepositShortfallDisplay: "0.75 USDC",
    });
    expect(data.fundingRoute).toEqual({
      kind: "show_insufficient_balance",
      toolId: null,
      params: null,
    });
    expect(data.userGuidance).toContain("Do not prepare a deposit");
    expect(data.userGuidance).toContain("other wallet assets are not counted");
    expect(data.userGuidance).toContain("ETH is reported only for network fees");
  });

  it("stops before approval when the exact top-up is below Lighter's live minimum", async () => {
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "50000000",
      walletCanAcquireSettlement: true,
      accountExists: true,
      accountIndex: 42,
      accountCollateralUnits: "1500000",
      tradingKeyRegistered: true,
      requiredCollateralUnits: "2000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [],
        ready: false,
        blocked: "Required top-up 500000 base units is below Lighter's live minimum deposit 1000000 base units.",
        depositUnits: null,
        acquireUnits: null,
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      amountIn: "2",
    });

    expect(data.fundingAssessment).toMatchObject({
      decision: "below_lighter_deposit_minimum",
      requiredCollateralDisplay: "2 USDC",
      lighterCollateralDisplay: "1.5 USDC",
      walletSettlementDisplay: "50 USDC",
      combinedSettlementDisplay: "51.5 USDC",
      collateralShortfallDisplay: "0.5 USDC",
      minimumDepositDisplay: "1 USDC",
      depositAmountIn: null,
      depositDisplay: null,
    });
    expect(data.fundingRoute).toEqual({
      kind: "show_below_lighter_minimum",
      toolId: null,
      params: null,
    });
    expect(data.userGuidance).toContain("Do not prepare a deposit");
    expect(data.userGuidance).toContain("do not round the top-up upward");
    expect(data.userGuidance).toContain("combined USDC 51.5 USDC");
    expect(data.userGuidance).toContain("Lighter minimum deposit 1 USDC");
  });

  it("does not report ready from a public key without active local trading access", async () => {
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "0",
      walletCanAcquireSettlement: false,
      accountExists: true,
      accountIndex: 42,
      accountCollateralUnits: "1000000",
      tradingKeyRegistered: true,
      requiredCollateralUnits: "1000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [],
        ready: true,
        blocked: null,
        depositUnits: null,
        acquireUnits: null,
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
    });

    expect(data.managedTradingAccessActive).toBe(false);
    expect(data.tradingKeyRegistered).toBe(false);
    expect(data.plan).toMatchObject({
      ready: false,
      legs: [{ kind: "reconcile_trading_access" }],
    });
    expect(data.userGuidance).not.toContain("they are ready to trade");
  });

  it("reports ready only when the privileged managed readiness boundary passes", async () => {
    configureLighterManagedTradingReadinessResolver({
      read: vi.fn(async () => ({
        ready: true,
        reason: "ready",
        activeManagedCredential: true,
        durableActivation: true,
        exactPublicKeyMatch: true,
        clientCheckPassed: true,
        nonceSynchronized: true,
        nonceReservable: true,
      })),
    });
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "0",
      walletCanAcquireSettlement: false,
      accountExists: true,
      accountIndex: 42,
      accountCollateralUnits: "1000000",
      tradingKeyRegistered: true,
      requiredCollateralUnits: "1000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [],
        ready: true,
        blocked: null,
        depositUnits: null,
        acquireUnits: null,
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
    });

    expect(data.managedTradingAccessActive).toBe(true);
    expect(data.managedTradingReadiness).toMatchObject({
      ready: true,
      exactPublicKeyMatch: true,
      clientCheckPassed: true,
      nonceReservable: true,
    });
    expect(data.plan).toMatchObject({ ready: true, legs: [] });
    expect(data.userGuidance).toContain("they are ready to trade");
  });

  it("routes a funded Robinhood Chain account directly to local credential approval preparation", async () => {
    const readManagedReadiness = vi.fn(async () => ({
      ready: false,
      reason: "active_managed_credential_missing" as const,
      activeManagedCredential: false,
      durableActivation: false,
      exactPublicKeyMatch: false,
      clientCheckPassed: false,
      nonceSynchronized: false,
      nonceReservable: false,
    }));
    configureLighterManagedTradingReadinessResolver({ read: readManagedReadiness });
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "rhc",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "948401",
      walletCanAcquireSettlement: false,
      accountExists: true,
      accountIndex: 42,
      accountCollateralUnits: "1000000",
      tradingKeyRegistered: false,
      requiredCollateralUnits: "1000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [{ kind: "register_trading_key", reason: "secure setup" }],
        ready: false,
        blocked: null,
        depositUnits: null,
        acquireUnits: null,
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "rhc",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
    });

    expect(readManagedReadiness).toHaveBeenCalledWith("rhc", 42);
    expect(data.managedTradingAccessActive).toBe(false);
    expect(data.tradingAccessRoute).toEqual({
      kind: "prepare_key_registration_approval",
      toolId: "lighter.key.register.prepare",
      params: { environment: "rhc" },
    });
    expect(data.userGuidance).toContain("Immediately call lighter.key.register.prepare");
    expect(data.userGuidance).toContain('environment "rhc"');
    expect(data.userGuidance).toContain("generates and encrypts the credential locally");
    expect(data.userGuidance).toContain("Never call lighter.key.register directly");
  });

  it("routes an unresolved managed nonce to setup recovery instead of reporting ready", async () => {
    configureLighterManagedTradingReadinessResolver({
      read: vi.fn(async () => ({
        ready: false,
        reason: "nonce_not_reservable",
        activeManagedCredential: true,
        durableActivation: true,
        exactPublicKeyMatch: true,
        clientCheckPassed: true,
        nonceSynchronized: true,
        nonceReservable: false,
      })),
    });
    mocks.onboarding.resolveStatus.mockResolvedValue({
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
      walletSettlementUnits: "0",
      walletCanAcquireSettlement: false,
      accountExists: true,
      accountIndex: 42,
      accountCollateralUnits: "1000000",
      tradingKeyRegistered: true,
      requiredCollateralUnits: "1000000",
      minimumDepositUnits: "1000000",
      plan: {
        legs: [],
        ready: true,
        blocked: null,
        depositUnits: null,
        acquireUnits: null,
      },
    });

    const data = await callJson("lighter.account.onboarding.status", {
      environment: "core",
      walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
    });

    expect(data.managedTradingAccessActive).toBe(false);
    expect(data.managedTradingReadiness).toMatchObject({
      reason: "nonce_not_reservable",
      nonceReservable: false,
    });
    expect(data.plan).toMatchObject({
      ready: false,
      legs: [{ kind: "reconcile_order_state" }],
    });
    expect(data.userGuidance).not.toContain("they are ready to trade");
    expect(data.userGuidance).toContain("lighter.order.status");
    expect(data.userGuidance).toContain("Do not prepare a key registration");
  });

  it("routes key-registration status only through evidence-only reconciliation", async () => {
    const reconcile = vi.fn(async () => ({
      source: "vex_lighter_key_registration" as const,
      status: "active" as const,
      intentId: "lighter-keyreg-1",
      executionState: "active",
      accountIndex: 42,
      apiKeyIndex: 7,
      txHash: "a".repeat(80),
      postRegistrationNonce: "1",
      message: "Registration verified.",
    }));
    const uninstall = configureLighterKeyRegistrationExecutor({
      execute: vi.fn(),
      reconcile,
    });
    try {
      const data = await callJson("lighter.key.register.status", {
        intentId: "lighter-keyreg-1",
      });

      expect(data.status).toBe("active");
      expect(reconcile).toHaveBeenCalledWith({
        sessionId: "session-1",
        intentId: "lighter-keyreg-1",
        walletResolution: READ_CTX.walletResolution,
        walletPolicy: READ_CTX.walletPolicy,
        abortSignal: undefined,
      });
    } finally {
      uninstall();
    }
  });

  it("prepares an approval-gated Lighter order create without signing or submitting", async () => {
    mocks.previewsRepo.findLatestFresh.mockResolvedValueOnce(previewRow());
    mocks.executionIntentsRepo.findLiveByPreview.mockResolvedValueOnce(null);
    mocks.executionIntentsRepo.createApprovalPendingWith.mockResolvedValueOnce(executionIntentRow());

    const result = await LIGHTER_HANDLERS["lighter.order.create.prepare"]!({
      environment: "rhc",
    }, READ_CTX);

    expect(result.success, result.output).toBe(true);
    expect(mocks.previewsRepo.findLatestFresh).toHaveBeenCalledWith(
      "session-1",
      "rhc",
    );
    expect(mocks.previewsRepo.findFreshById).not.toHaveBeenCalled();
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
          reference: expect.objectContaining({
            vaultCredentialId: "lighter/rhc/account-42/api-key-7",
          }),
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
        toolName: "order.create",
        namespace: "lighter",
        criticalArgs: expect.objectContaining({
          toolId: "lighter.order.create",
          intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
          environment: "rhc",
          accountIndex: 42,
          apiKeyIndex: 7,
          matchHash: "a".repeat(64),
          marketSymbol: "ETH",
          baseAmountDisplay: "1",
          priceDisplay: "3000",
          notionalDisplay: "3000",
          orderExpiryIso: "2030-01-01T00:00:00.000Z",
          orderSummary: expect.stringContaining("Buy 1 ETH at limit price 3000"),
        }),
      },
    });
    const followUpPreview = (result.preparedActionFollowUp as {
      approvalPreview: { criticalArgs: Record<string, unknown> };
    }).approvalPreview;
    expect(String(followUpPreview.criticalArgs.orderSummary)).toContain(
      "Robinhood Chain Lighter",
    );
    expect(String(followUpPreview.criticalArgs.orderSummary)).toContain(
      "API acceptance is not final execution.",
    );
    const data = JSON.parse(result.output) as Record<string, unknown>;
    expect(data).toMatchObject({
      source: "vex_lighter_local_execution_intent",
      status: "approval_prepared",
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
      approvalUi: {
        surface: "approval_card",
        approveLabel: "Approve and execute trade",
        rejectLabel: "Reject",
      },
    });
    expect(String(data.userGuidance)).toContain("approval card");
    expect(String(data.userGuidance)).toContain("Approve and execute trade");
    expect(String(data.userGuidance)).toContain(
      "do not ask them to type another approval command",
    );
  });

  it("re-emits the approval follow-up for an existing pending Lighter create intent", async () => {
    mocks.previewsRepo.findLatestFresh.mockResolvedValueOnce(previewRow());
    mocks.executionIntentsRepo.findLiveByPreview.mockResolvedValueOnce(executionIntentRow());

    const result = await LIGHTER_HANDLERS["lighter.order.create.prepare"]!({
      environment: "rhc",
    }, READ_CTX);

    expect(result.success, result.output).toBe(true);
    expect(mocks.executionIntentsRepo.createApprovalPendingWith).not.toHaveBeenCalled();
    expect(result.preparedActionFollowUp).toEqual({
      toolName: "execute_tool",
      args: {
        toolId: "lighter.order.create",
        params: { intentId: "lighter-exec-00000000-0000-4000-8000-000000000001" },
      },
      expiresAt: "2030-01-01T00:00:00.000Z",
      approvalPreview: {
        toolName: "order.create",
        namespace: "lighter",
        criticalArgs: expect.objectContaining({
          toolId: "lighter.order.create",
          intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
          previewId: "lighter-preview-1",
          matchHash: "a".repeat(64),
        }),
      },
    });
    const data = JSON.parse(result.output) as Record<string, unknown>;
    expect(data).toMatchObject({
      source: "vex_lighter_local_execution_intent",
      status: "approval_prepared_existing",
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
      intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
      approvalUi: {
        surface: "approval_card",
        approveLabel: "Approve and execute trade",
        rejectLabel: "Reject",
      },
    });
    expect(String(data.userGuidance)).toContain("approval card");
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

  it("queues a Lighter create approval in full mode before signer access", async () => {
    const result = await executeProtocolTool({
      toolId: "lighter.order.create",
      params: { intentId: "lighter-exec-00000000-0000-4000-8000-000000000001" },
    }, FULL_CTX);

    expect(result).toMatchObject({
      success: false,
      pendingApproval: true,
      actionKind: "external_post",
    });
    expect(result.output).toContain("approved Vex approval card");
    expect(mocks.executionIntentsRepo.findByIntentId).not.toHaveBeenCalled();
    expect(mocks.approvalsRepo.getByIdForSession).not.toHaveBeenCalled();
  });

  it("records an approved Lighter create decision but refuses when privileged dependencies are unavailable", async () => {
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

    expect(mocks.approvalsRepo.getByIdForSession).toHaveBeenCalledWith(
      "approval-1",
      "session-1",
    );
    expect(mocks.approvalIntentsRepo.getByApprovalId).toHaveBeenCalledWith("approval-1");
    expect(mocks.executionIntentsRepo.markApprovalDecision).toHaveBeenCalledWith({
      intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
      decision: "approved",
      approvalId: "approval-1",
      reason: "user approved exact Lighter order create intent",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("live order create dependencies are unavailable");
    expect(result.output).toContain("No order was signed or submitted.");
    expect(result.output).not.toContain("lighter/rhc/account-42/api-key-7");
  });

  it("accepts the exact approval preview the trusted follow-up registry actually stores", async () => {
    // Regression guard: the binding check must agree with the shape
    // `validatePreparedActionFollowUp` canonicalizes and `enqueueApprovalIntent`
    // persists verbatim. Deriving the audit row from the real validator here
    // keeps the fixture from drifting away from that contract again.
    mocks.previewsRepo.findLatestFresh.mockResolvedValueOnce(previewRow());
    mocks.executionIntentsRepo.findLiveByPreview.mockResolvedValueOnce(null);
    mocks.executionIntentsRepo.createApprovalPendingWith.mockResolvedValueOnce(executionIntentRow());

    const prepared = await LIGHTER_HANDLERS["lighter.order.create.prepare"]!({
      environment: "rhc",
    }, READ_CTX);
    const validated = validatePreparedActionFollowUp(
      "execute_tool",
      prepared.preparedActionFollowUp!,
    );
    expect(validated.ok, JSON.stringify(validated)).toBe(true);
    if (!validated.ok) return;

    mocks.executionIntentsRepo.findByIntentId.mockResolvedValueOnce(executionIntentRow());
    mocks.approvalIntentsRepo.getByApprovalId.mockResolvedValueOnce(approvalIntentAuditRow({
      previewJson: validated.followUp.approvalPreview,
    }));

    const result = await LIGHTER_HANDLERS["lighter.order.create"]!({
      intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    }, APPROVED_CTX);

    expect(result.output).not.toContain("approval record does not match");
    expect(mocks.executionIntentsRepo.markApprovalDecision).toHaveBeenCalled();
  });

  it("reports no unresolved Lighter order intents through lighter.order.status", async () => {
    mocks.executionIntentsRepo.listUnresolved.mockResolvedValueOnce([]);

    const data = await callJson("lighter.order.status", { environment: "rhc" });

    expect(mocks.executionIntentsRepo.listUnresolved).toHaveBeenCalledWith("rhc", 10);
    expect(data).toMatchObject({
      source: "vex_lighter_local_order_repair",
      environment: "rhc",
      checkedIntents: 0,
      stillUnresolved: 0,
    });
  });

  it("unblocks a consumed nonce reservation through lighter.order.status without guessing the outcome", async () => {
    mocks.executionIntentsRepo.listUnresolved.mockResolvedValueOnce([
      executionIntentRow({
        approvalStatus: "approved",
        executionState: "submitted",
        nonceReservationId: "lighter-order:lighter-exec-00000000-0000-4000-8000-000000000001",
        nonceValue: "1200",
        clientOrderIndex: "123456",
        signerTxHash: "0xsigner",
        submittedTxHash: "0xsubmitted",
        submittedAt: "2026-08-12T00:00:05.000Z",
        signedAt: "2026-08-12T00:00:04.000Z",
        ambiguousReason: null,
      }),
    ]);
    mocks.client.getNextNonce.mockResolvedValueOnce({ code: 200, nonce: 1250 });
    mocks.nonceStateRepo.find.mockResolvedValueOnce({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      providerNonce: "1200",
      publicKey: "ab".repeat(20),
      providerTransactionTime: null,
      status: "reserved",
      reservedNonce: "1200",
      reservationId: "lighter-order:lighter-exec-00000000-0000-4000-8000-000000000001",
      source: "live_lighter_public_api",
      observedAt: "2026-08-12T00:00:04.000Z",
      updatedAt: "2026-08-12T00:00:04.000Z",
    });
    mocks.nonceStateRepo.recordExecutionObserved.mockResolvedValueOnce({ status: "observed" });

    const data = await callJson("lighter.order.status", { environment: "rhc" });

    expect(data.checkedIntents).toBe(1);
    const report = (data.reports as Record<string, unknown>[])[0]!;
    expect(report.resolution).toBe("nonce_reset_consumed");
    expect(report.nonceBlockedAfter).toBe(false);
    expect(report.stateAfter).toBe("submitted");
    expect(mocks.nonceStateRepo.recordExecutionObserved).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 1250 }),
    );
    expect(mocks.executionIntentsRepo.markRepairResolved).not.toHaveBeenCalled();
    expect(mocks.nonceStateRepo.releaseReservation).not.toHaveBeenCalled();
  });

  it("refuses approved Lighter create when the approval row targets another intent", async () => {
    mocks.executionIntentsRepo.findByIntentId.mockResolvedValueOnce(executionIntentRow());
    mocks.approvalsRepo.getByIdForSession.mockResolvedValueOnce(approvalQueueRow({
      toolCall: {
        command: "execute_tool",
        args: {
          toolId: "lighter.order.create",
          params: {
            intentId: "lighter-exec-00000000-0000-4000-8000-000000000002",
          },
        },
      },
    }));

    const result = await LIGHTER_HANDLERS["lighter.order.create"]!({
      intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    }, APPROVED_CTX);

    expect(result.success).toBe(false);
    expect(result.output).toContain("approval record does not match");
    expect(result.output).toContain("No order was signed or submitted.");
    expect(result.output).not.toContain("lighter/rhc/account-42/api-key-7");
    expect(mocks.executionIntentsRepo.markApprovalDecision).not.toHaveBeenCalled();
  });

  it("refuses approved Lighter create when the approval preview no longer matches the intent", async () => {
    mocks.executionIntentsRepo.findByIntentId.mockResolvedValueOnce(executionIntentRow());
    const approvedAudit = approvalIntentAuditRow();
    const approvedPreview = approvedAudit.previewJson as Record<string, unknown>;
    const approvedCriticalArgs = approvedPreview.criticalArgs as Record<string, unknown>;
    mocks.approvalIntentsRepo.getByApprovalId.mockResolvedValueOnce(approvalIntentAuditRow({
      previewJson: {
        ...approvedPreview,
        criticalArgs: {
          ...approvedCriticalArgs,
          matchHash: "b".repeat(64),
        },
      },
    }));

    const result = await LIGHTER_HANDLERS["lighter.order.create"]!({
      intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    }, APPROVED_CTX);

    expect(result.success).toBe(false);
    expect(result.output).toContain("approval record does not match");
    expect(result.output).toContain("No order was signed or submitted.");
    expect(result.output).not.toContain("lighter/rhc/account-42/api-key-7");
    expect(mocks.executionIntentsRepo.markApprovalDecision).not.toHaveBeenCalled();
  });

  it("refuses approved Lighter create when unsigned signer order assembly no longer matches policy", async () => {
    mocks.executionIntentsRepo.findByIntentId.mockResolvedValueOnce(executionIntentRow());
    mocks.executionIntentsRepo.markApprovalDecision.mockResolvedValueOnce(executionIntentRow({
      approvalId: "approval-1",
      approvalStatus: "approved",
      decisionReason: "user approved exact Lighter order create intent",
      decidedAt: "2026-08-12T00:01:00.000Z",
      clientOrderIndexPolicy: "caller_supplied",
    }));

    const result = await LIGHTER_HANDLERS["lighter.order.create"]!({
      intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    }, APPROVED_CTX);

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unsupported Lighter client-order-index policy");
    expect(result.output).not.toContain("lighter/rhc/account-42/api-key-7");
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
    expect(data.responseRules).toEqual(expect.arrayContaining([
      expect.stringContaining("Never infer or append asset symbols"),
    ]));

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
      walletAddress: "0x1111111111111111111111111111111111111111",
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
      walletAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(output).toContain("Provide either accountIndex or walletAddress, not both");
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
    }, undefined);
    expect(data.source).toBe("live_lighter_read_only_account_api");
    expect((data.provenance as Record<string, unknown>).authenticated).toBe(true);
    expect((data.provenance as Record<string, unknown>).credentialCapability).toBe("read_only_account_data");
    expect(data.accountIndexSource).toBe("credential");
    const order = (data.orders as Record<string, unknown>[])[0]!;
    expect(order.orderIndex).toBe(String(UNSAFE_INTEGER));
    expect(order.clientOrderIndex).toBe(String(UNSAFE_INTEGER_2));
  });

  it("reads open orders with a read-only token derived from the saved trading key", async () => {
    // Single trading key saved for account 736778, no standalone read-only
    // token. The derived-auth resolver mints a short-lived read-only token so
    // the read hits the live account API instead of falling back to inference.
    configureLighterTradingCredentialScopeResolver({
      findSavedScope: (environment, accountIndex) =>
        environment === "core" && accountIndex === 736778
          ? { environment, accountIndex, apiKeyIndex: 4 }
          : null,
      findDefaultScope: (environment) =>
        environment === "core" ? { environment, accountIndex: 736778, apiKeyIndex: 4 } : null,
      listScopes: (environment) =>
        environment === "core" ? [{ environment, accountIndex: 736778, apiKeyIndex: 4 }] : [],
    });
    const resolver = vi.fn(async (environment: string, accountIndex: number) =>
      environment === "core" && accountIndex === 736778
        ? { token: "derived-read-only-token", accountIndex }
        : null);
    configureLighterReadOnlyAccountAuthResolver(resolver);
    mocks.client.getAccountActiveOrders.mockResolvedValue({
      code: 200,
      orders: [accountOrder()],
    });

    const data = await callJson("lighter.openOrders", {
      environment: "core",
      marketId: 0,
      filter: "perp",
      limit: 1,
    });

    // The account is resolved from the saved key and the derived token is passed
    // through to the client, which targets that exact account.
    expect(resolver).toHaveBeenCalledWith("core", 736778);
    expect(mocks.client.getAccountActiveOrders).toHaveBeenCalledWith("core", {
      accountIndex: 736778,
      marketId: 0,
      marketType: "perp",
    }, { token: "derived-read-only-token", accountIndex: 736778 });
    expect(data.accountIndex).toBe(736778);
    expect(data.accountIndexSource).toBe("credential");
    expect((data.provenance as Record<string, unknown>).authenticated).toBe(true);
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
    }, undefined);
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
    }, undefined);
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
      baseAmountIn: "0.25",
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
    expect(data.status).toBe("preview_ready");
    expect(data.approvalReady).toBe(true);
    expect(data.nextStep).toBe("prepare_for_approval");
    expect(data.nextToolId).toBe("lighter.order.create.prepare");
    expect(data.userGuidance).toContain("preview only");
    expect(data.userGuidance).toContain("Prepare trade approval button");
    expect(data.userGuidance).not.toContain("lighter.order.create.prepare");
    expect(JSON.stringify(data.responseRules)).toContain("Prepare trade approval button");
    expect(data.safety).toContain("No signer");
    expect(data.previewId).toMatch(/^lop_[0-9a-f]{24}$/);
    expect(data.source).toBe("live_lighter_public_api");
    expect(data.previewSummary).toMatchObject({
      title: "Preview of your Lighter RHC limit-buy order",
      columns: ["Parameter", "Value", "Notes"],
      rows: expect.arrayContaining([
        { parameter: "Side", value: "BUY", notes: "limit-buy order" },
        { parameter: "Amount", value: "0.25 ETH", notes: "Passes minimum: 0.001 ETH" },
        { parameter: "Limit price", value: "$3,499.99 per ETH", notes: expect.any(String) },
        { parameter: "Quote notional", value: "$874.9975", notes: "0.25 ETH x $3,499.99" },
      ]),
      safety: expect.arrayContaining([
        "Read-only preview. No order was signed, submitted, broadcast, or placed.",
      ]),
    });
    expect(data.responseRules).toContain(
      "Render previewSummary as a Markdown table using its columns and rows. Do not use bullets for the main preview unless the user asks for a shorter summary.",
    );
    expect(data.responseRules).toContain(
      "Do not render raw preview internals such as integer, decimals, display wrappers, booleans, or JSON object fragments unless the user explicitly asks for technical details.",
    );
    expect((data.preview as Record<string, unknown>).symbol).toBe("ETH-USD");
    expect(((data.preview as Record<string, unknown>).baseAmount as Record<string, unknown>).integer).toBe("2500");
    expect(((data.preview as Record<string, unknown>).price as Record<string, unknown>).integer).toBe("349999");
  });

  it("creates an order preview from a relative expiry in minutes", async () => {
    const nowMs = 1_786_500_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
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
        baseAmountIn: "0.25",
        price: "3499.99",
        orderType: "limit",
        timeInForce: "good-till-time",
        reduceOnly: false,
        orderExpiryOffsetMinutes: 30,
      });

      expect(mocks.previewsRepo.create).toHaveBeenCalledTimes(1);
      const persisted = mocks.previewsRepo.create.mock.calls[0]![0] as {
        readonly preview: {
          readonly identity: {
            readonly expiryMs: string;
            readonly clientOrderIndexPolicy: string;
          };
        };
      };
      expect(persisted.preview.identity.expiryMs).toBe(String(nowMs + 30 * 60 * 1000));
      expect(persisted.preview.identity.clientOrderIndexPolicy).toBe("vex_assigned_uint48");
      expect(data.previewId).toMatch(/^lop_[0-9a-f]{24}$/);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("creates a conversational RHC ETH preview without ids or internal policy params", async () => {
    configureLighterTradingCredentialScopeResolver({
      findSavedScope: (environment, accountIndex) =>
        environment === "rhc" && accountIndex === 42
          ? { environment, accountIndex, apiKeyIndex: 7 }
          : null,
      findDefaultScope: (environment) =>
        environment === "rhc"
          ? { environment, accountIndex: 42, apiKeyIndex: 7 }
          : null,
    });
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        { ...MARKET, market_id: 12, symbol: "BTC-USD", status: "active" },
        { ...MARKET, market_id: 0, symbol: "ETH-USD", status: "active" },
      ],
    });
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
      marketSymbol: "ETH",
      side: "buy",
      baseAmountIn: "0.004",
      price: "3000",
      orderExpiryOffsetMinutes: 30,
    });

    expect(mocks.client.getMarkets).toHaveBeenCalledWith("rhc", { filter: "all" });
    expect(mocks.client.getApiKeys).not.toHaveBeenCalled();
    expect(mocks.client.getMarketDetails).toHaveBeenCalledWith("rhc", {
      marketId: 0,
      filter: "all",
    });
    expect(mocks.client.getAccount).toHaveBeenCalledWith("rhc", {
      by: "index",
      value: 42,
      activeOnly: true,
    });
    const persisted = mocks.previewsRepo.create.mock.calls[0]![0] as {
      readonly preview: {
        readonly identity: {
          readonly environment: string;
          readonly accountIndex: string;
          readonly apiKeyIndex: string;
          readonly marketIndex: string;
          readonly clientOrderIndexPolicy: string;
        };
      };
    };
    expect(persisted.preview.identity).toMatchObject({
      environment: "rhc",
      accountIndex: "42",
      apiKeyIndex: "7",
      marketIndex: "0",
      clientOrderIndexPolicy: "vex_assigned_uint48",
    });
    expect(data.previewId).toMatch(/^lop_[0-9a-f]{24}$/);
  });

  it("refuses to guess the account when multiple Lighter trading keys are configured", async () => {
    configureLighterTradingCredentialScopeResolver({
      findSavedScope: (environment, accountIndex) =>
        environment === "core" ? { environment, accountIndex, apiKeyIndex: 4 } : null,
      // Two saved Core scopes: the resolver must refuse rather than silently
      // pick the lowest account index.
      listScopes: (environment) =>
        environment === "core"
          ? [
              { environment, accountIndex: 736758, apiKeyIndex: 7 },
              { environment, accountIndex: 736778, apiKeyIndex: 4 },
            ]
          : [],
    });

    const output = await callFail("lighter.order.preview", {
      environment: "core",
      marketSymbol: "ETH",
      side: "buy",
      baseAmountIn: "0.004",
      price: "3000",
      orderExpiryOffsetMinutes: 30,
    });

    expect(output).toContain("Multiple Lighter core trading accounts");
    expect(output).toContain("736758");
    expect(output).toContain("736778");
    // It must fail before touching live market data, not pick an account.
    expect(mocks.client.getMarkets).not.toHaveBeenCalled();
  });

  it("proceeds when multiple keys are saved for a single account", async () => {
    configureLighterTradingCredentialScopeResolver({
      findSavedScope: (environment, accountIndex) =>
        environment === "core" && accountIndex === 736778
          ? { environment, accountIndex, apiKeyIndex: 4 }
          : null,
      // Two saved Core scopes on the SAME account: any key signs for that
      // account, so this is not ambiguous and must resolve, not refuse.
      listScopes: (environment) =>
        environment === "core"
          ? [
              { environment, accountIndex: 736778, apiKeyIndex: 4 },
              { environment, accountIndex: 736778, apiKeyIndex: 7 },
            ]
          : [],
    });
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [{ ...MARKET, market_id: 0, symbol: "ETH-USD", status: "active" }],
    });
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
      accounts: [{ ...ACCOUNT, index: 736778 }],
    });
    mocks.previewsRepo.create.mockResolvedValue(undefined);

    const data = await callJson("lighter.order.preview", {
      environment: "core",
      marketSymbol: "ETH",
      side: "buy",
      baseAmountIn: "0.004",
      price: "3000",
      orderExpiryOffsetMinutes: 30,
    });

    // It resolves the single account (not refuses) and reads it live, rather
    // than treating the two keys as ambiguous.
    expect(mocks.client.getAccount).toHaveBeenCalledWith("core", {
      by: "index",
      value: 736778,
      activeOnly: true,
    });
    expect(data.previewId).toMatch(/^lop_[0-9a-f]{24}$/);
  });

  it("resolves the account from a single saved scope via listScopes", async () => {
    configureLighterTradingCredentialScopeResolver({
      findSavedScope: (environment, accountIndex) =>
        environment === "core" && accountIndex === 42
          ? { environment, accountIndex, apiKeyIndex: 4 }
          : null,
      listScopes: (environment) =>
        environment === "core" ? [{ environment, accountIndex: 42, apiKeyIndex: 4 }] : [],
    });
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [{ ...MARKET, market_id: 0, symbol: "ETH-USD", status: "active" }],
    });
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
    mocks.client.getAccount.mockResolvedValue({ code: 200, accounts: [ACCOUNT] });
    mocks.previewsRepo.create.mockResolvedValue(undefined);

    const data = await callJson("lighter.order.preview", {
      environment: "core",
      marketSymbol: "ETH",
      side: "buy",
      baseAmountIn: "0.004",
      price: "3000",
      orderExpiryOffsetMinutes: 30,
    });

    expect(mocks.client.getAccount).toHaveBeenCalledWith("core", {
      by: "index",
      value: 42,
      activeOnly: true,
    });
    expect(data.previewId).toMatch(/^lop_[0-9a-f]{24}$/);
  });

  it("uses the saved Lighter trading credential scope instead of asking the user for an API-key index", async () => {
    configureLighterTradingCredentialScopeResolver({
      findSavedScope: (environment, accountIndex) =>
        environment === "rhc" && accountIndex === 42
          ? { environment, accountIndex, apiKeyIndex: 9 }
          : null,
      findDefaultScope: (environment) =>
        environment === "rhc"
          ? { environment, accountIndex: 42, apiKeyIndex: 9 }
          : null,
    });
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        { ...MARKET, market_id: 0, symbol: "ETH-USD", status: "active" },
      ],
    });
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
      marketSymbol: "ETH",
      side: "buy",
      baseAmountIn: "0.25",
      price: "3000",
      orderExpiryOffsetMinutes: 30,
    });

    expect(mocks.client.getApiKeys).not.toHaveBeenCalled();
    const persisted = mocks.previewsRepo.create.mock.calls[0]![0] as {
      readonly preview: {
        readonly identity: {
          readonly apiKeyIndex: string;
        };
      };
    };
    expect(persisted.preview.identity.apiKeyIndex).toBe("9");
    expect(data.approvalReady).toBe(true);
    expect(data.nextStep).toBe("prepare_for_approval");
    expect((data.provenance as Record<string, unknown>).apiKeyLookupStatus).toBe("saved_vault_scope");
    expect(JSON.stringify(data)).not.toContain("let me know which index");
  });

  it("creates a read-only conversational preview when no trading API-key index is published", async () => {
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        { ...MARKET, market_id: 0, symbol: "ETH-USD", status: "active" },
      ],
    });
    mocks.client.getApiKeys.mockResolvedValue({
      code: 200,
      api_keys: [
        { account_index: 42, api_key_index: 1, nonce: 10, public_key: "reserved", transaction_time: 1 },
        { account_index: 42, api_key_index: 2, nonce: 11, public_key: "reserved", transaction_time: 2 },
        { account_index: 42, api_key_index: 3, nonce: 12, public_key: "reserved", transaction_time: 3 },
      ],
    });
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
      marketSymbol: "ETH",
      accountIndex: 42,
      side: "buy",
      baseAmountIn: "0.25",
      price: "3000",
      orderExpiryOffsetMinutes: 30,
    });

    const persisted = mocks.previewsRepo.create.mock.calls[0]![0] as {
      readonly preview: {
        readonly identity: {
          readonly apiKeyIndex: string;
        };
        readonly preview: {
          readonly apiKeyIndex: number | null;
        };
      };
    };
    expect(persisted.preview.identity.apiKeyIndex).toBe("");
    expect(persisted.preview.preview.apiKeyIndex).toBeNull();
    expect(data.approvalReady).toBe(false);
    expect(data.nextStep).toBe("connect_trading_api_key_before_approval");
    expect(data.nextToolId).toBeNull();
    expect(data.userGuidance).toContain("read-only preview only");
    expect(data.userGuidance).toContain("not a simulation");
    expect(data.userGuidance).toContain("finish managed Lighter setup");
    expect(data.userGuidance).not.toContain("Settings/API keys");
    expect(data.userGuidance).not.toContain("<br>");
    expect(data.userGuidance).not.toMatch(/simulation only/i);
    expect(data.responseRules).toContain(
      "Describe this as a live-data-backed read-only preview, not as a simulation.",
    );
    expect(data.responseRules).toContain(
      "Do not emit raw HTML such as <br>; use Markdown bullets or sentences.",
    );
    expect(data.responseRules).toContain(
      "Render previewSummary as a Markdown table using its columns and rows. Do not use bullets for the main preview unless the user asks for a shorter summary.",
    );
    expect(data.responseRules).toContain(
      "Do not render raw preview internals such as integer, decimals, display wrappers, booleans, or JSON object fragments unless the user explicitly asks for technical details.",
    );
    expect(data.responseRules).toContain(
      "If the user wants to continue, start or continue managed Lighter onboarding for the selected wallet. Vex generates and stores the credential locally; never ask the user to paste a key, visit Settings, or choose an account/API-key index.",
    );
    expect(data.userGuidance).not.toContain("4 to 254");
    expect((data.provenance as Record<string, unknown>).apiKeyLookupStatus).toBe("not_found");
  });

  it("uses the saved Lighter trading credential scope as the default preview account", async () => {
    configureLighterTradingCredentialScopeResolver({
      findSavedScope: (environment, accountIndex) =>
        environment === "rhc" && accountIndex === 42
          ? { environment, accountIndex, apiKeyIndex: 9 }
          : null,
      findDefaultScope: (environment) =>
        environment === "rhc"
          ? { environment, accountIndex: 42, apiKeyIndex: 9 }
          : null,
    });
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        { ...MARKET, market_id: 0, symbol: "ETH-USD", status: "active" },
      ],
    });
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

    await callJson("lighter.order.preview", {
      marketSymbol: "ETH",
      side: "buy",
      baseAmountIn: "0.25",
      price: "3000",
      orderExpiryOffsetMinutes: 30,
    });

    expect(mocks.client.getAccount).toHaveBeenCalledWith("rhc", {
      by: "index",
      value: 42,
      activeOnly: true,
    });
  });

  it("asks for a plain buy or sell choice when conversational preview omits direction", async () => {
    const output = await callFail("lighter.order.preview", {
      marketSymbol: "ETH",
      baseAmountIn: "0.001",
      price: "3000",
      orderExpiryOffsetMinutes: 30,
    });

    expect(output).toContain("Please choose buy or sell");
    expect(mocks.client.getMarkets).not.toHaveBeenCalled();
  });

  it("refuses order preview without a host session id", async () => {
    const handler = LIGHTER_HANDLERS["lighter.order.preview"];
    expect(handler).toBeDefined();
    const result = await handler!({
      environment: "rhc",
      accountIndex: 42,
      marketId: 0,
      side: "buy",
      baseAmountIn: "0.25",
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
    expect(projectedAsks[0]?.orderExpiryIso).toBe("2026-08-09T00:00:00.000Z");
    expect(projectedAsks[0]?.orderExpiryUnit).toBe("epoch_milliseconds");
    expect(data.responseRules).toEqual(expect.arrayContaining([
      expect.stringContaining("Prefer orderExpiryIso"),
    ]));
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

    expect(Array.isArray(data.orders)).toBe(true);
    if (!Array.isArray(data.orders)) throw new Error("projected orders should be an array");
    const first = data.orders[0];
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
    const invalidEnv = await callFail("lighter.orderbook", { environment: "mainnet", marketId: 0 });
    expect(invalidEnv).toContain("environment must be core, rhc");

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
