/**
 * Khalani bridge USD resolution at record time (Phase-2 W3a, dossier §3).
 *
 * Khalani serves ZERO USD in quotes and orders (live-verified). To stamp a USD
 * estimate on a recorded bridge, we resolve it ourselves from the ONLY Khalani
 * surface that carries it - `GET /v1/tokens` `extensions.price.usd` - at the
 * moment we record, then multiply by the human token amount. Every lookup is
 * fail-soft: a miss yields `null` USD (a NAMED, accepted degradation - never a
 * fabricated figure) and the caller records the token amounts only.
 *
 * The `usd_source` marker (`KHALANI_TOKEN_PRICE_USD_SOURCE`) makes the provenance
 * explicit on the row: this is a self-resolved token-price estimate, not a
 * provider-quoted USD value.
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import { formatRawAmount } from "@vex-agent/tools/protocols/amount-display.js";
import type { KhalaniToken } from "@tools/khalani/types.js";
import {
  isVerifiedEvmBridgeAssetIdentity,
  type BridgeAssetIdentity,
} from "@vex-agent/tools/protocols/bridge-token-identity.js";

export const KHALANI_TOKEN_PRICE_USD_SOURCE = "khalani_token_price";

/** Resolved token facts for one side of a bridge - any field may be absent. */
export interface KhalaniTokenInfo {
  readonly symbol?: string;
  readonly decimals?: number;
  readonly priceUsd?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractPriceUsd(token: KhalaniToken): string | undefined {
  const ext: unknown = token.extensions;
  if (typeof ext !== "object" || ext === null) return undefined;
  const price = (ext as { price?: unknown }).price;
  if (typeof price !== "object" || price === null) return undefined;
  return readString((price as { usd?: unknown }).usd);
}

/**
 * Resolve a token's symbol/decimals/USD price on a specific chain via Khalani's
 * token search. Fail-soft: any transport/parse failure OR a no-match resolves to
 * `null` (the caller records amounts without USD). The error is routed through
 * the canonical scrubber before it reaches any log.
 */
export async function resolveKhalaniTokenInfo(
  tokenAddress: string,
  chainId: number,
): Promise<KhalaniTokenInfo | null> {
  try {
    const result = await getKhalaniClient().searchTokens(tokenAddress, [chainId]);
    const wanted = tokenAddress.trim().toLowerCase();
    const match = result.data.find(
      (token) => token.chainId === chainId && token.address.trim().toLowerCase() === wanted,
    ) ?? result.data.find((token) => token.address.trim().toLowerCase() === wanted);
    if (!match) return null;
    return {
      symbol: readString(match.symbol),
      decimals: typeof match.decimals === "number" ? match.decimals : undefined,
      priceUsd: extractPriceUsd(match),
    };
  } catch (err) {
    logger.warn("khalani.bridge.usd_lookup_failed", {
      chainId,
      error: summarizeProtocolError(err).message,
    });
    return null;
  }
}

/**
 * Bridge money-path metadata. Price remains a fail-soft provider estimate, but
 * every EVM symbol/decimals pair is replaced by a direct chain read. Solana
 * keeps the existing registry path because an EVM contract read is not
 * applicable to a mint.
 */
export async function resolveKhalaniBridgeTokenInfo(
  tokenAddress: string,
  chainId: number,
  identity?: BridgeAssetIdentity,
  dependencies: {
    readonly resolveProvider?: typeof resolveKhalaniTokenInfo;
  } = {},
): Promise<KhalaniTokenInfo | null> {
  const provider = await (dependencies.resolveProvider ?? resolveKhalaniTokenInfo)(tokenAddress, chainId);
  if (!isVerifiedEvmBridgeAssetIdentity(identity)) return provider;
  return {
    symbol: identity.symbol,
    decimals: identity.decimals,
    ...(provider?.priceUsd === undefined ? {} : { priceUsd: provider.priceUsd }),
  };
}

/**
 * USD estimate = human amount × token price. Returns `undefined` (never a
 * fabricated value) when either input is missing or the product is not finite.
 * Trimmed to a compact decimal string suitable for the numeric `usd_*_est`
 * columns.
 */
export function estimateUsd(humanAmount: string | undefined, priceUsd: string | undefined): string | undefined {
  if (!humanAmount || !priceUsd) return undefined;
  const amount = Number(humanAmount);
  const price = Number(priceUsd);
  if (!Number.isFinite(amount) || !Number.isFinite(price)) return undefined;
  const usd = amount * price;
  if (!Number.isFinite(usd)) return undefined;
  // Compact fixed-point (numeric column), trimming trailing zeros.
  return usd.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/**
 * Human-format a smallest-unit amount when decimals are known; otherwise
 * `undefined` (the raw amount is still recorded, the human amount stays NULL).
 * The conversion is owned by `protocols/amount-display.ts`; this keeps
 * Khalani's `undefined` degradation, which its optional-column writes need.
 */
export function humanizeAmount(rawAmount: string | undefined, decimals: number | undefined): string | undefined {
  if (!rawAmount || decimals === undefined) return undefined;
  return formatRawAmount(rawAmount, decimals) ?? undefined;
}
