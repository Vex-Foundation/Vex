import { Decimal } from "decimal.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  ARBITRUM_NATIVE_USDC_ADDRESS,
  ARBITRUM_ONE_CHAIN_ID,
  HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS,
  resolveHyperliquidNetwork,
} from "@tools/hyperliquid/constants.js";
import {
  executeHyperliquidBridge2Deposit,
  getHyperliquidBridge2DepositClients,
  parseHyperliquidBridge2DepositAmount,
} from "@tools/hyperliquid/deposit.js";
import type { HyperliquidTimeInForce } from "@tools/hyperliquid/types.js";
import type { ProtocolExecutionContext, ProtocolHandler } from "../types.js";
import { buildPositionProtectionSnapshot } from "./protection-snapshot.js";
import { builderForOrders } from "./builder-fee.js";
import {
  addressParam,
  auditCapture,
  buySell,
  decimal,
  exchangeOk,
  exchangeResult,
  fail,
  hyperliquidDepositCapture,
  infoClient,
  markForCoin,
  ok,
  positions,
  record,
  requiredBoolean,
  requiredNumber,
  requiredString,
  safeWireInteger,
  signingAddress,
  signingClients,
  string,
  usdMicros,
  withReadAddress,
} from "./handler-shared.js";

const TIME_IN_FORCE: ReadonlySet<HyperliquidTimeInForce> = new Set(["Gtc", "Ioc", "Alo", "FrontendMarket"]);

export const HYPERLIQUID_ACCOUNT_READ_HANDLERS: Record<string, ProtocolHandler> = {
  // Search + bounded output: the raw universe is ~230 markets / ~90KB, which
  // overflowed the model's context and made it miss markets near the end of the
  // list. `query` finds one ticker; the default view is the liquid majors,
  // capped so a no-arg call is a few KB (incident 2026-07-13).
  "hyperliquid.perp.markets": async (params) => {
    const bounds = resolveBounds(params, true, 20, 50);
    if ("error" in bounds) return fail(bounds.error);
    // ONE snapshot: universe (tuple[0]) and contexts (tuple[1]) come from the
    // same metaAndAssetCtxs response so their indexes cannot drift between
    // calls and attach another coin's price/OI/leverage to a row.
    const ctxs = await infoClient().metaAndAssetCtxs();
    const rows = compactPerpMarkets(universeOf(metaFromTuple(ctxs)), contextsOf(ctxs));
    const listing = boundedList(rows, bounds.query, (row) => row.coin, comparePerpMarket, bounds.limit);
    return ok({ returnedCount: listing.returnedCount, matchedCount: listing.matchedCount, truncated: listing.truncated, markets: listing.items });
  },
  "hyperliquid.perp.positions": async (_params, context) => withReadAddress(context, async (address) => {
    const info = infoClient();
    const [state, orders, contexts] = await Promise.all([
      info.clearinghouseState(address),
      info.frontendOpenOrders(address),
      info.metaAndAssetCtxs(),
    ]);
    const positionViews = positions(state).map((position) => ({
      position,
      protection: buildPositionProtectionSnapshot(state, orders, string(position, "coin") ?? ""),
    }));
    const single = positionViews.length === 1 ? positionViews[0] : undefined;
    const coin = string(single?.position, "coin");
    const signedSize = string(single?.position, "szi");
    const markPx = coin === undefined ? undefined : markForCoin(contexts, coin);
    const display = coin !== undefined && signedSize !== undefined && markPx !== undefined
      ? {
          namespace: "hyperliquid" as const,
          kind: "position_summary" as const,
          coin,
          side: new Decimal(signedSize).gte(0) ? "long" as const : "short" as const,
          size: new Decimal(signedSize).abs().toFixed(),
          markPx,
          protectionState: single?.protection.state,
        }
      : undefined;
    return ok({
      address,
      positions: positionViews,
      ...(display === undefined ? {} : { _displayBlock: display }),
    });
  }),
  "hyperliquid.perp.orders": async (_params, context) => withReadAddress(
    context,
    async (address) => ok({ address, orders: await infoClient().frontendOpenOrders(address) }),
  ),
  "hyperliquid.perp.fills": async (params, context) => withReadAddress(context, async (address) => {
    const bounds = resolveBounds(params, false, 50, 200);
    if ("error" in bounds) return fail(bounds.error);
    const start = resolveStartTime(params);
    if ("error" in start) return fail(start.error);
    const info = infoClient();
    const raw = start.startTime === undefined
      ? await info.userFills(address)
      : await info.userFillsByTime(address, start.startTime);
    const rows = compactFills(recordArray(raw));
    const listing = boundedList(rows, undefined, () => "", compareByTime, bounds.limit);
    return ok({ address, returnedCount: listing.returnedCount, matchedCount: listing.matchedCount, truncated: listing.truncated, fills: listing.items });
  }),
  "hyperliquid.perp.funding": async (params, context) => withReadAddress(context, async (address) => {
    const bounds = resolveBounds(params, false, 50, 200);
    if ("error" in bounds) return fail(bounds.error);
    const start = resolveStartTime(params);
    if ("error" in start) return fail(start.error);
    const rows = compactFunding(recordArray(await infoClient().userFunding(address)));
    const scoped = start.startTime === undefined ? rows : rows.filter((row) => row.time >= (start.startTime ?? 0));
    const listing = boundedList(scoped, undefined, () => "", compareByTime, bounds.limit);
    return ok({ address, returnedCount: listing.returnedCount, matchedCount: listing.matchedCount, truncated: listing.truncated, funding: listing.items });
  }),
  "hyperliquid.account.overview": async (_params, context) => withReadAddress(
    context,
    async (address) => ok({ address, account: await infoClient().clearinghouseState(address) }),
  ),
  // Same bounded-output doctrine as perp.markets: the whole spot universe raw
  // is an unbounded dump. `query` filters by pair name; the default is
  // volume-ranked and capped.
  "hyperliquid.spot.markets": async (params) => {
    const bounds = resolveBounds(params, true, 20, 50);
    if ("error" in bounds) return fail(bounds.error);
    // ONE snapshot (see perp.markets): tuple[0] universe + tuple[1] contexts.
    const ctxs = await infoClient().spotMetaAndAssetCtxs();
    const rows = compactSpotMarkets(universeOf(metaFromTuple(ctxs)), contextsOf(ctxs));
    const listing = boundedList(rows, bounds.query, (row) => row.coin, compareSpotMarket, bounds.limit);
    return ok({ returnedCount: listing.returnedCount, matchedCount: listing.matchedCount, truncated: listing.truncated, markets: listing.items });
  },
  "hyperliquid.spot.balances": async (_params, context) => withReadAddress(
    context,
    async (address) => ok({ address, balances: await infoClient().spotClearinghouseState(address) }),
  ),
  "hyperliquid.market.book": async (params) => {
    const coin = requiredString(params, "coin");
    return ok({ coin, book: await infoClient().l2Book(coin) });
  },
};

interface PerpMarketRow {
  readonly coin: string;
  readonly markPx: string | null;
  readonly midPx: string | null;
  readonly funding: string | null;
  readonly openInterest: string | null;
  readonly dayNtlVlm: string | null;
  readonly maxLeverage: number | null;
  readonly szDecimals: number | null;
  /** Venue `onlyIsolated`: true means cross margin is invalid for this asset. */
  readonly onlyIsolated: boolean;
}

interface SpotMarketRow {
  readonly coin: string;
  readonly markPx: string | null;
  readonly midPx: string | null;
  readonly prevDayPx: string | null;
  readonly dayNtlVlm: string | null;
  readonly circulatingSupply: string | null;
  /** Spot pairs are never leveraged, so this is always false; kept for envelope parity. */
  readonly onlyIsolated: boolean;
}

interface FillRow {
  readonly coin: string;
  readonly side: string | null;
  readonly px: string | null;
  readonly sz: string | null;
  readonly closedPnl: string | null;
  readonly fee: string | null;
  readonly dir: string | null;
  readonly time: number;
  readonly oid: number | null;
}

interface FundingRow {
  readonly coin: string;
  readonly fundingRate: string | null;
  readonly szi: string | null;
  readonly usdc: string | null;
  readonly time: number;
}

interface Bounds {
  readonly query: string | undefined;
  readonly limit: number;
}

const MAX_FIELD_CHARS = 64;
const MAX_DECIMAL_CHARS = 48;
// Reject an over-long raw decimal string BEFORE handing untrusted venue input
// to Decimal (defense-in-depth against a pathological payload).
const MAX_RAW_DECIMAL_CHARS = 64;

/**
 * Validate the shared search/pagination inputs. Empty/whitespace query and a
 * non-positive-integer limit are clean errors (never silently "all"); a limit
 * above the cap clamps. Returns a discriminated error so the handler can fail
 * with a readable message.
 */
function resolveBounds(
  params: Record<string, unknown>,
  hasQuery: boolean,
  defaultLimit: number,
  maxLimit: number,
): Bounds | { readonly error: string } {
  let query: string | undefined;
  if (hasQuery) {
    const raw = params["query"];
    if (raw !== undefined) {
      if (typeof raw !== "string" || raw.trim() === "") return { error: "query must be a non-empty string." };
      query = raw.trim().toLowerCase();
    }
  }
  const rawLimit = params["limit"];
  if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1)) {
    return { error: "limit must be a positive integer." };
  }
  return { query, limit: Math.min(maxLimit, typeof rawLimit === "number" ? rawLimit : defaultLimit) };
}

function resolveStartTime(params: Record<string, unknown>): { readonly startTime: number | undefined } | { readonly error: string } {
  const raw = params["startTime"];
  if (raw === undefined) return { startTime: undefined };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return { error: "startTime must be a non-negative epoch-millisecond integer." };
  }
  return { startTime: raw };
}

/** The meta object at tuple index 0 of a metaAndAssetCtxs / spotMetaAndAssetCtxs response. */
function metaFromTuple(metaAndAssetCtxs: unknown): unknown {
  return Array.isArray(metaAndAssetCtxs) ? metaAndAssetCtxs[0] : null;
}

function universeOf(meta: unknown): Record<string, unknown>[] {
  const universe = record(meta)?.["universe"];
  return Array.isArray(universe)
    ? universe.map(record).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

function contextsOf(metaAndAssetCtxs: unknown): unknown[] {
  return Array.isArray(metaAndAssetCtxs) && Array.isArray(metaAndAssetCtxs[1]) ? metaAndAssetCtxs[1] : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

/** Bound a free-text field; an over-long value is dropped rather than truncated. */
function capString(value: string | undefined, max = MAX_FIELD_CHARS): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/**
 * Canonicalize a venue decimal for MODEL-FACING output: the model copies these
 * values straight into later tool params, so a non-canonical trailing-zero
 * (e.g. "62026.0") would recreate the exact decimal-parse failure this pass
 * fixes. Normalize to canonical form; drop a malformed or pathologically long value.
 */
function canonicalVenueDecimal(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length > MAX_RAW_DECIMAL_CHARS) return null;
  try {
    const decimal = new Decimal(value);
    if (!decimal.isFinite()) return null;
    const normalized = decimal.toFixed();
    const canonical = normalized === "-0" ? "0" : normalized;
    return canonical.length <= MAX_DECIMAL_CHARS ? canonical : null;
  } catch {
    return null;
  }
}

function venueDecimal(rec: Record<string, unknown> | null, key: string): string | null {
  return canonicalVenueDecimal(string(rec, key));
}

function venueNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function numberOf(value: string | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Descending numeric compare that treats equal (incl. -Infinity) as a tie. */
function compareDesc(left: number, right: number): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function perpMarketLiquidity(row: PerpMarketRow): number {
  return numberOf(row.openInterest) ?? numberOf(row.dayNtlVlm) ?? Number.NEGATIVE_INFINITY;
}

function comparePerpMarket(a: PerpMarketRow, b: PerpMarketRow): number {
  return compareDesc(perpMarketLiquidity(a), perpMarketLiquidity(b)) || a.coin.localeCompare(b.coin);
}

function compareSpotMarket(a: SpotMarketRow, b: SpotMarketRow): number {
  return compareDesc(numberOf(a.dayNtlVlm) ?? Number.NEGATIVE_INFINITY, numberOf(b.dayNtlVlm) ?? Number.NEGATIVE_INFINITY)
    || a.coin.localeCompare(b.coin);
}

function compareByTime<T extends { readonly time: number; readonly coin: string }>(a: T, b: T): number {
  return compareDesc(a.time, b.time) || a.coin.localeCompare(b.coin);
}

/**
 * Shared bounded-read core. `query` (already lowercased) filters by ticker;
 * rows are always ordered by `compare` (deterministic, with a stable coin
 * tie-break) then capped. `matchedCount` is the post-filter size and
 * `truncated` is matchedCount > returnedCount, so filtering and truncation are
 * unambiguous. One envelope across all four bounded HL read tools.
 */
function boundedList<T>(
  rows: readonly T[],
  query: string | undefined,
  searchText: (row: T) => string,
  compare: (a: T, b: T) => number,
  limit: number,
): { readonly returnedCount: number; readonly matchedCount: number; readonly truncated: boolean; readonly items: T[] } {
  const matched = query === undefined ? rows : rows.filter((row) => searchText(row).toLowerCase().includes(query));
  const ordered = [...matched].sort(compare);
  const items = ordered.slice(0, limit);
  return { returnedCount: items.length, matchedCount: ordered.length, truncated: ordered.length > items.length, items };
}

function compactPerpMarkets(universe: readonly Record<string, unknown>[], contexts: readonly unknown[]): PerpMarketRow[] {
  const rows: PerpMarketRow[] = [];
  universe.forEach((asset, index) => {
    const coin = capString(string(asset, "name"));
    if (coin === null) return;
    const ctx = record(contexts[index]);
    rows.push({
      coin,
      markPx: venueDecimal(ctx, "markPx"),
      midPx: venueDecimal(ctx, "midPx"),
      funding: venueDecimal(ctx, "funding"),
      openInterest: venueDecimal(ctx, "openInterest"),
      dayNtlVlm: venueDecimal(ctx, "dayNtlVlm"),
      maxLeverage: venueNumber(asset["maxLeverage"]),
      szDecimals: venueNumber(asset["szDecimals"]),
      onlyIsolated: asset["onlyIsolated"] === true,
    });
  });
  return rows;
}

function compactSpotMarkets(universe: readonly Record<string, unknown>[], contexts: readonly unknown[]): SpotMarketRow[] {
  const rows: SpotMarketRow[] = [];
  universe.forEach((pair, index) => {
    const ctx = record(contexts[index]);
    const coin = capString(string(pair, "name") ?? string(ctx, "coin"));
    if (coin === null) return;
    rows.push({
      coin,
      markPx: venueDecimal(ctx, "markPx"),
      midPx: venueDecimal(ctx, "midPx"),
      prevDayPx: venueDecimal(ctx, "prevDayPx"),
      dayNtlVlm: venueDecimal(ctx, "dayNtlVlm"),
      circulatingSupply: venueDecimal(ctx, "circulatingSupply"),
      onlyIsolated: pair["onlyIsolated"] === true,
    });
  });
  return rows;
}

function compactFills(rows: readonly Record<string, unknown>[]): FillRow[] {
  const out: FillRow[] = [];
  for (const row of rows) {
    const coin = capString(string(row, "coin"));
    const time = venueNumber(row["time"]);
    if (coin === null || time === null) continue;
    out.push({
      coin,
      side: capString(string(row, "side"), 8),
      px: venueDecimal(row, "px"),
      sz: venueDecimal(row, "sz"),
      closedPnl: venueDecimal(row, "closedPnl"),
      fee: venueDecimal(row, "fee"),
      dir: capString(string(row, "dir")),
      time,
      oid: venueNumber(row["oid"]),
    });
  }
  return out;
}

function compactFunding(rows: readonly Record<string, unknown>[]): FundingRow[] {
  const out: FundingRow[] = [];
  for (const row of rows) {
    const delta = record(row["delta"]);
    const coin = capString(string(delta, "coin"));
    const time = venueNumber(row["time"]);
    if (coin === null || time === null) continue;
    out.push({
      coin,
      fundingRate: venueDecimal(delta, "fundingRate"),
      szi: venueDecimal(delta, "szi"),
      usdc: venueDecimal(delta, "usdc"),
      time,
    });
  }
  return out;
}

export const HYPERLIQUID_ACCOUNT_MUTATION_HANDLERS: Record<string, ProtocolHandler> = {
  "hyperliquid.spot.trade": spotTrade,
  "hyperliquid.deposit": deposit,
  "hyperliquid.transfer.usdClass": usdClassTransfer,
  "hyperliquid.withdraw": withdraw,
  "hyperliquid.transfer.send": send,
  "hyperliquid.vault.overview": vaultOverview,
  "hyperliquid.vault.transfer": vaultTransfer,
  "hyperliquid.staking.overview": stakingOverview,
  "hyperliquid.staking.delegate": stakingDelegate,
  "hyperliquid.staking.transfer": stakingTransfer,
  "hyperliquid.rewards.claim": claimRewards,
};

async function spotTrade(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const market = requiredString(params, "market"); const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context); const asset = (await meta.get()).spotByName.get(market); if (!asset) return fail(`Unknown Hyperliquid spot market "${market}".`);
  const tif = requiredString(params, "timeInForce") as HyperliquidTimeInForce; if (!TIME_IN_FORCE.has(tif)) return fail("timeInForce must be Gtc, Ioc, Alo, or FrontendMarket.");
  const price = decimal(params, "price"); const size = decimal(params, "size"); const side = buySell(params);
  const orderExchange = exchange.withBuilder(builderForOrders(info, exchange, address, context));
  const result = await orderExchange.spotOrder({ order: { a: asset.asset, b: side === "buy", p: price, s: size, r: false, t: { limit: { tif } } } });
  const capture = { type: "swap", chain: "hyperliquid", status: exchangeOk(result) ? "executed" : "failed", walletAddress: address, tradeSide: side, positionKey: `hyperliquid:spot:${market}:${address}`, instrumentKey: `hyperliquid:spot:${market}`, inputTokenAddress: "USDC", outputTokenAddress: market, inputAmount: size, outputAmount: size, inputValueUsd: new Decimal(price).mul(size).toFixed(), unitPriceUsd: price, valuationSource: "hyperliquid_order", meta: { market } };
  return exchangeResult(result, { market, _tradeCapture: capture });
}

async function deposit(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const network = resolveHyperliquidNetwork();
  if (network !== "mainnet") {
    return fail("hyperliquid.deposit is mainnet-only. The testnet Bridge2 deposit address is intentionally unsupported.");
  }
  const amountUsd = decimal(params, "amountUsd");
  // Validate the irreversible floor before resolving a signing key or opening
  // an RPC client. The executor repeats this invariant at its public boundary.
  parseHyperliquidBridge2DepositAmount(amountUsd);

  const wallet = await import("../../internal/wallet/resolve.js");
  let signer: ChainWallet;
  try {
    signer = wallet.resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (error) {
    return wallet.walletScopeErrorToResult(error);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const { txHash } = await executeHyperliquidBridge2Deposit(
    { network, amountUsd, owner: signer.address },
    getHyperliquidBridge2DepositClients(signer.privateKey),
  );
  return ok({
    amountUsd,
    txHash,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    token: ARBITRUM_NATIVE_USDC_ADDRESS,
    bridge: HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS,
    creditExpected: "less than 1 minute",
    verifyWith: "hyperliquid.account.overview",
    _tradeCapture: hyperliquidDepositCapture(signer.address, amountUsd, txHash),
  });
}

async function usdClassTransfer(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const { exchange } = await signingClients(context); const address = await signingAddress(context);
  const amount = decimal(params, "amount"); const toPerp = requiredBoolean(params, "toPerp");
  const result = await exchange.usdClassTransfer({ amount, toPerp });
  return exchangeResult(result, { amount, toPerp, _tradeCapture: auditCapture("account", result, address, { action: "usdClassTransfer", toPerp, amount }) });
}

async function withdraw(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const { exchange } = await signingClients(context); const address = await signingAddress(context);
  const amount = decimal(params, "amount"); const destination = addressParam(params, "destination");
  const result = await exchange.withdraw3({ destination, amount });
  return exchangeResult(result, { amount, recipient: destination, _tradeCapture: auditCapture("transfer", result, address, { action: "withdraw3", destination, amount }) });
}

async function send(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const { exchange } = await signingClients(context); const address = await signingAddress(context);
  const amount = decimal(params, "amount"); const destination = addressParam(params, "destination"); const assetType = requiredString(params, "assetType");
  const result = assetType === "usd"
    ? await exchange.usdSend({ destination, amount })
    : assetType === "spot"
      ? await exchange.spotSend({ destination, token: requiredString(params, "token"), amount })
      : (() => { throw new Error("assetType must be usd or spot"); })();
  return exchangeResult(result, { amount, recipient: destination, assetType, _tradeCapture: auditCapture("transfer", result, address, { action: `${assetType}Send`, destination, amount, ...(assetType === "spot" ? { token: requiredString(params, "token") } : {}) }) });
}

async function vaultOverview(_params: Record<string, unknown>, context: ProtocolExecutionContext) {
  return withReadAddress(context, async (address) => ok({ address, vaults: await infoClient().userVaultEquities(address) }));
}

async function vaultTransfer(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const { exchange } = await signingClients(context); const address = await signingAddress(context);
  const amount = decimal(params, "amount"); const isDeposit = requiredBoolean(params, "isDeposit"); const vaultAddress = addressParam(params, "vaultAddress");
  const result = await exchange.vaultTransfer({ vaultAddress, isDeposit, usd: usdMicros(amount) });
  return exchangeResult(result, { amount, vaultAddress, isDeposit, _tradeCapture: auditCapture("lp", result, address, { action: "vaultTransfer", vaultAddress, isDeposit, amount }) });
}

async function stakingOverview(_params: Record<string, unknown>, context: ProtocolExecutionContext) {
  return withReadAddress(context, async (address) => ok({ address, staking: await infoClient().delegatorSummary(address) }));
}

async function stakingDelegate(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const { exchange } = await signingClients(context); const address = await signingAddress(context);
  const validator = addressParam(params, "validator"); const wei = safeWireInteger(requiredString(params, "amountWei")); const isUndelegate = requiredBoolean(params, "isUndelegate");
  const result = await exchange.tokenDelegate({ validator, wei, isUndelegate });
  return exchangeResult(result, { validator, amountWei: String(wei), isUndelegate, _tradeCapture: auditCapture("stake", result, address, { action: "tokenDelegate", validator, wei: String(wei), isUndelegate }) });
}

async function stakingTransfer(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const { exchange } = await signingClients(context); const address = await signingAddress(context);
  const wei = safeWireInteger(requiredString(params, "amountWei")); const direction = requiredString(params, "direction");
  const result = direction === "deposit" ? await exchange.cDeposit({ wei }) : direction === "withdraw" ? await exchange.cWithdraw({ wei }) : (() => { throw new Error("direction must be deposit or withdraw"); })();
  return exchangeResult(result, { direction, amountWei: String(wei), _tradeCapture: auditCapture("stake", result, address, { action: `c${direction}`, wei: String(wei) }) });
}

async function claimRewards(_params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const { exchange } = await signingClients(context); const address = await signingAddress(context);
  const result = await exchange.claimRewards();
  return exchangeResult(result, { _tradeCapture: auditCapture("reward", result, address, { action: "claimRewards" }) });
}


