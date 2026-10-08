import { LIGHTER_ORDER_PREVIEW_FRESHNESS_MS } from "@tools/lighter/order-preview.js";
import type {
  LighterAccountLimitsResponse,
  LighterAccountResponse,
  LighterEnvironment,
  LighterMarketType,
  LighterOrderBookOrdersResponse,
  LighterSimpleOrder,
  LighterSystemConfigResponse,
} from "@tools/lighter/types.js";

/**
 * SWITCH `LIGHTER_DESK_PREWARM` (deps override `deskPrewarm`, see
 * `preview-snapshot.ts`).
 *
 * ON lets a DESK order preview take three inputs from data Vex already holds,
 * instead of reading them at the click, each only while younger than its
 * named max age:
 *
 * - the fee check's system config and collector account, recorded only after
 *   a desk preview's own fee check passed on them
 *   ({@link LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS});
 * - the account limits (fee tier), recorded from the desk account panel's own
 *   periodic read and from a desk preview's own read
 *   ({@link LIGHTER_DESK_PREWARM_ACCOUNT_LIMITS_MAX_AGE_MS});
 * - the margin-fit book depth, from the main-process public order book stream
 *   for that market ({@link LIGHTER_DESK_PREWARM_BOOK_MAX_AGE_MS}).
 * Desk close and OCO preparation also reuse the fee config and account tier
 * under `LIGHTER_DESK_PREPARATION_FEE_SNAPSHOT`. Their own account/position
 * stays fresh, and neither preparation reuses the ownership or book cache.
 *
 * Nothing here reads REST, runs a timer or touches a secret: the cache only
 * keeps answers that reads which already happen produced, so the desk adds no
 * REST call to Lighter's 60 per minute budget. The account, the preview book,
 * the market details and the account ownership are still read fresh at the
 * click, and the read-only account auth is still minted per prepare (with a
 * null or failed auth refusing exactly as before any cached tier is used).
 * Anything missing, older than its max age, or not plainly well formed falls
 * back to the preparation's provider reads. The post-approval
 * revalidation never consults this cache: it re-reads Lighter before any
 * signing. OFF records nothing and consults nothing.
 */
export const LIGHTER_DESK_PREWARM = true;

/**
 * System config and collector account: they change only when Lighter or Vex
 * changes fee terms. Equal to the preview's own freshness window, so no value
 * used here is older than an approval card is allowed to be.
 */
export const LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS = LIGHTER_ORDER_PREVIEW_FRESHNESS_MS;

/**
 * The account's fee tier. Short: the desk account panel re-reads it every
 * 15 seconds while the desk is visible, so a visible desk keeps it warm and a
 * closed one lets it lapse.
 */
export const LIGHTER_DESK_PREWARM_ACCOUNT_LIMITS_MAX_AGE_MS = 20_000;

/** A stream book whose last applied frame is older than this is not used (as K-3's revalidation). */
export const LIGHTER_DESK_PREWARM_BOOK_MAX_AGE_MS = 1_500;

/** Levels per side handed to the margin-fit check, at least the REST read's depth. */
export const LIGHTER_DESK_PREWARM_BOOK_LEVELS = 50;

/**
 * SWITCH `LIGHTER_DESK_PREWARM_OWNERSHIP` (deps override `deskPrewarmOwnership`,
 * see `preview-snapshot.ts`; it only applies while `LIGHTER_DESK_PREWARM` is
 * ON).
 *
 * ON lets a DESK order preview take the session wallet's Lighter master
 * account (the `readUniqueLighterMasterAccount` round) from the desk
 * pre-warm, while younger than {@link LIGHTER_DESK_PREWARM_OWNERSHIP_MAX_AGE_MS}.
 * The pre-warm keeps only answers that ownership reads which already happen
 * produced: the desk account panel's own 15 s session-account read and a desk
 * preview's own ownership read, so it adds no REST call.
 *
 * Three guards keep a stale entry from mattering. The session wallet itself
 * is still resolved fresh on every preview, so a deselected, removed or
 * drifted wallet refuses exactly as before. The preview checks the cached
 * account against its own fresh account read (owner is this wallet, and a
 * master account when Lighter says), and on any mismatch, or if that first
 * batch fails, it drops the entry and prepares again with a fresh ownership
 * read, so the outcome is today's. And before signing,
 * `LIGHTER_SIGNING_OWNERSHIP_RECHECK` re-proves ownership from a fresh read.
 * OFF records nothing and consults nothing.
 */
export const LIGHTER_DESK_PREWARM_OWNERSHIP = true;

/**
 * The session wallet's master account. Short, as the account limits: the desk
 * account panel re-proves ownership every 15 seconds while the desk is
 * visible, so a visible desk keeps it warm and a closed one lets it lapse.
 */
export const LIGHTER_DESK_PREWARM_OWNERSHIP_MAX_AGE_MS = 20_000;

interface FeeConfigEntry {
  readonly collectorAccountIndex: number;
  readonly systemConfig: LighterSystemConfigResponse;
  readonly collectorAccount: LighterAccountResponse;
  readonly atMs: number;
}

interface AccountLimitsEntry {
  readonly response: LighterAccountLimitsResponse;
  readonly atMs: number;
}

const feeConfigByEnvironment = new Map<LighterEnvironment, FeeConfigEntry>();
const accountLimitsByAccount = new Map<string, AccountLimitsEntry>();
const ownershipByWallet = new Map<string, { readonly accountIndex: number; readonly atMs: number }>();

const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function walletKey(environment: LighterEnvironment, walletAddress: string): string | null {
  const address = walletAddress.trim();
  return WALLET_ADDRESS.test(address) ? `${environment}:${address.toLowerCase()}` : null;
}

function accountKey(environment: LighterEnvironment, accountIndex: number): string {
  return `${environment}:${accountIndex}`;
}

/** A private copy, so no caller can change what a later preview reads. */
function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function fresh(atMs: number, nowMs: number, maxAgeMs: number): boolean {
  const ageMs = nowMs - atMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
}

/** Record fee config a desk preview's fee check just passed on. Only well-formed answers are kept. */
export function recordLighterDeskPrewarmFeeConfig(input: {
  readonly environment: LighterEnvironment;
  readonly collectorAccountIndex: number;
  readonly systemConfig: LighterSystemConfigResponse;
  readonly collectorAccount: LighterAccountResponse;
  readonly atMs: number;
}): void {
  if (input.systemConfig.code !== 200 || input.collectorAccount.code !== 200) return;
  feeConfigByEnvironment.set(input.environment, {
    collectorAccountIndex: input.collectorAccountIndex,
    systemConfig: frozenCopy(input.systemConfig),
    collectorAccount: frozenCopy(input.collectorAccount),
    atMs: input.atMs,
  });
}

export function takeLighterDeskPrewarmFeeConfig(
  environment: LighterEnvironment,
  collectorAccountIndex: number,
  nowMs: number,
): { readonly systemConfig: LighterSystemConfigResponse; readonly collectorAccount: LighterAccountResponse } | null {
  const entry = feeConfigByEnvironment.get(environment);
  if (entry === undefined || entry.collectorAccountIndex !== collectorAccountIndex) return null;
  if (!fresh(entry.atMs, nowMs, LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS)) return null;
  return { systemConfig: entry.systemConfig, collectorAccount: entry.collectorAccount };
}

/** Record an account-limits answer read with that account's own read-only auth. */
export function recordLighterDeskPrewarmAccountLimits(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly response: LighterAccountLimitsResponse;
  readonly atMs: number;
}): void {
  if (input.response.code !== 200) return;
  accountLimitsByAccount.set(accountKey(input.environment, input.accountIndex), {
    response: frozenCopy(input.response),
    atMs: input.atMs,
  });
}

export function takeLighterDeskPrewarmAccountLimits(
  environment: LighterEnvironment,
  accountIndex: number,
  nowMs: number,
): LighterAccountLimitsResponse | null {
  const entry = accountLimitsByAccount.get(accountKey(environment, accountIndex));
  if (entry === undefined) return null;
  if (!fresh(entry.atMs, nowMs, LIGHTER_DESK_PREWARM_ACCOUNT_LIMITS_MAX_AGE_MS)) return null;
  return entry.response;
}

/** Record a wallet's master account that a fresh ownership read just proved. */
export function recordLighterDeskPrewarmOwnership(input: {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly atMs: number;
}): void {
  const key = walletKey(input.environment, input.walletAddress);
  if (key === null || !Number.isSafeInteger(input.accountIndex) || input.accountIndex <= 0) return;
  ownershipByWallet.set(key, { accountIndex: input.accountIndex, atMs: input.atMs });
}

export function takeLighterDeskPrewarmOwnership(
  environment: LighterEnvironment,
  walletAddress: string,
  nowMs: number,
): number | null {
  const key = walletKey(environment, walletAddress);
  const entry = key === null ? undefined : ownershipByWallet.get(key);
  if (entry === undefined) return null;
  if (!fresh(entry.atMs, nowMs, LIGHTER_DESK_PREWARM_OWNERSHIP_MAX_AGE_MS)) return null;
  return entry.accountIndex;
}

/** Drop one wallet's entry, when a preview found it no longer matches Lighter. */
export function forgetLighterDeskPrewarmOwnership(environment: LighterEnvironment, walletAddress: string): void {
  const key = walletKey(environment, walletAddress);
  if (key !== null) ownershipByWallet.delete(key);
}

/**
 * Drop everything. The main process calls this on every vault lock or unlock,
 * every Lighter credential save or removal, and every session wallet change.
 */
export function clearLighterDeskPrewarm(): void {
  feeConfigByEnvironment.clear();
  accountLimitsByAccount.clear();
  ownershipByWallet.clear();
}

/** One side's levels as the main-process stream holds them: price and size, both as the provider wrote them. */
export interface LighterStreamBookLevel {
  readonly price: string;
  readonly size: string;
}

/** The live book's depth for one market, best level first on each side. */
export interface LighterStreamBookDepth {
  readonly environment: LighterEnvironment;
  readonly marketId: number;
  readonly marketType: LighterMarketType;
  /** Local wall clock (ms) at which the last applied book frame arrived. */
  readonly receivedAtMs: number;
  readonly asks: readonly LighterStreamBookLevel[];
  readonly bids: readonly LighterStreamBookLevel[];
}

/**
 * Installed by the main process. Returns the single live book for that market,
 * at most `maxLevels` per side, or null; it never subscribes or waits.
 */
export type LighterStreamBookDepthReader = (
  environment: LighterEnvironment,
  marketId: number,
  maxLevels: number,
) => LighterStreamBookDepth | null;

let bookDepthReader: LighterStreamBookDepthReader | null = null;

export function configureLighterDeskPrewarmBookDepth(reader: LighterStreamBookDepthReader | null): () => void {
  bookDepthReader = reader;
  return () => {
    if (bookDepthReader === reader) bookDepthReader = null;
  };
}

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/**
 * The stream's depth in the REST `/orderBookOrders` shape the margin-fit check
 * reads (one entry per price level), or null when the stream may not stand
 * in: no reader or live book, a reader that throws, another market or type, a
 * frame older than {@link LIGHTER_DESK_PREWARM_BOOK_MAX_AGE_MS} or in the
 * future, an empty side, a malformed level, or a crossed book.
 */
export function takeLighterDeskPrewarmBookDepth(input: {
  readonly environment: LighterEnvironment;
  readonly marketId: number;
  readonly marketType: LighterMarketType;
  readonly nowMs: number;
}): LighterOrderBookOrdersResponse | null {
  if (bookDepthReader === null) return null;
  let depth: LighterStreamBookDepth | null;
  try {
    depth = bookDepthReader(input.environment, input.marketId, LIGHTER_DESK_PREWARM_BOOK_LEVELS);
  } catch {
    return null;
  }
  if (depth === null) return null;
  if (
    depth.environment !== input.environment
    || depth.marketId !== input.marketId
    || depth.marketType !== input.marketType
  ) return null;
  if (!fresh(depth.receivedAtMs, input.nowMs, LIGHTER_DESK_PREWARM_BOOK_MAX_AGE_MS)) return null;
  const asks = depth.asks.slice(0, LIGHTER_DESK_PREWARM_BOOK_LEVELS);
  const bids = depth.bids.slice(0, LIGHTER_DESK_PREWARM_BOOK_LEVELS);
  if (asks.length === 0 || bids.length === 0) return null;
  const wellFormed = (level: LighterStreamBookLevel) =>
    DECIMAL.test(level.price) && DECIMAL.test(level.size) && compareDecimals(level.size, "0") > 0;
  if (!asks.every(wellFormed) || !bids.every(wellFormed)) return null;
  if (!sortedBestFirst(asks, "ask") || !sortedBestFirst(bids, "bid")) return null;
  const bestAsk = asks[0];
  const bestBid = bids[0];
  if (bestAsk === undefined || bestBid === undefined || compareDecimals(bestBid.price, bestAsk.price) >= 0) return null;
  return {
    code: 200,
    total_asks: asks.length,
    asks: asks.map(levelOrder),
    total_bids: bids.length,
    bids: bids.map(levelOrder),
  };
}

function levelOrder(level: LighterStreamBookLevel): LighterSimpleOrder {
  return {
    order_index: 0,
    order_id: "",
    owner_account_index: 0,
    initial_base_amount: level.size,
    remaining_base_amount: level.size,
    price: level.price,
    order_expiry: 0,
    transaction_time: 0,
  };
}

function sortedBestFirst(levels: readonly LighterStreamBookLevel[], side: "ask" | "bid"): boolean {
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1];
    const current = levels[index];
    if (previous === undefined || current === undefined) return false;
    const order = compareDecimals(previous.price, current.price);
    if (side === "ask" ? order >= 0 : order <= 0) return false;
  }
  return true;
}

function compareDecimals(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const a = BigInt(`${leftWhole}${leftFraction.padEnd(scale, "0")}`);
  const b = BigInt(`${rightWhole}${rightFraction.padEnd(scale, "0")}`);
  return a === b ? 0 : a < b ? -1 : 1;
}
