/**
 * LIGHTER_PREVIEW_SINGLE_SNAPSHOT: an order preview and its approval prepared
 * from one snapshot of reads.
 *
 * Every case runs the real `lighter.order.preview` handler (which prepares the
 * approval inline) OFF, with the switch absent (the shipped constant), and ON,
 * against the same provider answers, and requires the same tool result, the
 * same durable preview and intent writes (with their evidence JSON), the same
 * capital-ledger admission and the same warnings. Each case's OFF outcome is
 * also matched against what it names, so every refusal branch is provably
 * exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { LighterClient } from "@tools/lighter/client.js";
import type {
  LighterAccount,
  LighterAccountLimitsResponse,
  LighterAccountPosition,
  LighterAccountResponse,
  LighterMarketDetail,
  LighterOrderBookOrdersResponse,
  LighterSimpleOrder,
  LighterSystemConfigResponse,
} from "@tools/lighter/types.js";
import type { LighterOrderPreview } from "@tools/lighter/order-preview.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import type { CreateLighterOrderExecutionIntentInput } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import { requireValue } from "../../helpers/require-value.js";

const TEST_EVM_WALLET = vi.hoisted(() => ({
  id: "evm_legacy",
  address: "0x1111111111111111111111111111111111111111",
  label: "Test wallet",
  createdAt: "2026-01-01T00:00:00.000Z",
  legacy: true,
}));

vi.mock("@tools/wallet/inventory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/wallet/inventory.js")>()),
  getPrimaryEvmEntry: () => TEST_EVM_WALLET,
  getWalletById: (family: string, id: string) =>
    family === "evm" && id === TEST_EVM_WALLET.id ? TEST_EVM_WALLET : null,
}));

const state = vi.hoisted(() => ({
  client: null as PreviewClient | null,
  feePolicy: vi.fn(),
  share: null as number | null,
  refuseAdmission: false,
  admitted: [] as unknown[],
  retired: [] as unknown[],
  previewCreate: vi.fn(),
  previewFindFreshById: vi.fn(),
  intentFindLiveByPreview: vi.fn(),
  intentCreate: vi.fn(),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tools/lighter/client.js", () => ({
  getLighterClient: () => {
    if (state.client === null) throw new Error("no test client armed");
    return state.client;
  },
}));
vi.mock("@tools/lighter/fee-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/lighter/fee-policy.js")>()),
  getLighterFeePolicy: state.feePolicy,
}));
vi.mock("@vex-agent/db/repos/lighter-order-previews.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-order-previews.js")>()),
  create: state.previewCreate,
  findFreshById: state.previewFindFreshById,
}));
vi.mock("@vex-agent/db/repos/lighter-order-execution-intents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-order-execution-intents.js")>()),
  findLiveByPreview: state.intentFindLiveByPreview,
  createApprovalPendingWith: state.intentCreate,
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js")>()),
  withSessionControlLock: async (_sessionId: string, run: (client: object) => Promise<unknown>) => run({}),
}));
vi.mock("@vex-agent/db/repos/lighter-trading-limits.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-trading-limits.js")>()),
  readLighterTradingLimits: async () => (state.share === null ? null : { agentCapitalSharePercent: state.share }),
}));
vi.mock("@vex-agent/db/repos/lighter-capital-commitments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-capital-commitments.js")>()),
  admitLighterCapitalCommitment: async (input: unknown) => {
    state.admitted.push(input);
    return state.refuseAdmission
      ? { admitted: false, remainingUnits: "5000000", liveCommittedUnits: "1000000" }
      : { admitted: true, commitmentId: "commitment-test", liveCommittedUnits: "0" };
  },
  listLiveLighterCapitalCommitments: async () => [],
  retireLighterCapitalCommitment: async (input: unknown) => {
    state.retired.push(input);
  },
}));
vi.mock("@vex-agent/tools/protocols/lighter/nonce-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/tools/protocols/lighter/nonce-recovery.js")>()),
  checkLighterNonceRecovery: async () => undefined,
}));
vi.mock("@utils/logger.js", () => ({ default: state.logger }));

import { resolveLighterFeePolicy, getLighterIntegratorFees } from "@tools/lighter/fee-policy.js";
import { readLighterOrderFeeTerms } from "@tools/lighter/order-fee-terms.js";
import { LIGHTER_READ_HANDLERS } from "@vex-agent/tools/protocols/lighter/handlers/read.js";
import { LIGHTER_WRITE_HANDLERS } from "@vex-agent/tools/protocols/lighter/handlers/write.js";
import { configureLighterReadOnlyAccountAuthResolver } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { configureLighterTradingCredentialScopeResolver } from "@vex-agent/tools/protocols/lighter/trading-credential-scope.js";
import {
  configureLighterOrderPreviewDeps,
  LIGHTER_PREVIEW_SINGLE_SNAPSHOT,
} from "@vex-agent/tools/protocols/lighter/preview-snapshot.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const ACCOUNT_INDEX = 42;
const FEE_COLLECTOR_INDEX = 99;
const FEE_COLLECTOR_WALLET = `0x${"2".repeat(40)}`;
const FEE_POLICY = requireValue(resolveLighterFeePolicy("rhc", {
  enabled: true,
  accountIndex: FEE_COLLECTOR_INDEX,
  l1Address: FEE_COLLECTOR_WALLET,
}));
const READ_ONLY_AUTH = { accountIndex: ACCOUNT_INDEX, token: "read-only-test-token" } as const;
const DEPTH_LIMIT = 50;

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: "session-1",
};
const DESK_CTX: ProtocolExecutionContext = { ...READ_CTX, deskPreparation: true };

/** A perpetual market the margin-fit and capital-share checks can price. */
const PERP_MARKET: LighterMarketDetail = {
  symbol: "ETH",
  market_id: 0,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 3,
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
  last_trade_price: 3500,
  default_initial_margin_fraction: 500,
  mark_price: "3500.00",
};
const { default_initial_margin_fraction: _unpricedFraction, ...UNPRICED_MARKET } = PERP_MARKET;
const { default_initial_margin_fraction: _spotFraction, mark_price: _spotMark, ...SPOT_BASE } = PERP_MARKET;
const SPOT_MARKET: LighterMarketDetail = {
  ...SPOT_BASE,
  symbol: "ETH/USDC",
  market_id: 2048,
  market_type: "spot",
};

const POSITION: LighterAccountPosition = {
  market_id: 0,
  symbol: "ETH",
  initial_margin_fraction: "5.00",
  open_order_count: 0,
  pending_order_count: 0,
  position_tied_order_count: 0,
  sign: 1,
  position: "1.25",
  avg_entry_price: "3000",
  position_value: "3750",
  unrealized_pnl: "0",
  realized_pnl: "0",
  liquidation_price: "2000",
  margin_mode: 0,
  allocated_margin: "0",
};

const VEX_FEE_APPROVAL = [{
  account_index: FEE_COLLECTOR_INDEX,
  name: "VEX",
  max_perps_maker_fee: 1_000_000,
  max_perps_taker_fee: 1_000_000,
  max_spot_maker_fee: 1_000_000,
  max_spot_taker_fee: 1_000_000,
  approval_expiry: NOW + 3_600_000,
}];

function liveAccount(feesEnabled: boolean, overrides: Partial<LighterAccount> = {}): LighterAccount {
  return {
    index: ACCOUNT_INDEX,
    l1_address: TEST_EVM_WALLET.address,
    status: 1,
    collateral: "1000",
    available_balance: "750",
    cross_initial_margin_requirement: "187.5",
    total_order_count: 0,
    positions: [POSITION],
    assets: [{
      asset_id: 3,
      symbol: "USDC",
      balance: "5000",
      locked_balance: "0",
      margin_balance: "5000",
      margin_mode: "enabled",
      multiplier: "1",
    }],
    ...(feesEnabled ? { approved_integrators: VEX_FEE_APPROVAL } : {}),
    ...overrides,
  };
}

const COLLECTOR_ACCOUNT: LighterAccountResponse = {
  code: 200,
  total: 1,
  accounts: [{ index: FEE_COLLECTOR_INDEX, status: 1, l1_address: FEE_COLLECTOR_WALLET }],
};
const SYSTEM_CONFIG: LighterSystemConfigResponse = {
  code: 200,
  liquidity_pool_index: 1,
  staking_pool_index: 2,
  funding_fee_rebate_account_index: 3,
  market_maker_incentive_account_index: 4,
  liquidity_pool_cooldown_period: 0,
  staking_pool_lockup_period: 0,
  max_integrator_perps_maker_fee: 1_000_000,
  max_integrator_perps_taker_fee: 1_000_000,
  max_integrator_spot_maker_fee: 1_000_000,
  max_integrator_spot_taker_fee: 1_000_000,
};
const ACCOUNT_LIMITS: LighterAccountLimitsResponse = {
  code: 200,
  user_tier: "premium",
  user_tier_name: "Premium",
  current_maker_fee_tick: 120,
  current_taker_fee_tick: 350,
};

function bookOrder(index: number, price: string, remaining: string): LighterSimpleOrder {
  return {
    order_index: index,
    order_id: String(index),
    owner_account_index: 100 + index,
    initial_base_amount: remaining,
    remaining_base_amount: remaining,
    price,
    order_expiry: 0,
    transaction_time: 0,
  };
}

const ORDER_BOOK: LighterOrderBookOrdersResponse = {
  code: 200,
  total_asks: 2,
  asks: [bookOrder(1, "3500.50", "2"), bookOrder(2, "3505.00", "5")],
  total_bids: 1,
  bids: [bookOrder(3, "3499.50", "2")],
};

interface PreviewClient {
  readonly getAccountsByL1Address: Mock<LighterClient["getAccountsByL1Address"]>;
  readonly getMarketDetails: Mock<LighterClient["getMarketDetails"]>;
  readonly getOrderBookOrders: Mock<LighterClient["getOrderBookOrders"]>;
  readonly getAccount: Mock<LighterClient["getAccount"]>;
  readonly getSystemConfig: Mock<LighterClient["getSystemConfig"]>;
  readonly getAccountLimits: Mock<LighterClient["getAccountLimits"]>;
  readonly getAccountActiveOrders: Mock<LighterClient["getAccountActiveOrders"]>;
  readonly getApiKeys: Mock<LighterClient["getApiKeys"]>;
}

interface PreviewScenario {
  readonly market?: LighterMarketDetail;
  /** Overrides on the live account row every account read returns. */
  readonly account?: Partial<LighterAccount>;
  /** Collection enabled for RHC; "broken" makes the collector configuration itself throw. */
  readonly feesEnabled?: boolean | "broken";
  readonly share?: number;
  readonly auth?: "token" | "none" | "throws";
  readonly refuseAdmission?: boolean;
  /** Overrides on the preview tool params. */
  readonly params?: Record<string, unknown>;
  /** An approval is already pending for this exact preview. */
  readonly existingIntent?: boolean;
  /** The last word on the provider reads. */
  readonly client?: (client: PreviewClient) => Partial<PreviewClient>;
}

function previewParams(scenario: PreviewScenario): Record<string, unknown> {
  return {
    environment: "rhc",
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: 7,
    marketId: (scenario.market ?? PERP_MARKET).market_id,
    side: "buy",
    baseAmountIn: "0.25",
    price: "3510",
    orderType: "market",
    timeInForce: "immediate-or-cancel",
    reduceOnly: false,
    orderExpiry: NOW + 10 * 60 * 1000,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    ...scenario.params,
  };
}

function buildClient(scenario: PreviewScenario): PreviewClient {
  const market = scenario.market ?? PERP_MARKET;
  const spot = market.market_type === "spot";
  const row = liveAccount(scenario.feesEnabled === true, scenario.account);
  const base: PreviewClient = {
    getAccountsByL1Address: vi.fn<LighterClient["getAccountsByL1Address"]>(async (_environment, input) => ({
      code: 200,
      l1_address: input.l1Address,
      sub_accounts: [{ index: ACCOUNT_INDEX, account_type: 0, l1_address: input.l1Address }],
    })),
    getMarketDetails: vi.fn<LighterClient["getMarketDetails"]>(async () => ({
      code: 200,
      order_book_details: spot ? [] : [market],
      spot_order_book_details: spot ? [market] : [],
    })),
    getOrderBookOrders: vi.fn<LighterClient["getOrderBookOrders"]>(async () => ORDER_BOOK),
    getAccount: vi.fn<LighterClient["getAccount"]>(async (_environment, params) => (
      Number(params.value) === FEE_COLLECTOR_INDEX
        ? COLLECTOR_ACCOUNT
        : { code: 200, total: 1, accounts: [row] }
    )),
    getSystemConfig: vi.fn<LighterClient["getSystemConfig"]>(async () => SYSTEM_CONFIG),
    getAccountLimits: vi.fn<LighterClient["getAccountLimits"]>(async () => ACCOUNT_LIMITS),
    getAccountActiveOrders: vi.fn<LighterClient["getAccountActiveOrders"]>(async () => ({ code: 200, orders: [] })),
    getApiKeys: vi.fn<LighterClient["getApiKeys"]>(async () => ({ code: 200, api_keys: [] })),
  };
  return { ...base, ...scenario.client?.(base) };
}

/** What the real repository returns for a preview it stored: JSONB round trip included. */
function storedRow(input: { readonly preview: LighterOrderPreview; readonly liveSourceJson: Record<string, unknown> }): LighterOrderPreviewRow {
  const { preview } = input;
  const previewJson: Record<string, unknown> = JSON.parse(JSON.stringify(preview.preview));
  return {
    integratorFees: readLighterOrderFeeTerms(previewJson.integratorFees),
    previewId: preview.previewId,
    sessionId: preview.identity.sessionId,
    matchHash: preview.matchHash,
    environment: preview.identity.environment,
    accountIndex: Number(preview.identity.accountIndex),
    apiKeyIndex: preview.identity.apiKeyIndex.length === 0 ? null : Number(preview.identity.apiKeyIndex),
    marketIndex: Number(preview.identity.marketIndex),
    side: preview.identity.side,
    baseAmountInteger: preview.identity.baseAmountInteger,
    priceInteger: preview.identity.priceInteger,
    orderType: preview.identity.orderType,
    timeInForce: preview.identity.timeInForce,
    reduceOnly: preview.identity.reduceOnly === "1",
    triggerPriceInteger: preview.identity.triggerPriceInteger.length === 0 ? null : preview.identity.triggerPriceInteger,
    orderExpiryMs: Number(preview.identity.expiryMs),
    clientOrderIndexPolicy: preview.identity.clientOrderIndexPolicy,
    providerVersion: preview.identity.providerVersion,
    previewJson,
    liveSourceJson: JSON.parse(JSON.stringify(input.liveSourceJson)),
    createdAt: new Date(NOW).toISOString(),
    expiresAt: preview.expiresAt,
  };
}

function intentRow(input: CreateLighterOrderExecutionIntentInput, overrides: Record<string, unknown> = {}) {
  const { preview } = input;
  return {
    integratorFees: preview.integratorFees ?? null,
    intentId: input.intentId,
    sessionId: preview.sessionId,
    previewId: preview.previewId,
    protocolExecutionId: null,
    approvalId: null,
    matchHash: preview.matchHash,
    environment: preview.environment,
    accountIndex: preview.accountIndex,
    apiKeyIndex: preview.apiKeyIndex,
    marketIndex: preview.marketIndex,
    side: preview.side,
    baseAmountInteger: preview.baseAmountInteger,
    priceInteger: preview.priceInteger,
    orderType: preview.orderType,
    timeInForce: preview.timeInForce,
    reduceOnly: preview.reduceOnly,
    triggerPriceInteger: preview.triggerPriceInteger,
    orderExpiryMs: preview.orderExpiryMs,
    clientOrderIndexPolicy: preview.clientOrderIndexPolicy,
    providerVersion: preview.providerVersion,
    credentialRefJson: input.credentialReadiness.reference,
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    decisionReason: null,
    decidedAt: null,
    nonceReservationId: null,
    nonceValue: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    expiresAt: input.expiresAt,
    ...overrides,
  };
}

/** The process-wide state a scenario needs; armed afresh before every run. */
function armScenario(scenario: PreviewScenario): { readonly client: PreviewClient; readonly resolver: Mock } {
  const client = buildClient(scenario);
  state.client = client;
  state.feePolicy.mockReset();
  if (scenario.feesEnabled === "broken") {
    state.feePolicy.mockImplementation(() => {
      throw new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, "VEX's Lighter fee collector is not configured correctly.");
    });
  } else {
    state.feePolicy.mockReturnValue(scenario.feesEnabled === true ? FEE_POLICY : null);
  }
  state.share = scenario.share ?? null;
  state.refuseAdmission = scenario.refuseAdmission === true;
  state.admitted.length = 0;
  state.retired.length = 0;
  state.logger.warn.mockClear();
  state.logger.info.mockClear();
  const stored = new Map<string, LighterOrderPreviewRow>();
  state.previewCreate.mockReset().mockImplementation(async (input: {
    readonly preview: LighterOrderPreview;
    readonly liveSourceJson: Record<string, unknown>;
  }) => {
    stored.set(input.preview.previewId, storedRow(input));
  });
  state.previewFindFreshById.mockReset().mockImplementation(
    async (_sessionId: string, _environment: string, previewId: string) => stored.get(previewId) ?? null,
  );
  state.intentFindLiveByPreview.mockReset().mockImplementation(async (_sessionId: string, previewId: string) => {
    const row = stored.get(previewId);
    if (scenario.existingIntent !== true || row === undefined) return null;
    return intentRow({
      intentId: "lighter-exec-existing-intent-0001",
      preview: row,
      credentialReadiness: {
        ready: true,
        capability: "lighter_transaction_signing",
        reference: {
          kind: "encrypted_vault_reference",
          environment: "rhc",
          accountIndex: ACCOUNT_INDEX,
          apiKeyIndex: 7,
          vaultCredentialId: "lighter/rhc/account-42/api-key-7",
        },
        nonceScope: { environment: "rhc", accountIndex: ACCOUNT_INDEX, apiKeyIndex: 7 },
      },
      expiresAt: row.expiresAt,
    });
  });
  state.intentCreate.mockReset().mockImplementation(
    async (_client: object, input: CreateLighterOrderExecutionIntentInput) => intentRow(input),
  );
  const resolver = vi.fn(async () => {
    if (scenario.auth === "throws") throw new Error("vault read failed");
    return scenario.auth === "none" ? null : READ_ONLY_AUTH;
  });
  configureLighterReadOnlyAccountAuthResolver(resolver);
  return { client, resolver };
}

interface PreviewRun {
  readonly observation: Record<string, unknown>;
  readonly reads: Record<string, number>;
  readonly client: PreviewClient;
}

/** A fresh intent id per prepare is the one thing allowed to differ. */
function normalized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/lighter-exec-[0-9a-f-]{36}/g, "lighter-exec-<intent>"));
}

function readMap(client: PreviewClient, resolver: Mock): Record<string, number> {
  return {
    readOnlyAuth: resolver.mock.calls.length,
    getAccount: client.getAccount.mock.calls.length,
    getMarketDetails: client.getMarketDetails.mock.calls.length,
    getSystemConfig: client.getSystemConfig.mock.calls.length,
    getAccountLimits: client.getAccountLimits.mock.calls.length,
    getOrderBookOrders: client.getOrderBookOrders.mock.calls.length,
    marginDepthReads: depthReads(client),
    getAccountActiveOrders: client.getAccountActiveOrders.mock.calls.length,
  };
}

function depthReads(client: PreviewClient): number {
  return client.getOrderBookOrders.mock.calls.filter((call) => call[1].limit === DEPTH_LIMIT).length;
}

async function observePreview(
  scenario: PreviewScenario,
  previewSingleSnapshot: boolean | "constant",
  context: ProtocolExecutionContext = READ_CTX,
): Promise<PreviewRun> {
  const { client, resolver } = armScenario(scenario);
  configureLighterOrderPreviewDeps(previewSingleSnapshot === "constant" ? null : { previewSingleSnapshot });
  try {
    const handler = requireValue(LIGHTER_READ_HANDLERS["lighter.order.preview"]);
    const result = await handler(previewParams(scenario), context);
    return {
      observation: {
        result: normalized(result),
        previewWrites: normalized(state.previewCreate.mock.calls.map((call) => call[0])),
        intentWrites: normalized(state.intentCreate.mock.calls.map((call) => call[1])),
        ledger: normalized({ admitted: state.admitted, retired: state.retired }),
        warnings: normalized(state.logger.warn.mock.calls),
      },
      reads: readMap(client, resolver),
      client,
    };
  } finally {
    configureLighterOrderPreviewDeps(null);
  }
}

function failing(message: string) {
  return async (): Promise<never> => {
    throw new Error(message);
  };
}

function timingOut(message: string) {
  return async (): Promise<never> => {
    throw new VexError(ErrorCodes.LIGHTER_TIMEOUT, message);
  };
}

const NEAR_MARGIN: Partial<LighterAccount> = { available_balance: "60" };

const PREVIEW_CASES: readonly {
  readonly label: string;
  readonly scenario: PreviewScenario;
  /** The OFF outcome, so each case provably exercises what it names. */
  readonly expected: RegExp;
}[] = [
  // The fee check.
  {
    label: "fees pass and the approval is prepared",
    scenario: { feesEnabled: true },
    expected: /"status\\":\\"preview_ready\\".*"approvalReady\\":true/,
  },
  {
    label: "the read-only auth is unavailable",
    scenario: { feesEnabled: true, auth: "none" },
    expected: /fee setup is required before this trade\. Unlock the local vault/,
  },
  {
    label: "the read-only auth resolver throws",
    scenario: { feesEnabled: true, auth: "throws" },
    expected: /fee setup is required before this trade\. vault read failed/,
  },
  {
    label: "the system config read fails",
    scenario: { feesEnabled: true, client: () => ({ getSystemConfig: vi.fn(failing("config down")) }) },
    expected: /fee setup is required before this trade\. config down/,
  },
  {
    label: "the system config read cannot reach Lighter",
    scenario: { feesEnabled: true, client: () => ({ getSystemConfig: vi.fn(timingOut("config timed out")) }) },
    expected: /Lighter order preview unavailable \(.*config timed out/,
  },
  {
    label: "the collector account read fails",
    scenario: {
      feesEnabled: true,
      client: (client) => ({
        getAccount: vi.fn<LighterClient["getAccount"]>(async (environment, params, options) => {
          if (Number(params.value) === FEE_COLLECTOR_INDEX) throw new Error("collector down");
          return client.getAccount(environment, params, options);
        }),
      }),
    },
    expected: /fee setup is required before this trade\. collector down/,
  },
  {
    label: "the collector belongs to another wallet",
    scenario: {
      feesEnabled: true,
      client: (client) => ({
        getAccount: vi.fn<LighterClient["getAccount"]>(async (environment, params, options) => (
          Number(params.value) === FEE_COLLECTOR_INDEX
            ? { ...COLLECTOR_ACCOUNT, accounts: [{ index: FEE_COLLECTOR_INDEX, status: 1, l1_address: `0x${"3".repeat(40)}` }] }
            : client.getAccount(environment, params, options)
        )),
      }),
    },
    expected: /does not belong to VEX's configured wallet/,
  },
  {
    label: "the provider fee cap fell below Vex's fee",
    scenario: {
      feesEnabled: true,
      client: () => ({ getSystemConfig: vi.fn(async () => ({ ...SYSTEM_CONFIG, max_integrator_perps_taker_fee: 0 })) }),
    },
    expected: /exceeds the current provider limit/,
  },
  {
    label: "the account limits read fails",
    scenario: { feesEnabled: true, client: () => ({ getAccountLimits: vi.fn(failing("limits down")) }) },
    expected: /fee setup is required before this trade\. limits down/,
  },
  {
    label: "the account is not on a Plus or Premium tier",
    scenario: {
      feesEnabled: true,
      client: () => ({ getAccountLimits: vi.fn(async () => ({ ...ACCOUNT_LIMITS, user_tier: "standard" })) }),
    },
    expected: /require a Plus or Premium account/,
  },
  {
    label: "the trading account no longer approves Vex's fee",
    scenario: { feesEnabled: true, account: { approved_integrators: [] } },
    expected: /Approve VEX's Lighter trading fees/,
  },
  {
    label: "the system config and the account limits both fail: the earlier read's refusal wins",
    scenario: {
      feesEnabled: true,
      client: () => ({ getSystemConfig: vi.fn(failing("config down")), getAccountLimits: vi.fn(failing("limits down")) }),
    },
    expected: /config down/,
  },
  {
    label: "a reduce-only sell whose fee reads fail is prepared without fees",
    scenario: {
      feesEnabled: true,
      params: { side: "sell", reduceOnly: true, price: "3490" },
      client: () => ({ getSystemConfig: vi.fn(failing("config down")) }),
    },
    expected: /"status\\":\\"preview_ready\\"/,
  },
  {
    label: "the fee collector itself cannot be resolved",
    scenario: { feesEnabled: "broken" },
    expected: /fee collector is not configured correctly/,
  },
  // The first batch, with the fee reads in flight beside it.
  {
    label: "the market read fails while the fee reads are in flight",
    scenario: { feesEnabled: true, client: () => ({ getMarketDetails: vi.fn(failing("market down")) }) },
    expected: /Lighter order preview unavailable \(.*market down/,
  },
  {
    label: "the market is missing while the fee reads are in flight",
    scenario: {
      feesEnabled: true,
      client: () => ({ getMarketDetails: vi.fn(async () => ({ code: 200, order_book_details: [], spot_order_book_details: [] })) }),
    },
    expected: /No live Lighter market detail found for marketId 0/,
  },
  {
    label: "the market is not the requested market type",
    scenario: { feesEnabled: true, params: { marketType: "spot" } },
    expected: /is a perp market, not the requested spot market/,
  },
  {
    label: "the account read cannot reach Lighter while the fee reads are in flight",
    scenario: {
      feesEnabled: true,
      client: (client) => ({
        getAccount: vi.fn<LighterClient["getAccount"]>(async (environment, params, options) => {
          if (Number(params.value) === ACCOUNT_INDEX) throw new VexError(ErrorCodes.LIGHTER_TIMEOUT, "account timed out");
          return client.getAccount(environment, params, options);
        }),
      }),
    },
    expected: /Lighter order preview unavailable \(.*account timed out/,
  },
  // The spot fee-tier check.
  {
    label: "a spot buy with fees passes its account fee tier",
    scenario: { feesEnabled: true, market: SPOT_MARKET },
    expected: /"status\\":\\"preview_ready\\"/,
  },
  {
    label: "a spot buy's account taker fee tier is invalid",
    scenario: {
      feesEnabled: true,
      market: SPOT_MARKET,
      client: () => ({ getAccountLimits: vi.fn(async () => ({ ...ACCOUNT_LIMITS, current_taker_fee_tick: -1 })) }),
    },
    expected: /current Lighter account taker fee is invalid/,
  },
  {
    label: "a spot buy's account limits read fails",
    scenario: { feesEnabled: true, market: SPOT_MARKET, client: () => ({ getAccountLimits: vi.fn(failing("limits down")) }) },
    expected: /limits down/,
  },
  // The capital-share advisory, then the admission inside approval creation.
  {
    label: "the advisory resolver throws with no fee policy, failing the preview",
    scenario: { auth: "throws" },
    expected: /Lighter order preview unavailable \(.*vault read failed/,
  },
  {
    label: "no share is configured and the order clearly fits",
    scenario: {},
    expected: /"status\\":\\"preview_ready\\"/,
  },
  {
    label: "the order sits within the capital share",
    scenario: { share: 50 },
    expected: /within_share/,
  },
  {
    label: "the capital share would refuse and the ledger refuses",
    scenario: { share: 1, refuseAdmission: true },
    expected: /exceeds the 5\.000000 still available under the agent's 1% capital share/,
  },
  {
    label: "the ledger refuses the admission",
    scenario: { share: 50, refuseAdmission: true },
    expected: /still available under the agent's 50% capital share/,
  },
  {
    label: "the account reports no owning wallet",
    scenario: { share: 50, account: { l1_address: "not-a-wallet" } },
    expected: /reported no owning L1 address/,
  },
  {
    label: "the capital share cannot read the account's exchange fee tier",
    scenario: { share: 50, client: () => ({ getAccountLimits: vi.fn(failing("limits down")) }) },
    expected: /could not read this Lighter account's exchange fee tier \(limits down\)/,
  },
  {
    label: "the capital share has no read-only auth",
    scenario: { share: 50, auth: "none" },
    expected: /could not read this Lighter account's exchange fee tier, so the charge/,
  },
  {
    label: "the capital share cannot read the account's resting orders",
    scenario: {
      share: 50,
      account: { total_order_count: 1 },
      client: () => ({ getAccountActiveOrders: vi.fn(failing("orders down")) }),
    },
    expected: /could not read this Lighter account's resting orders \(orders down\)/,
  },
  {
    label: "the market has no margin fraction to price the capital share",
    scenario: { share: 50, market: UNPRICED_MARKET, account: { positions: [] } },
    expected: /default_initial_margin_fraction/,
  },
  {
    label: "a fee-bearing order is admitted under the capital share with resting orders",
    scenario: { feesEnabled: true, share: 50, account: { total_order_count: 1 } },
    expected: /"status\\":\\"preview_ready\\"/,
  },
  // The margin-fit check inside approval creation.
  {
    label: "the order no longer fits the account's available margin",
    scenario: { account: { available_balance: "10", collateral: "10" } },
    expected: /would cancel this ETH order with no fill/,
  },
  {
    label: "a near-margin order fits after the depth read",
    scenario: { account: NEAR_MARGIN },
    expected: /"status\\":\\"preview_ready\\"/,
  },
  {
    label: "a near-margin fee-bearing order fits after the depth read",
    scenario: { feesEnabled: true, account: NEAR_MARGIN },
    expected: /"status\\":\\"preview_ready\\"/,
  },
  {
    label: "the margin-fit depth and tier reads fail, which lets the order through as today",
    scenario: {
      account: NEAR_MARGIN,
      client: (client) => ({
        getOrderBookOrders: vi.fn<LighterClient["getOrderBookOrders"]>(async (environment, params, options) => {
          if (params.limit === DEPTH_LIMIT) throw new Error("depth down");
          return client.getOrderBookOrders(environment, params, options);
        }),
        getAccountLimits: vi.fn(failing("limits down")),
      }),
    },
    expected: /"status\\":\\"preview_ready\\"/,
  },
  {
    label: "the margin-fit check finds no read-only auth",
    scenario: { account: NEAR_MARGIN, auth: "none" },
    expected: /"status\\":\\"preview_ready\\"/,
  },
  {
    label: "a near-margin order under a share whose ledger refuses",
    scenario: { feesEnabled: true, share: 50, refuseAdmission: true, account: { ...NEAR_MARGIN, total_order_count: 1 } },
    expected: /still available under the agent's 50% capital share/,
  },
  // Approval creation itself.
  {
    label: "no trading key is published, so only the preview is stored",
    scenario: { feesEnabled: true, account: NEAR_MARGIN, params: { apiKeyIndex: null } },
    expected: /"approvalReady\\":false/,
  },
  {
    label: "an approval is already pending for this exact preview",
    scenario: { feesEnabled: true, existingIntent: true },
    expected: /lighter-exec-existing-intent-0001/,
  },
];

function createGate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  configureLighterTradingCredentialScopeResolver({
    findSavedScope: async () => null,
    findDefaultScope: async () => null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  configureLighterReadOnlyAccountAuthResolver(null);
  configureLighterOrderPreviewDeps(null);
  state.client = null;
  state.share = null;
  state.refuseAdmission = false;
});

describe("LIGHTER_PREVIEW_SINGLE_SNAPSHOT", () => {
  it("ships ON", () => {
    expect(LIGHTER_PREVIEW_SINGLE_SNAPSHOT).toBe(true);
  });

  it.each(PREVIEW_CASES)("refuses, writes and admits exactly what OFF does when $label", async ({ scenario, expected }) => {
    const off = await observePreview(scenario, false);
    const absent = await observePreview(scenario, "constant");
    const on = await observePreview(scenario, true);

    expect(JSON.stringify(off.observation.result)).toMatch(expected);
    expect(absent.observation).toEqual(off.observation);
    expect(on.observation).toEqual(off.observation);
  });

  it.each(PREVIEW_CASES)("matches OFF on the desk lane too when $label", async ({ scenario }) => {
    const off = await observePreview(scenario, false, DESK_CTX);
    const on = await observePreview(scenario, true, DESK_CTX);
    expect(on.observation).toEqual(off.observation);
  });

  it("reads each value once: the call map of a near-margin fee-bearing order under a capital share", async () => {
    const scenario: PreviewScenario = { feesEnabled: true, share: 50, account: { ...NEAR_MARGIN, total_order_count: 1 } };
    const off = await observePreview(scenario, false);
    const on = await observePreview(scenario, true);

    expect(JSON.stringify(off.observation.result)).toMatch(/"approvalReady\\":true/);
    // Today: the token is minted by the fee check, the advisory, the margin
    // fit and the admission; the account limits are read by each of them; the
    // admission re-reads the account and, with the margin fit, the market.
    expect(off.reads).toEqual({
      readOnlyAuth: 4,
      getAccount: 3,
      getMarketDetails: 3,
      getSystemConfig: 1,
      getAccountLimits: 4,
      getOrderBookOrders: 2,
      marginDepthReads: 1,
      getAccountActiveOrders: 2,
    });
    expect(on.reads).toEqual({
      readOnlyAuth: 1,
      getAccount: 2,
      getMarketDetails: 1,
      getSystemConfig: 1,
      getAccountLimits: 1,
      getOrderBookOrders: 2,
      marginDepthReads: 1,
      getAccountActiveOrders: 2,
    });
  });

  it("mints the read-only token once for an ordinary fee-bearing desk order", async () => {
    const off = await observePreview({ feesEnabled: true }, false, DESK_CTX);
    const on = await observePreview({ feesEnabled: true }, true, DESK_CTX);
    expect(off.reads.readOnlyAuth).toBe(2);
    expect(on.reads.readOnlyAuth).toBe(1);
    expect(on.reads.getAccountLimits).toBe(1);
    expect(on.reads.getAccount).toBe(off.reads.getAccount - 1);
    expect(on.reads.getMarketDetails).toBe(off.reads.getMarketDetails);
  });

  it("starts the fee reads beside the first batch but mints no token until that batch succeeded", async () => {
    const { client, resolver } = armScenario({ feesEnabled: true });
    const marketGate = createGate();
    const getMarketDetails = client.getMarketDetails.getMockImplementation();
    client.getMarketDetails.mockImplementation(async (environment, params, options) => {
      await marketGate.promise;
      return requireValue(getMarketDetails)(environment, params, options);
    });
    configureLighterOrderPreviewDeps({ previewSingleSnapshot: true });

    const run = requireValue(LIGHTER_READ_HANDLERS["lighter.order.preview"])(previewParams({ feesEnabled: true }), READ_CTX);
    await vi.waitFor(() => {
      expect(client.getMarketDetails).toHaveBeenCalledTimes(1);
      expect(client.getSystemConfig).toHaveBeenCalledWith("rhc", { fresh: true });
      expect(client.getAccount).toHaveBeenCalledWith("rhc", { by: "index", value: FEE_COLLECTOR_INDEX }, { fresh: true });
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(client.getAccountLimits).not.toHaveBeenCalled();
    expect(depthReads(client)).toBe(0);

    marketGate.release();
    const result = await run;
    expect(result.success, result.output).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("starts the margin-fit depth read beside the fee reads instead of after approval creation begins", async () => {
    for (const previewSingleSnapshot of [false, true]) {
      const scenario: PreviewScenario = { feesEnabled: true, account: NEAR_MARGIN };
      const { client } = armScenario(scenario);
      const configGate = createGate();
      client.getSystemConfig.mockImplementation(async () => {
        await configGate.promise;
        return SYSTEM_CONFIG;
      });
      configureLighterOrderPreviewDeps({ previewSingleSnapshot });

      const run = requireValue(LIGHTER_READ_HANDLERS["lighter.order.preview"])(previewParams(scenario), READ_CTX);
      await vi.waitFor(() => expect(client.getSystemConfig).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(client.getAccountLimits).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(depthReads(client)).toBe(previewSingleSnapshot ? 1 : 0);
      expect(state.previewCreate).not.toHaveBeenCalled();

      configGate.release();
      const result = await run;
      expect(result.success, result.output).toBe(true);
      expect(depthReads(client)).toBe(1);
      configureLighterOrderPreviewDeps(null);
    }
  });

  it("never starts a depth read the margin-fit check would not make", async () => {
    const clearlyFits = await observePreview({ feesEnabled: true }, true);
    expect(clearlyFits.reads.marginDepthReads).toBe(0);
    const reduceOnly = await observePreview({ params: { side: "sell", reduceOnly: true, price: "3490" }, account: NEAR_MARGIN }, true);
    expect(reduceOnly.reads.marginDepthReads).toBe(0);
    const noApproval = await observePreview({ account: NEAR_MARGIN, params: { apiKeyIndex: null } }, true);
    expect(noApproval.reads.marginDepthReads).toBe(0);
  });

  it("admits a stored preview from another prepare with its own reads", async () => {
    for (const previewSingleSnapshot of [false, true]) {
      const { client, resolver } = armScenario({ share: 50 });
      // The durable row the approval reads names another market than this
      // prepare's snapshot, so the snapshot must not stand in for it.
      const created = new Map<string, LighterOrderPreviewRow>();
      state.previewCreate.mockImplementation(async (input: {
        readonly preview: LighterOrderPreview;
        readonly liveSourceJson: Record<string, unknown>;
      }) => {
        created.set(input.preview.previewId, { ...storedRow(input), marketIndex: 1 });
      });
      state.previewFindFreshById.mockImplementation(
        async (_sessionId: string, _environment: string, previewId: string) => created.get(previewId) ?? null,
      );
      configureLighterOrderPreviewDeps({ previewSingleSnapshot });
      const result = await requireValue(LIGHTER_READ_HANDLERS["lighter.order.preview"])(previewParams({ share: 50 }), READ_CTX);
      expect(result.success).toBe(false);
      expect(result.output).toContain("Lighter did not return market 1");
      // Today's admission reads: the account again, the market for both the
      // margin fit (no position row on market 1) and the capital share, and
      // the margin fit's own token beside the advisory's.
      expect(client.getAccount).toHaveBeenCalledWith("rhc", { by: "index", value: ACCOUNT_INDEX, activeOnly: false });
      expect(client.getMarketDetails).toHaveBeenCalledTimes(3);
      expect(resolver).toHaveBeenCalledTimes(2);
      configureLighterOrderPreviewDeps(null);
    }
  });

  it("leaves the standalone lighter.order.create.prepare path reading exactly as today", async () => {
    const maps: Record<string, number>[] = [];
    for (const previewSingleSnapshot of [false, true]) {
      const scenario: PreviewScenario = { feesEnabled: true, share: 50, account: NEAR_MARGIN };
      const { client, resolver } = armScenario(scenario);
      configureLighterOrderPreviewDeps({ previewSingleSnapshot: false });
      const preview = await requireValue(LIGHTER_READ_HANDLERS["lighter.order.preview"])(
        previewParams({ ...scenario, params: { apiKeyIndex: null } }),
        READ_CTX,
      );
      expect(preview.success, preview.output).toBe(true);
      const previewId = requireValue(state.previewCreate.mock.calls[0])[0].preview.previewId;
      const stored = await state.previewFindFreshById("session-1", "rhc", previewId);
      state.previewFindFreshById.mockResolvedValue({ ...stored, apiKeyIndex: 7 });
      for (const read of Object.values(client)) read.mockClear();
      resolver.mockClear();
      configureLighterOrderPreviewDeps({ previewSingleSnapshot });

      const prepared = await requireValue(LIGHTER_WRITE_HANDLERS["lighter.order.create.prepare"])(
        { environment: "rhc", previewId },
        READ_CTX,
      );
      expect(prepared.success, prepared.output).toBe(true);
      maps.push(readMap(client, resolver));
      configureLighterOrderPreviewDeps(null);
    }
    expect(maps[1]).toEqual(maps[0]);
    expect(requireValue(maps[0]).getAccount).toBe(1);
  });

  it("logs the batch timing fields on the desk timing line, numbers only", async () => {
    const timingLine = (): Record<string, unknown> => {
      const line = state.logger.info.mock.calls.find((call) => call[0] === "lighter.desk.order_preview_timing");
      const meta: unknown = requireValue(line)[1];
      return typeof meta === "object" && meta !== null ? { ...meta } : {};
    };

    await observePreview({ feesEnabled: true, account: NEAR_MARGIN }, true, DESK_CTX);
    const on = timingLine();
    expect(Object.keys(on).sort()).toEqual([
      "accountLimitsReadMs",
      "approvalMs",
      "capitalMs",
      "earlyMarginDepth",
      "feeConfigReadMs",
      "feeMs",
      "marginDepthReadMs",
      "marketIdKeyAndRecoveryMs",
      "marketReadsMs",
      "ownershipMs",
      "previewMs",
      "readAuthMs",
      "singleSnapshot",
      "totalMs",
    ]);
    for (const value of Object.values(on)) expect(typeof value).toBe("number");
    expect(on.singleSnapshot).toBe(1);
    expect(on.earlyMarginDepth).toBe(1);

    await observePreview({ feesEnabled: true, account: NEAR_MARGIN }, false, DESK_CTX);
    const off = timingLine();
    expect(Object.keys(off).sort()).toEqual([
      "approvalMs",
      "capitalMs",
      "feeMs",
      "marketIdKeyAndRecoveryMs",
      "marketReadsMs",
      "ownershipMs",
      "previewMs",
      "singleSnapshot",
      "totalMs",
    ]);
    expect(off.singleSnapshot).toBe(0);
  });

  it("composes the integrator fees the approval binds from the snapshot exactly as OFF", async () => {
    const off = await observePreview({ feesEnabled: true }, false);
    const on = await observePreview({ feesEnabled: true }, true);
    const fees = getLighterIntegratorFees(FEE_POLICY, "perp");
    expect(JSON.stringify(off.observation.intentWrites)).toContain(`"integratorTakerFee":${fees.integratorTakerFee}`);
    expect(on.observation.intentWrites).toEqual(off.observation.intentWrites);
  });
});
