import {
  ApproveBuilderFeeTypes,
  CDepositTypes,
  CWithdrawTypes,
  SpotSendTypes,
  TokenDelegateTypes,
  UsdClassTransferTypes,
  UsdSendTypes,
  Withdraw3Types,
} from "@nktkas/hyperliquid/api/exchange";
import type { Address } from "viem";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { endpointsForNetwork, type HyperliquidNetwork } from "./constants.js";
import { HyperliquidClientError } from "./errors.js";
import { HyperliquidMetaCache } from "./meta-cache.js";
import { HyperliquidSigner } from "./signer.js";
import type {
  DecimalString,
  HyperliquidExchangeResult,
  HyperliquidL1Request,
  HyperliquidLimitOrder,
  HyperliquidOrder,
  HyperliquidOrderStatus,
  HyperliquidTriggerOrder,
  HyperliquidTimeoutRecovery,
  HyperliquidUserSignedRequest,
} from "./types.js";
import {
  assertMinimumNotional,
  assertValidLeverage,
  assertValidPerpPrice,
  assertValidSpotPrice,
  assertValidPerpSize,
  compareDecimals,
  marketOrderPrice,
  normalizeProviderDecimal,
} from "./validation.js";

const exchangeRootSchema = z.object({
  status: z.string().optional(),
  response: z.unknown().optional(),
}).passthrough();

export interface HyperliquidExchangeOptions {
  readonly signer: HyperliquidSigner;
  /** Required so perp and spot order validation cannot be skipped before signing. */
  readonly metaCache: HyperliquidMetaCache;
  readonly network?: HyperliquidNetwork;
  /** Attached only after first-entry disclosure + live max-fee confirmation. */
  readonly builder?: { readonly b: Address; readonly f: 25 };
  readonly infoClient?: Pick<import("./info.js").HyperliquidInfoClient, "orderStatus">;
  readonly cloidFactory?: () => `0x${string}`;
}

export interface OpenWithStopLossInput {
  readonly entry: HyperliquidOrder;
  readonly stopLoss: HyperliquidTriggerOrder;
  readonly takeProfit?: HyperliquidTriggerOrder;
  readonly signal?: AbortSignal;
}

export interface OpenPositionInput {
  /** A plain entry only. This method never attaches TP/SL children. */
  readonly entry: HyperliquidLimitOrder;
  readonly signal?: AbortSignal;
}

export interface HyperliquidTwapOrder {
  readonly a: number;
  readonly b: boolean;
  readonly s: DecimalString;
  readonly r: false;
  readonly m: number;
  readonly t: boolean;
}

/**
 * Read-only preflight for a prospective perp entry. Callers that must change
 * leverage before submitting an order use this to prove the complete bundle
 * is valid before any account mutation is signed.
 */
export interface PerpOpenPreflightInput {
  readonly entry: HyperliquidLimitOrder;
  readonly stopLoss?: HyperliquidTriggerOrder;
  readonly takeProfit?: HyperliquidTriggerOrder;
  readonly leverage: number;
}

/**
 * Privileged exchange wrapper. It intentionally does not call SDK exchange
 * convenience methods: Vex constructs every action, uses the SDK only for the
 * verified low-level signature, and posts the signed body itself.
 */
export class HyperliquidExchangeClient {
  private readonly signer: HyperliquidSigner;
  private readonly metaCache: HyperliquidMetaCache;
  private readonly network: HyperliquidNetwork;
  private readonly builder: { readonly b: Address; readonly f: 25 } | undefined;
  private readonly infoClient: Pick<import("./info.js").HyperliquidInfoClient, "orderStatus"> | undefined;
  private readonly cloidFactory: () => `0x${string}`;

  constructor(options: HyperliquidExchangeOptions) {
    this.signer = options.signer;
    this.metaCache = options.metaCache;
    this.network = options.network ?? "mainnet";
    this.builder = options.builder;
    this.infoClient = options.infoClient;
    this.cloidFactory = options.cloidFactory ?? (() => `0x${randomBytes(16).toString("hex")}`);
  }

  /** Per-call clients are immutable; this cannot alter an already-signed order. */
  withBuilder(builder: { readonly b: Address; readonly f: 25 } | undefined): HyperliquidExchangeClient {
    return new HyperliquidExchangeClient({
      signer: this.signer,
      metaCache: this.metaCache,
      network: this.network,
      ...(builder === undefined ? {} : { builder }),
      ...(this.infoClient === undefined ? {} : { infoClient: this.infoClient }),
      cloidFactory: this.cloidFactory,
    });
  }

  async openWithStopLoss(input: OpenWithStopLossInput): Promise<HyperliquidExchangeResult> {
    if (!input.stopLoss.r || input.stopLoss.t.trigger.tpsl !== "sl") {
      throw new HyperliquidClientError("validation", "Open-with-stop-loss requires a reduce-only stop-loss child.");
    }
    const orders = [input.entry, input.stopLoss, ...(input.takeProfit ? [input.takeProfit] : [])];
    return this.submitOrder({ orders, grouping: "normalTpsl" }, input.signal);
  }

  /**
   * Submit one validated plain entry. This capability exists solely for the
   * user-owned `requireStopLoss=false` policy state; protocol code must select
   * it from that resolved policy, never from a model-controlled parameter.
   */
  openPosition(input: OpenPositionInput): Promise<HyperliquidExchangeResult> {
    if (input.entry.r) {
      throw new HyperliquidClientError("validation", "Plain position entry must not be reduce-only.");
    }
    return this.submitOrder({ orders: [input.entry], grouping: "na" }, input.signal);
  }

  /**
   * Validate every entry child and the requested leverage without signing or
   * posting. This intentionally shares the exact metadata/tick/lot/notional
   * path used by `submitOrder`, rather than creating a handler-local rule set.
   */
  async preflightPerpOpen(input: PerpOpenPreflightInput): Promise<void> {
    if (input.entry.r) {
      throw new HyperliquidClientError("validation", "Perp entry must not be reduce-only.");
    }
    if (input.stopLoss !== undefined && (!input.stopLoss.r || input.stopLoss.t.trigger.tpsl !== "sl")) {
      throw new HyperliquidClientError("validation", "Perp preflight requires a reduce-only stop-loss child.");
    }
    if (input.takeProfit !== undefined && (!input.takeProfit.r || input.takeProfit.t.trigger.tpsl !== "tp")) {
      throw new HyperliquidClientError("validation", "Perp preflight requires a reduce-only take-profit child.");
    }
    const asset = (await this.metaCache.get()).perpsByAsset.get(input.entry.a);
    if (asset === undefined) {
      throw new HyperliquidClientError("validation", `Unknown Hyperliquid perp asset ${input.entry.a}.`);
    }
    assertValidLeverage(input.leverage, asset.maxLeverage);
    await this.validateOrders([
      input.entry,
      ...(input.stopLoss === undefined ? [] : [input.stopLoss]),
      ...(input.takeProfit === undefined ? [] : [input.takeProfit]),
    ]);
  }

  /** Place the sole full-position TP/SL trigger using the absolute live position size. */
  setPositionTpsl(order: HyperliquidTriggerOrder, signal?: AbortSignal): Promise<HyperliquidExchangeResult> {
    if (!order.r) throw new HyperliquidClientError("validation", "Position TP/SL must be reduce-only.");
    return this.submitOrder({ orders: [order], grouping: "positionTpsl" }, signal);
  }

  async closePosition(input: {
    readonly asset: number;
    readonly side: "buy" | "sell";
    readonly size: DecimalString;
    readonly markPrice: DecimalString;
    readonly slippageBps: number;
    readonly cloid?: `0x${string}`;
    readonly signal?: AbortSignal;
  }): Promise<HyperliquidExchangeResult> {
    const asset = (await this.metaCache.get()).perpsByAsset.get(input.asset);
    if (asset === undefined) throw new HyperliquidClientError("validation", `Unknown Hyperliquid perp asset ${input.asset}.`);
    const order: HyperliquidOrder = {
      a: input.asset,
      b: input.side === "buy",
      p: marketOrderPrice(input.markPrice, input.side, input.slippageBps, asset.szDecimals),
      s: input.size,
      r: true,
      t: { limit: { tif: "Ioc" } },
      ...(input.cloid ? { c: input.cloid } : {}),
    };
    return this.submitOrder({ orders: [order], grouping: "na" }, input.signal);
  }

  spotOrder(input: { readonly order: HyperliquidOrder; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitOrder({ orders: [input.order], grouping: "na" }, input.signal);
  }

  async modify(input: { readonly oid: number; readonly order: HyperliquidOrder; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    const order = this.withCloids([input.order])[0];
    // withCloids maps 1:1; an empty result would be a programming error, and
    // noUncheckedIndexedAccess requires the invariant to be stated explicitly.
    if (order === undefined) throw new HyperliquidClientError("validation", "Order normalization produced no order.");
    await this.validateOrders([order]);
    return this.submitL1({ action: { type: "modify", oid: input.oid, order }, signal: input.signal, cloids: [order.c] }, [order]);
  }

  async batchModify(input: { readonly modifies: readonly { readonly oid: number; readonly order: HyperliquidOrder }[]; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    const orders = this.withCloids(input.modifies.map((item) => item.order));
    const modifies = input.modifies.map((item, index) => ({ oid: item.oid, order: orders[index] }));
    await this.validateOrders(orders);
    return this.submitL1({ action: { type: "batchModify", modifies }, signal: input.signal, cloids: orders.map((order) => order.c) }, orders);
  }

  cancel(input: { readonly cancels: readonly { readonly a: number; readonly o: number }[]; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    const cancels = input.cancels.map((cancel) => ({ a: cancel.a, o: cancel.o }));
    return this.submitL1({ action: { type: "cancel", cancels }, signal: input.signal });
  }

  /** Hyperliquid uses `asset`/`cloid` here, unlike cancel's `a`/`o`. */
  cancelByCloid(input: { readonly cancels: readonly { readonly asset: number; readonly cloid: `0x${string}` }[]; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    const cancels = input.cancels.map((cancel) => ({ asset: cancel.asset, cloid: cancel.cloid }));
    return this.submitL1({ action: { type: "cancelByCloid", cancels }, signal: input.signal, cloids: cancels.map((cancel) => cancel.cloid) });
  }

  async updateLeverage(input: { readonly asset: number; readonly isCross: boolean; readonly leverage: number; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    const asset = (await this.metaCache.get()).perpsByAsset.get(input.asset);
    if (!asset) throw new HyperliquidClientError("validation", `Unknown Hyperliquid perp asset ${input.asset}.`);
    assertValidLeverage(input.leverage, asset.maxLeverage);
    return this.submitL1({ action: { type: "updateLeverage", asset: input.asset, isCross: input.isCross, leverage: input.leverage }, signal: input.signal });
  }

  updateIsolatedMargin(input: { readonly asset: number; readonly isBuy: boolean; readonly ntli: number; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    if (!Number.isSafeInteger(input.ntli)) throw new HyperliquidClientError("validation", "Isolated-margin ntli must be a safe integer.");
    return this.submitL1({ action: { type: "updateIsolatedMargin", asset: input.asset, isBuy: input.isBuy, ntli: input.ntli }, signal: input.signal });
  }

  topUpIsolatedOnlyMargin(input: { readonly asset: number; readonly leverage: DecimalString; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitL1({ action: { type: "topUpIsolatedOnlyMargin", asset: input.asset, leverage: input.leverage }, signal: input.signal });
  }

  twapOrder(input: { readonly twap: HyperliquidTwapOrder; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    if (!Number.isSafeInteger(input.twap.m) || input.twap.m < 5 || input.twap.m > 1440) {
      throw new HyperliquidClientError("validation", "TWAP minutes must be a safe integer from 5 to 1440.");
    }
    return this.submitL1({ action: { type: "twapOrder", twap: { a: input.twap.a, b: input.twap.b, s: input.twap.s, r: input.twap.r, m: input.twap.m, t: input.twap.t } }, signal: input.signal });
  }

  twapCancel(input: { readonly a: number; readonly t: number; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitL1({ action: { type: "twapCancel", a: input.a, t: input.t }, signal: input.signal });
  }

  vaultTransfer(input: { readonly vaultAddress: Address; readonly isDeposit: boolean; readonly usd: number; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitL1({ action: { type: "vaultTransfer", vaultAddress: input.vaultAddress, isDeposit: input.isDeposit, usd: input.usd }, signal: input.signal });
  }

  claimRewards(signal?: AbortSignal): Promise<HyperliquidExchangeResult> {
    return this.submitL1({ action: { type: "claimRewards" }, signal });
  }

  /** Client support only. Product runtime must never arm this action. */
  scheduleCancel(input: { readonly time?: number; readonly signal?: AbortSignal } = {}): Promise<HyperliquidExchangeResult> {
    const action = input.time === undefined
      ? { type: "scheduleCancel" }
      : { type: "scheduleCancel", time: input.time };
    return this.submitL1({ action, signal: input.signal });
  }

  usdClassTransfer(input: { readonly amount: DecimalString; readonly toPerp: boolean; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitUser({ type: "usdClassTransfer", amount: input.amount, toPerp: input.toPerp }, UsdClassTransferTypes, input.signal, "nonce");
  }

  usdSend(input: { readonly destination: Address; readonly amount: DecimalString; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitUser({ type: "usdSend", destination: input.destination, amount: input.amount }, UsdSendTypes, input.signal, "time");
  }

  spotSend(input: { readonly destination: Address; readonly token: string; readonly amount: DecimalString; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitUser({ type: "spotSend", destination: input.destination, token: input.token, amount: input.amount }, SpotSendTypes, input.signal, "time");
  }

  withdraw3(input: { readonly destination: Address; readonly amount: DecimalString; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitUser({ type: "withdraw3", destination: input.destination, amount: input.amount }, Withdraw3Types, input.signal, "time");
  }

  tokenDelegate(input: { readonly validator: Address; readonly wei: number; readonly isUndelegate: boolean; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitUser({ type: "tokenDelegate", validator: input.validator, wei: input.wei, isUndelegate: input.isUndelegate }, TokenDelegateTypes, input.signal, "nonce");
  }

  cDeposit(input: { readonly wei: number; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitUser({ type: "cDeposit", wei: input.wei }, CDepositTypes, input.signal, "nonce");
  }

  cWithdraw(input: { readonly wei: number; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitUser({ type: "cWithdraw", wei: input.wei }, CWithdrawTypes, input.signal, "nonce");
  }

  approveBuilderFee(input: { readonly builder: Address; readonly maxFeeRate: `${string}%`; readonly signal?: AbortSignal }): Promise<HyperliquidExchangeResult> {
    return this.submitUser({ type: "approveBuilderFee", builder: input.builder, maxFeeRate: input.maxFeeRate }, ApproveBuilderFeeTypes, input.signal, "nonce");
  }

  private submitOrder(
    action: { readonly orders: readonly HyperliquidOrder[]; readonly grouping: "na" | "normalTpsl" | "positionTpsl" },
    signal?: AbortSignal,
  ): Promise<HyperliquidExchangeResult> {
    return this.validateThenSubmitOrder(action, signal);
  }

  private async validateThenSubmitOrder(
    action: { readonly orders: readonly HyperliquidOrder[]; readonly grouping: "na" | "normalTpsl" | "positionTpsl" },
    signal?: AbortSignal,
  ): Promise<HyperliquidExchangeResult> {
    const orders = this.withCloids(action.orders);
    await this.validateOrders(orders);
    const signedAction = this.builder === undefined
      ? { type: "order", orders, grouping: action.grouping }
      : { type: "order", orders, grouping: action.grouping, builder: this.builder };
    return this.submitL1({
      action: signedAction,
      signal,
      cloids: orders.map((order) => order.c),
    }, orders);
  }

  private withCloids(orders: readonly HyperliquidOrder[]): Array<HyperliquidOrder & { readonly c: `0x${string}` }> {
    return orders.map((order) => canonicalOrder(order, order.c ?? this.cloidFactory()));
  }

  private async validateOrders(orders: readonly HyperliquidOrder[]): Promise<void> {
    const metadata = await this.metaCache.get();
    for (const order of orders) {
      if (order.a >= 10_000) {
        const spot = [...metadata.spotByName.values()].find((candidate) => candidate.asset === order.a);
        if (spot === undefined) throw new HyperliquidClientError("validation", `Unknown Hyperliquid spot asset ${order.a}.`);
        assertValidSpotPrice(order.p, spot.szDecimals);
        assertValidPerpSize(order.s, spot.szDecimals);
        assertMinimumNotional(order.p, order.s, order.r);
        continue;
      }
      const asset = metadata.perpsByAsset.get(order.a);
      if (!asset) throw new HyperliquidClientError("validation", `Unknown Hyperliquid perp asset ${order.a}.`);
      assertValidPerpPrice(order.p, asset.szDecimals);
      if ("trigger" in order.t) assertValidPerpPrice(order.t.trigger.triggerPx, asset.szDecimals);
      assertValidPerpSize(order.s, asset.szDecimals);
      assertMinimumNotional(order.p, order.s, order.r);
    }
  }

  private async submitL1(request: HyperliquidL1Request, expectedOrders: readonly HyperliquidOrder[] = []): Promise<HyperliquidExchangeResult> {
    try {
      const signed = await this.signer.signL1(request);
      const raw = await this.signer.post(signed, request.signal);
      return parseExchangeResponse(raw, expectedOrders);
    } catch (cause) {
      if (cause instanceof HyperliquidClientError && cause.code === "timeout") {
        const cloids = request.cloids ?? [];
        const recovery = await this.recoverTimedOutOrders(cloids);
        return { kind: "transport_timeout", cloids, recovery, cause };
      }
      throw cause;
    }
  }

  private async submitUser(
    fields: Record<string, unknown>,
    types: Record<string, readonly { readonly name: string; readonly type: string }[]>,
    signal: AbortSignal | undefined,
    nonceKey: "nonce" | "time",
  ): Promise<HyperliquidExchangeResult> {
    const endpoints = endpointsForNetwork(this.network);
    const nonce = this.signer.nextNonce();
    const action: Record<string, unknown> & { signatureChainId: `0x${string}` } = {
      ...fields,
      signatureChainId: endpoints.signatureChainId,
      hyperliquidChain: endpoints.hyperliquidChain,
      [nonceKey]: nonce,
    };
    const request: HyperliquidUserSignedRequest = { action, types, signal };
    try {
      const signed = await this.signer.signUserAction(request);
      const raw = await this.signer.post(signed, signal);
      return parseExchangeResponse(raw, []);
    } catch (cause) {
      if (cause instanceof HyperliquidClientError && cause.code === "timeout") {
        return { kind: "transport_timeout", cloids: [], recovery: [], cause };
      }
      throw cause;
    }
  }

  private async recoverTimedOutOrders(cloids: readonly `0x${string}`[]): Promise<readonly HyperliquidTimeoutRecovery[]> {
    if (this.infoClient === undefined) return cloids.map((cloid) => ({ kind: "unknown", cloid }));
    const user = this.signer.address;
    return Promise.all(cloids.map(async (cloid): Promise<HyperliquidTimeoutRecovery> => {
      try {
        const status = await this.infoClient?.orderStatus(user, cloid);
        return classifyOrderStatusRecovery(cloid, status);
      } catch {
        return { kind: "unknown", cloid };
      }
    }));
  }
}

export function classifyOrderStatusRecovery(
  cloid: `0x${string}`,
  status: unknown,
): HyperliquidTimeoutRecovery {
  if (!isRecord(status)) return { kind: "unknown", cloid };
  const marker = typeof status.status === "string" ? status.status.toLowerCase() : "";
  if (marker === "unknownoid" || marker === "not_found") return { kind: "not_found", cloid };
  if (status.order !== undefined || marker !== "") return { kind: "confirmed", cloid };
  return { kind: "unknown", cloid };
}

/** Parse every order response variant without treating a partial batch as success. */
export function parseExchangeResponse(raw: unknown, expectedOrders: readonly HyperliquidOrder[] = []): HyperliquidExchangeResult {
  const parsedRoot = exchangeRootSchema.safeParse(raw);
  if (!parsedRoot.success) return { kind: "batch_error", message: "Hyperliquid exchange returned a non-object response.", raw };
  const responseRoot = parsedRoot.data;
  if (responseRoot.status === "err") return { kind: "batch_error", message: stringOr(responseRoot.response, "Hyperliquid rejected the request."), raw };
  // User-signed account, transfer, staking, reward, and builder actions have
  // no order-status payload. For an acknowledged `ok`, their success is the
  // top-level status itself; only L1 order submissions may require a status
  // count. Treating omitted `statuses` as a batch failure here can falsely
  // report a completed on-chain authorization as failed and invite a retry.
  if (responseRoot.status === "ok" && expectedOrders.length === 0) {
    return { kind: "orders", statuses: [], raw };
  }
  const statuses = nestedStatuses(responseRoot);
  if (statuses === null) {
    if (responseRoot.status === "ok") return { kind: "batch_error", message: "Hyperliquid omitted expected order statuses.", raw };
    return { kind: "batch_error", message: "Hyperliquid exchange returned an unsupported response.", raw };
  }
  if (statuses.length !== expectedOrders.length && expectedOrders.length > 0) {
    return { kind: "batch_error", message: `Hyperliquid returned ${statuses.length} statuses for ${expectedOrders.length} orders.`, raw };
  }
  const parsed: HyperliquidOrderStatus[] = [];
  for (const [index, status] of statuses.entries()) {
    parsed.push(parseOrderStatus(status, expectedOrders[index]));
  }
  return { kind: "orders", statuses: parsed, raw };
}

function parseOrderStatus(raw: unknown, expected: HyperliquidOrder | undefined): HyperliquidOrderStatus {
  if (raw === "waitingForFill" || raw === "waitingForTrigger") {
    return { kind: "accepted_resting", ...(expected?.c ? { cloid: expected.c } : {}) };
  }
  if (!isRecord(raw)) return { kind: "rejected", message: "Hyperliquid returned an invalid order status.", ...(expected?.c ? { cloid: expected.c } : {}) };
  if (typeof raw.error === "string") return { kind: "rejected", message: raw.error, ...(expected?.c ? { cloid: expected.c } : {}) };
  if (isRecord(raw.resting) && typeof raw.resting.oid === "number") {
    return { kind: "accepted_resting", oid: raw.resting.oid, ...(cloidOf(raw.resting) ?? expected?.c ? { cloid: cloidOf(raw.resting) ?? expected?.c } : {}) };
  }
  if (isRecord(raw.filled) && typeof raw.filled.oid === "number" && typeof raw.filled.totalSz === "string" && typeof raw.filled.avgPx === "string") {
    try {
      const totalSz = normalizeProviderDecimal(raw.filled.totalSz, "Filled size");
      const avgPx = normalizeProviderDecimal(raw.filled.avgPx, "Filled average price");
      const cloid = cloidOf(raw.filled) ?? expected?.c;
      if (expected?.s !== undefined && compareDecimals(totalSz, expected.s) < 0) {
        return { kind: "partially_filled", oid: raw.filled.oid, totalSz, avgPx, requestedSz: expected.s, ...(cloid ? { cloid } : {}) };
      }
      return { kind: "accepted_filled", oid: raw.filled.oid, totalSz, avgPx, ...(cloid ? { cloid } : {}) };
    } catch (cause) {
      return { kind: "rejected", message: "Hyperliquid returned invalid filled decimal values.", ...(expected?.c ? { cloid: expected.c } : {}) };
    }
  }
  return { kind: "rejected", message: "Hyperliquid returned an unrecognized order status.", ...(expected?.c ? { cloid: expected.c } : {}) };
}

function nestedStatuses(raw: Record<string, unknown>): unknown[] | null {
  const response = raw.response;
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.statuses)) return null;
  return response.data.statuses;
}

function cloidOf(raw: Record<string, unknown>): `0x${string}` | undefined {
  return typeof raw.cloid === "string" ? raw.cloid as `0x${string}` : undefined;
}

function canonicalOrder(order: HyperliquidOrder, c: `0x${string}`): HyperliquidOrder & { readonly c: `0x${string}` } {
  // Rebuilt per branch (not via a hoisted `t`) so the discriminated union
  // survives inference; field order is the venue's msgpack schema order.
  if ("limit" in order.t) {
    return { a: order.a, b: order.b, p: order.p, s: order.s, r: order.r, t: { limit: { tif: order.t.limit.tif } }, c };
  }
  return {
    a: order.a, b: order.b, p: order.p, s: order.s, r: order.r,
    t: { trigger: { isMarket: order.t.trigger.isMarket, triggerPx: order.t.trigger.triggerPx, tpsl: order.t.trigger.tpsl } },
    c,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
