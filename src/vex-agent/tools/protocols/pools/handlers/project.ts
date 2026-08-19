/**
 * The shared `/discover` row projection, plus own-launch marking.
 *
 * Three handlers (`pools.tokens`, `pools.search`, `pools.my_launches`) return
 * the same row, so the projection lives once - the trench lesson that two
 * discovery handlers with their own projector also share their defects.
 *
 * WHAT IS DELIBERATELY NOT EMITTED:
 * - `decimals` and `totalSupply`. pools.fun rows send both as null and sushi
 *   rows send real values; rather than teach the agent to reason about that
 *   split, decimals are read on-chain by `pools.token` where they matter, and
 *   the supply is a protocol constant (one billion) stated in prose.
 * - `chain`. It is pinned to Robinhood for the whole namespace and is echoed
 *   once in the envelope instead of on every row.
 *
 * `poolId` becomes `pool` because on both launchers the value IS the SushiSwap
 * V3 pool address, verified against `PartyLocker.getPoolInfo`.
 */

import type { PoolsToken } from "@tools/pools-fun/types.js";
import { resolveSelectedAddressForRead } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../types.js";

const MS_PER_HOUR = 3_600_000;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Read an address-valued param, rejecting a non-address LOCALLY.
 *
 * Local rather than "let the provider decide": this provider answers a bad
 * `deployer` with HTTP 200 and an empty result set, which is indistinguishable
 * from "that wallet has launched nothing". A typo would therefore come back as
 * a confident, wrong fact about someone's launch history. Checking the shape
 * here turns it into a named rejection the agent can fix.
 */
export function readAddressParam(
  params: Record<string, unknown>,
  key: string,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, reason: `"${key}" must be a wallet address string, not ${typeof raw}.` };
  }
  const trimmed = raw.trim();
  if (!EVM_ADDRESS.test(trimmed)) {
    return {
      ok: false,
      reason:
        `"${key}" must be an EVM address (0x followed by 40 hex characters), received "${trimmed}". `
        + "An unrecognised value here comes back from the launchpad as zero rows, which is "
        + "indistinguishable from a wallet that has launched nothing.",
    };
  }
  return { ok: true, value: trimmed };
}

/** Whether a string is a well-formed EVM contract address. */
export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value);
}

export interface PoolsTokenRow {
  token: string;
  name: string | null;
  symbol: string | null;
  platform: string;
  pool: string;
  pairedAsset: string;
  /** Present only when the paired asset is a tokenised stock. */
  pairedStock?: { address: string; symbol: string };
  priceUsd: number | null;
  priceEth: number | null;
  marketCapUsd: number | null;
  vol: { m1: number | null; m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txCount24h: number | null;
  priceChange: { m1: number | null; m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  deployedAt: string;
  lastTradeAt: string | null;
  /** Hours since launch, rounded to one decimal. Derived from `deployedAt`. */
  ageHours: number;
  deployer: string | null;
  deployerX: string | null;
  feeRecipient: string | null;
  feeRecipientX: string | null;
  image: string | null;
  website: string | null;
  tweet: string | null;
  /**
   * Whether the session's own wallet deployed this token. Tri-state: `true` the
   * deployer IS the session wallet, `false` the deployer is a known DIFFERENT
   * address, ABSENT when the launchpad reported no deployer or the wallet could
   * not be resolved. "Could not tell" is never encoded as `false`.
   */
  isOwnLaunch?: boolean;
}

export function projectToken(row: PoolsToken, now: number): PoolsTokenRow {
  const launchedAtMs = Date.parse(row.deployedAt);
  return {
    token: row.tokenAddress,
    name: row.name,
    symbol: row.symbol,
    platform: row.platform,
    pool: row.poolId,
    pairedAsset: row.pairedAsset,
    ...(row.pairedStock ? { pairedStock: row.pairedStock } : {}),
    priceUsd: row.lastPriceUsd,
    priceEth: row.lastPriceEth,
    marketCapUsd: row.marketCapUsd,
    vol: { m1: row.vol1m, m5: row.vol5m, h1: row.vol1h, h6: row.vol6h, h24: row.vol24h },
    txCount24h: row.txCount24h,
    priceChange: {
      m1: row.priceChange1m,
      m5: row.priceChange5m,
      h1: row.priceChange1h,
      h6: row.priceChange6h,
      h24: row.priceChange24h,
    },
    deployedAt: row.deployedAt,
    lastTradeAt: row.lastTradeAt,
    ageHours: Math.round(((now - launchedAtMs) / MS_PER_HOUR) * 10) / 10,
    deployer: row.deployerAddress,
    deployerX: row.deployerXUsername,
    feeRecipient: row.feeRecipientAddress,
    feeRecipientX: row.feeRecipientXUsername,
    image: row.imageUri,
    website: row.websiteUrl,
    tweet: row.tweetUrl,
  };
}

/**
 * The session's EVM address, lowercased, or `null` when it cannot be
 * established. Discovery is a read-only browsing surface, so it must NEVER fail
 * because of wallet state: an absent wallet and a drifted scope both degrade to
 * `null` (no flags, list unchanged). The strict resolvers keep failing closed
 * for every money path.
 */
export function resolveOwnDeployer(context: ProtocolExecutionContext): string | null {
  try {
    return resolveSelectedAddressForRead(
      context.walletResolution ?? { source: "default" },
      context.walletPolicy ?? { kind: "none" },
      "eip155",
    ).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Post-projection enrichment. Rows are never added, removed, or reordered, and
 * a row whose deployer the provider did not report keeps the field ABSENT.
 */
export function applyOwnLaunchFlag(
  rows: readonly PoolsTokenRow[],
  ownDeployer: string | null,
): PoolsTokenRow[] {
  if (ownDeployer === null) return [...rows];
  return rows.map((row) =>
    row.deployer === null ? row : { ...row, isOwnLaunch: row.deployer.toLowerCase() === ownDeployer },
  );
}
