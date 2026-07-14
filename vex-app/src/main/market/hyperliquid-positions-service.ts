/**
 * Main-owned Hyperliquid positions push service.
 *
 * The reconciler remains the projection authority. This service only reads its
 * typed projection, overlays a current public allMids mark for display, and
 * broadcasts renderer-safe DTOs. It never signs or writes the DB, and stays
 * silent until a session has exposure or is actively Hypervexing.
 */

import { Decimal } from "decimal.js";
import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import { z } from "zod";
import { normalizeProviderDecimal } from "@tools/hyperliquid/validation.js";
import { resolveHyperliquidNetwork } from "@tools/hyperliquid/constants.js";
import { EV } from "@shared/ipc/channels.js";
import type {
  HyperliquidAccountDto,
  HyperliquidPositionsDto,
  HyperliquidWatchlistItemDto,
} from "@shared/schemas/hyperliquid.js";
import {
  getHyperliquidPositions,
  hasHyperliquidExposure,
  listHyperliquidPositionSessionIds,
} from "../database/hyperliquid-db.js";
import { getSessionWalletScope } from "../database/sessions-db.js";
import { listHypervexingSessionIds } from "../hyperliquid/workspace-mode.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

const IDLE_INTERVAL_MS = 15_000;
const HYPERVEXING_INTERVAL_MS = 5_000;
const ACCOUNT_CACHE_MS = 5_000;
const allMidsSchema = z.record(z.string(), z.unknown());
const clearinghouseStateSchema = z.object({
  assetPositions: z.array(z.object({
    position: z.object({ unrealizedPnl: z.union([z.string(), z.number()]).optional() }).passthrough(),
  }).passthrough()).optional(),
  marginSummary: z.object({ accountValue: z.union([z.string(), z.number()]).optional() }).passthrough().optional(),
  crossMarginSummary: z.object({ accountValue: z.union([z.string(), z.number()]).optional() }).passthrough().optional(),
  withdrawable: z.union([z.string(), z.number()]).optional(),
}).passthrough();

type HyperliquidPositionsInfoClient = Pick<HyperliquidInfoClient, "allMids" | "clearinghouseState">;

export interface HyperliquidPositionsServiceDeps {
  readonly hasExposure: typeof hasHyperliquidExposure;
  readonly listSessionIds: typeof listHyperliquidPositionSessionIds;
  readonly listHypervexingSessionIds: typeof listHypervexingSessionIds;
  readonly getPositions: typeof getHyperliquidPositions;
  readonly getSessionWalletScope: typeof getSessionWalletScope;
  readonly createInfoClient: () => HyperliquidPositionsInfoClient;
  readonly publish: (snapshot: HyperliquidPositionsDto) => void;
  readonly now: () => Date;
}

function productionDeps(): HyperliquidPositionsServiceDeps {
  return {
    hasExposure: hasHyperliquidExposure,
    listSessionIds: listHyperliquidPositionSessionIds,
    listHypervexingSessionIds,
    getPositions: getHyperliquidPositions,
    getSessionWalletScope,
    createInfoClient: () => new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }),
    publish: (snapshot) => broadcastToAllWindows(EV.hyperliquid.positionsUpdate, snapshot),
    now: () => new Date(),
  };
}

function marksFrom(response: unknown): ReadonlyMap<string, string> {
  const parsed = allMidsSchema.safeParse(response);
  if (!parsed.success) return new Map();
  const marks = new Map<string, string>();
  for (const [coin, raw] of Object.entries(parsed.data)) {
    try {
      marks.set(coin, normalizeProviderDecimal(raw, `Hyperliquid mark for ${coin}`));
    } catch {
      // A malformed single market does not poison other position updates.
    }
  }
  return marks;
}

function emptyAccount(): HyperliquidAccountDto {
  return { equityUsd: null, withdrawableUsd: null, totalUnrealizedPnlUsd: null };
}

function optionalDecimal(value: unknown): string | null {
  try {
    return normalizeProviderDecimal(value, "Hyperliquid account value");
  } catch {
    return null;
  }
}

function accountFrom(response: unknown): HyperliquidAccountDto {
  const parsed = clearinghouseStateSchema.safeParse(response);
  if (!parsed.success) return emptyAccount();
  const margin = parsed.data.marginSummary ?? parsed.data.crossMarginSummary;
  const totalUnrealizedPnlUsd = parsed.data.assetPositions === undefined
    ? null
    : (() => {
      try {
        return parsed.data.assetPositions.reduce(
          (total, item) => total.plus(item.position.unrealizedPnl ?? 0),
          new Decimal(0),
        ).toFixed();
      } catch {
        return null;
      }
    })();
  return {
    equityUsd: margin?.accountValue === undefined ? null : optionalDecimal(margin.accountValue),
    withdrawableUsd: parsed.data.withdrawable === undefined ? null : optionalDecimal(parsed.data.withdrawable),
    totalUnrealizedPnlUsd,
  };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotFingerprint(snapshot: HyperliquidPositionsDto): string {
  return stableSerialize({
    positions: snapshot.positions.map(({ updatedAt: _updatedAt, ...position }) => position),
    account: snapshot.account,
    watchlist: snapshot.watchlist,
  });
}

interface AccountCacheEntry {
  readonly expiresAt: number;
  readonly value: Promise<HyperliquidAccountDto>;
}

function accountForWallet(
  info: HyperliquidPositionsInfoClient,
  walletAddress: string,
  nowMs: number,
  cache: Map<string, AccountCacheEntry>,
): Promise<HyperliquidAccountDto> {
  const cached = cache.get(walletAddress);
  if (cached !== undefined && cached.expiresAt > nowMs) return cached.value;
  const value = info.clearinghouseState(walletAddress).then(accountFrom);
  cache.set(walletAddress, { expiresAt: nowMs + ACCOUNT_CACHE_MS, value });
  void value.catch(() => {
    if (cache.get(walletAddress)?.value === value) cache.delete(walletAddress);
  });
  return value;
}

async function tick(
  deps: HyperliquidPositionsServiceDeps,
  accountCache: Map<string, AccountCacheEntry>,
  lastPublished: Map<string, string>,
): Promise<boolean> {
  const hypervexingSessionIds = deps.listHypervexingSessionIds();
  const exposedSessionIds = await deps.hasExposure() ? await deps.listSessionIds() : [];
  const sessionIds = [...new Set([...exposedSessionIds, ...hypervexingSessionIds])];
  if (sessionIds.length === 0) return hypervexingSessionIds.length > 0;
  const servedSessions = (await Promise.all(sessionIds.map(async (sessionId) => {
    const scope = await deps.getSessionWalletScope(sessionId);
    return scope.ok && scope.data.evm !== null
      ? { sessionId, walletAddress: scope.data.evm.address }
      : null;
  }))).filter((session): session is { readonly sessionId: string; readonly walletAddress: string } => session !== null);
  if (servedSessions.length === 0) return hypervexingSessionIds.length > 0;
  const info = deps.createInfoClient();
  const marks = marksFrom(await info.allMids());
  const updatedAt = deps.now().toISOString();
  for (const { sessionId, walletAddress } of servedSessions) {
    const result = await deps.getPositions(sessionId);
    if (!result.ok) continue;
    const account = await accountForWallet(info, walletAddress, deps.now().getTime(), accountCache);
    const persistedWatchlist = result.data.watchlist ?? [];
    const watchlist = persistedWatchlist.length > 0
      ? overlayWatchlistMids(persistedWatchlist, marks)
      : fallbackWatchlist(marks);
    const snapshot: HyperliquidPositionsDto = {
      ...result.data,
      account,
      updatedAt,
      // The DTO type is a mutable array (zod output); the builders return readonly.
      watchlist: [...watchlist],
      positions: result.data.positions.map((position) => ({
        ...position,
        markPx: marks.get(position.coin) ?? position.markPx,
        updatedAt,
      })),
    };
    const fingerprint = snapshotFingerprint(snapshot);
    if (lastPublished.get(sessionId) === fingerprint) continue;
    lastPublished.set(sessionId, fingerprint);
    deps.publish(snapshot);
  }
  return hypervexingSessionIds.length > 0;
}

/** Preserve reconciler-provided OI/ranking while the weight-2 poll refreshes prices. */
function overlayWatchlistMids(
  watchlist: readonly HyperliquidWatchlistItemDto[],
  marks: ReadonlyMap<string, string>,
): readonly HyperliquidWatchlistItemDto[] {
  return watchlist.map((item) => ({ ...item, midPx: marks.get(item.coin) ?? item.midPx }));
}

/**
 * Before a reconciler snapshot contains ranked OI, expose a bounded read-only
 * fallback from the already-fetched allMids payload. It intentionally omits
 * OI and 24h change rather than creating an extra market endpoint.
 */
function fallbackWatchlist(marks: ReadonlyMap<string, string>): readonly HyperliquidWatchlistItemDto[] {
  const required = ["BTC", "ETH", "SOL", "HYPE"];
  const names = [...marks.keys()].filter((coin) => !coin.startsWith("@"));
  const selected = new Set(required.filter((coin) => marks.has(coin)));
  for (const coin of names.sort()) {
    if (selected.size === 16) break;
    selected.add(coin);
  }
  return [...selected].flatMap((coin) => {
    const midPx = marks.get(coin);
    return midPx === undefined
      ? []
      : [{ coin, midPx, change24hPct: null, openInterestUsd: null }];
  });
}

/** Idempotent self-scheduling lifecycle with no orphan timer or in-flight publish. */
export function setupHyperliquidPositionsService(
  supplied: Partial<HyperliquidPositionsServiceDeps> = {},
): () => Promise<void> {
  const deps = { ...productionDeps(), ...supplied };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  const accountCache = new Map<string, AccountCacheEntry>();
  const lastPublished = new Map<string, string>();

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      inFlight = tick(deps, accountCache, lastPublished).then((hypervexing) => {
        inFlight = null;
        schedule(hypervexing ? HYPERVEXING_INTERVAL_MS : IDLE_INTERVAL_MS);
      }, (cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          log.warn("[hyperliquid-positions] tick failed", { message });
        inFlight = null;
        schedule(deps.listHypervexingSessionIds().length > 0 ? HYPERVEXING_INTERVAL_MS : IDLE_INTERVAL_MS);
      });
    }, delayMs);
  };

  schedule(0);
  return async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    await inFlight;
  };
}
