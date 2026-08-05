/**
 * Pendle response validators (TOLERANT — hosted API, treat every field as
 * untrusted). Built from the LIVE-probed shapes (markets/active, assets/all,
 * dashboard positions, POST convert). A zod envelope narrows the wrapper, then
 * pure defensive readers normalize ONLY the fields the tools consume: missing /
 * wrong-typed fields become `null` (never a throw), and a non-object / non-array
 * root degrades to "no data".
 *
 * Free-text (symbols, names) is carried through RAW here — the protocol
 * trusted-fields boundary bounds + sanitizes it before the model sees it. The
 * `chainId-address` id form (e.g. "1-0x…") is split so callers see bare `0x…`.
 */

import { z } from "zod";
import { isRecord } from "../../utils/validation-helpers.js";
import { pendleInvalidResponse } from "./errors.js";
import type {
  PendleAsset,
  PendleClaimResponse,
  PendleConvertResponse,
  PendleConvertRoute,
  PendleMarket,
  PendleMarketPosition,
  PendlePositionLeg,
  PendleTokenAmount,
  PendleUserPositions,
} from "./types.js";

// ── Field readers (defensive, null-normalizing) ────────────────────

function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readBool(v: unknown): boolean {
  return v === true;
}

/** Split a `chainId-address` id (e.g. "1-0x…") to the bare address; else null. */
export function stripChainPrefix(v: unknown): string | null {
  const s = readString(v);
  if (!s) return null;
  const idx = s.indexOf("-");
  const addr = idx >= 0 ? s.slice(idx + 1) : s;
  return addr.length > 0 ? addr : null;
}

/** Read the numeric chain id from a `chainId-address` id (e.g. "1-0x…"); else null. */
export function chainIdFromId(v: unknown): number | null {
  const s = readString(v);
  if (!s) return null;
  const idx = s.indexOf("-");
  if (idx <= 0) return null;
  const n = Number(s.slice(0, idx));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── markets/active ─────────────────────────────────────────────────

/**
 * Category labels. NOT truncated (W9d) — the same list the read lane matches
 * `categories` / `excludeCategories` against, where a hidden cap let an
 * explicitly excluded market through. Narrowed to a bounded token vocabulary
 * downstream (`trusted-fields.ts` `trustedCategoryId`).
 */
function readCategoryIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string" && c.length > 0);
}

function normalizeMarket(raw: unknown): PendleMarket | null {
  if (!isRecord(raw)) return null;
  // Normalize like the PT/YT/SY legs: some payloads carry `{chainId}-{address}`
  // composite ids — a prefixed market address would silently break the market
  // lookups / LP anchors that compare bare lowercase addresses (Codex hardening).
  const address = stripChainPrefix(raw.address);
  if (!address) return null;
  const details = isRecord(raw.details) ? raw.details : {};
  return {
    address,
    name: readString(raw.name),
    expiry: readString(raw.expiry),
    pt: stripChainPrefix(raw.pt),
    yt: stripChainPrefix(raw.yt),
    sy: stripChainPrefix(raw.sy),
    underlyingAsset: stripChainPrefix(raw.underlyingAsset),
    details: {
      liquidity: readNumber(details.liquidity),
      impliedApy: readNumber(details.impliedApy),
      pendleApy: readNumber(details.pendleApy),
      aggregatedApy: readNumber(details.aggregatedApy),
      maxBoostedApy: readNumber(details.maxBoostedApy),
      feeRate: readNumber(details.feeRate),
    },
    categoryIds: readCategoryIds(raw.categoryIds),
    isNew: readBool(raw.isNew),
    isPrime: readBool(raw.isPrime),
  };
}

const marketsEnvelope = z.object({ markets: z.unknown() }).passthrough();

/** `GET /v1/{chainId}/markets/active` → active markets. Non-`{markets:array}` → []. */
export function validateMarkets(raw: unknown): PendleMarket[] {
  const env = marketsEnvelope.safeParse(raw);
  if (!env.success || !Array.isArray(env.data.markets)) return [];
  return env.data.markets
    .map(normalizeMarket)
    .filter((m): m is PendleMarket => m !== null);
}

// ── assets/all ─────────────────────────────────────────────────────

function normalizeAsset(raw: unknown): PendleAsset | null {
  if (!isRecord(raw)) return null;
  // assets/all carries a bare `address` field AND an `id` ("1-0x…"); prefer the
  // bare address, fall back to the split id.
  const address = readString(raw.address) ?? stripChainPrefix(raw.id);
  if (!address) return null;
  const price = isRecord(raw.price) ? raw.price : {};
  return {
    address,
    chainId: readNumber(raw.chainId) ?? chainIdFromId(raw.id),
    symbol: readString(raw.symbol),
    decimals: readNumber(raw.decimals),
    expiry: readString(raw.expiry),
    baseType: readString(raw.baseType),
    priceUsd: readNumber(price.usd),
    priceAcc: readNumber(price.acc),
    priceUpdatedAt: readString(raw.priceUpdatedAt),
  };
}

/**
 * `GET /v1/{chainId}/assets/all` → one chain's asset metadata + prices.
 *
 * STRICT ON SHAPE, tolerant on fields. This validator backs decimals, prices and
 * PT classification — everything downstream sizes a trade with — so a shape it
 * cannot read RAISES `PENDLE_INVALID_RESPONSE` instead of degrading to `[]`.
 * A genuinely empty catalogue (`[]`) is still a valid, determined answer.
 *
 * The endpoint is the PER-CHAIN one. The global `/v1/assets/all` root is an
 * object (`{assets:[…]}`) whose rows carry neither `price` nor `baseType`, so it
 * is rejected here by design rather than unwrapped.
 */
export function validateAssets(raw: unknown): PendleAsset[] {
  if (!Array.isArray(raw)) {
    throw pendleInvalidResponse(
      "assets",
      isRecord(raw) ? "expected a JSON array at the root, received an object" : "expected a JSON array at the root",
    );
  }
  const assets = raw.map(normalizeAsset).filter((a): a is PendleAsset => a !== null);
  // Rows arrived but not one of them carried a usable address: the row shape
  // changed under us. Reporting "no assets" here would be the same silent lie.
  if (assets.length === 0 && raw.length > 0) {
    throw pendleInvalidResponse("assets", "no row carried a readable address");
  }
  return assets;
}

// ── dashboard positions ────────────────────────────────────────────

function normalizePositionLeg(raw: unknown): PendlePositionLeg | null {
  if (!isRecord(raw)) return null;
  const balance = readString(raw.balance);
  if (!balance) return null;
  return { balance, valuationUsd: readNumber(raw.valuation) };
}

function normalizeMarketPosition(raw: unknown): PendleMarketPosition | null {
  if (!isRecord(raw)) return null;
  const marketId = readString(raw.marketId);
  if (!marketId) return null;
  return {
    marketId,
    pt: normalizePositionLeg(raw.pt),
    yt: normalizePositionLeg(raw.yt),
    lp: normalizePositionLeg(raw.lp),
  };
}

const positionsEnvelope = z.object({ positions: z.unknown() }).passthrough();

/** `GET /v1/dashboard/positions/database/{wallet}` → per-chain positions. */
export function validatePositions(raw: unknown): PendleUserPositions[] {
  const env = positionsEnvelope.safeParse(raw);
  if (!env.success || !Array.isArray(env.data.positions)) return [];
  const out: PendleUserPositions[] = [];
  for (const chainEntry of env.data.positions) {
    if (!isRecord(chainEntry)) continue;
    const chainId = readNumber(chainEntry.chainId);
    if (chainId === null) continue;
    const open = Array.isArray(chainEntry.openPositions) ? chainEntry.openPositions : [];
    out.push({
      chainId,
      openPositions: open
        .map(normalizeMarketPosition)
        .filter((p): p is PendleMarketPosition => p !== null),
    });
  }
  return out;
}

// ── convert (POST) ─────────────────────────────────────────────────

function normalizeTokenAmount(raw: unknown): PendleTokenAmount | null {
  if (!isRecord(raw)) return null;
  const token = readString(raw.token);
  const amount = readString(raw.amount);
  if (!token || !amount) return null;
  return { token, amount };
}

function normalizeRoute(raw: unknown): PendleConvertRoute | null {
  if (!isRecord(raw)) return null;
  const tx = isRecord(raw.tx) ? raw.tx : null;
  const txTo = tx ? readString(tx.to) : null;
  const txData = tx ? readString(tx.data) : null;
  if (!txTo || !txData) return null;
  const cpi = isRecord(raw.contractParamInfo) ? raw.contractParamInfo : {};
  const data = isRecord(raw.data) ? raw.data : {};
  const fee = isRecord(data.fee) ? data.fee : {};
  const outputs = Array.isArray(raw.outputs)
    ? raw.outputs.map(normalizeTokenAmount).filter((o): o is PendleTokenAmount => o !== null)
    : [];
  return {
    contractParamInfo: {
      method: readString(cpi.method),
      contractCallParams: Array.isArray(cpi.contractCallParams) ? cpi.contractCallParams : [],
    },
    tx: {
      to: txTo,
      data: txData,
      from: tx ? readString(tx.from) : null,
      // tx.value present + non-zero ONLY for native input.
      value: tx ? readString(tx.value) : null,
    },
    outputs,
    data: {
      aggregatorType: readString(data.aggregatorType),
      priceImpact: readNumber(data.priceImpact),
      feeUsd: readNumber(fee.usd),
    },
  };
}

const convertEnvelope = z
  .object({ action: z.unknown(), routes: z.unknown() })
  .passthrough();

/**
 * `POST /v3/sdk/{chainId}/convert` → multi-route plan. Returns null when the
 * body has no usable routes (the handler then surfaces a clean "no route").
 */
export function validateConvert(raw: unknown): PendleConvertResponse | null {
  const env = convertEnvelope.safeParse(raw);
  if (!env.success || !Array.isArray(env.data.routes)) return null;
  const routes = env.data.routes
    .map(normalizeRoute)
    .filter((r): r is PendleConvertRoute => r !== null);
  if (routes.length === 0) return null;
  const root = env.data as Record<string, unknown>;
  const inputs = Array.isArray(root.inputs)
    ? root.inputs.map(normalizeTokenAmount).filter((i): i is PendleTokenAmount => i !== null)
    : [];
  const requiredApprovals = Array.isArray(root.requiredApprovals)
    ? root.requiredApprovals.map(normalizeTokenAmount).filter((a): a is PendleTokenAmount => a !== null)
    : [];
  return {
    action: typeof root.action === "string" ? root.action : "",
    inputs,
    requiredApprovals,
    routes,
  };
}

// ── redeem-interests-and-rewards (income-sweep claim, FLAT response) ─────────

const claimEnvelope = z.object({ tx: z.unknown() }).passthrough();

/**
 * `GET /v1/sdk/{chainId}/redeem-interests-and-rewards` → a flat claim tx.
 * Returns null when the body carries no usable `tx.to`/`tx.data` (the handler
 * then surfaces a clean "no claim"). `tokenApprovals` is normalized to a
 * (usually empty) token-amount list; the claim binding rejects a non-empty set.
 */
export function validateClaim(raw: unknown): PendleClaimResponse | null {
  const env = claimEnvelope.safeParse(raw);
  if (!env.success || !isRecord(env.data.tx)) return null;
  const tx = env.data.tx;
  const to = readString(tx.to);
  const data = readString(tx.data);
  if (!to || !data) return null;
  const root = env.data as Record<string, unknown>;
  const tokenApprovals = Array.isArray(root.tokenApprovals)
    ? root.tokenApprovals.map(normalizeTokenAmount).filter((a): a is PendleTokenAmount => a !== null)
    : [];
  return {
    method: readString(root.method),
    tx: {
      to,
      data,
      from: readString(tx.from),
      value: readString(tx.value),
    },
    tokenApprovals,
  };
}

// ── supported-aggregators (GET /v1/sdk/{chainId}/supported-aggregators) ──────

/**
 * `GET /v1/sdk/{chainId}/supported-aggregators` → the aggregator names the chain
 * supports. TOLERANT: accepts a bare `["kyberswap", …]` array OR an object that
 * carries the list under a common key (`aggregators` / `supportedAggregators` /
 * `data`). Any other shape degrades to `[]` (the caller then falls back to
 * kyberswap). Names are lowercased + de-duped so the intersection is case-safe.
 *
 * ENTRY SHAPE: live chain 1 returns OBJECTS —
 * `{"name":"kyberswap","computingUnit":1}` — not bare strings. Reading them as
 * strings yielded an empty set, so the intersection was empty and every Pendle
 * trade on every chain fell back to kyberswap-only for an hour at a time (the
 * TTL), silently losing the routes OKX wins. Both entry forms are accepted.
 */
export function validateSupportedAggregators(raw: unknown): string[] {
  let list: unknown = raw;
  if (isRecord(raw)) {
    list = raw.aggregators ?? raw.supportedAggregators ?? raw.data ?? [];
  }
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    const name = isRecord(item) ? readString(item.name) : readString(item);
    if (name) out.add(name.toLowerCase());
  }
  return [...out];
}
