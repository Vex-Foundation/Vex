/**
 * The shared `/discover` row projection, plus own-launch marking.
 *
 * Three handlers (`pools.tokens`, `pools.search`, `pools.my_launches`) return
 * the same row, so the projection lives once - the lesson that two
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
 *
 * WHAT THE FIVE NEWEST FIELDS ARE, AND ARE NOT (REPORT.md section 3): every one
 * of `vexAttested`, `holderRewardsMode`, `holderRewardsDistributor`,
 * `poolsFunBrand` and `pairedStockIlliquid` is the LAUNCHPAD's claim about its
 * own index. They are projected because they are what a screener screens on,
 * and each carries its authority in the tool description rather than in a
 * silently-trusted value: the holder-rewards pair is proven on-chain by
 * `pools__holder_rewards_get`, and `pairedStockIlliquid` has no launch-time
 * authority at all (plan v3 section 9).
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
  /**
   * The launchpad's own claim that this token carries a Vex attestation.
   * PRESENT ONLY WHEN THE LAUNCHPAD SAYS SO - absent means it makes no claim,
   * never that it denies one, because the wire has no `false` value for this.
   */
  vexAttested?: true;
  /**
   * Which fee legs this token streams to its holders, as the launchpad labels
   * it: `token`, `paired` or `both`. Present only on opted-in tokens.
   *
   * THE LAUNCHPAD'S CLAIM. The mode's authority is the `DistributorDeployed`
   * event of the suite's HolderRewardsDeployer, which `pools__holder_rewards_get`
   * reads; this row field is the echo you screen a list with.
   */
  holderRewardsMode?: string;
  /** The distributor contract the launchpad names. Same echo caveat as the mode. */
  holderRewardsDistributor?: string;
  /**
   * The launchpad's brand warning, present only on rows it flags. The pools.fun
   * app renders `status: "unofficial"` as a "Not official" badge: it is a
   * BRAND-COLLISION warning about the token's name, not a contract property.
   */
  poolsFunBrand?: { status: string; revision: number | null };
  /**
   * The launchpad's flag that the tokenised stock this token is paired against
   * is illiquid. DISPLAY ONLY and present only when flagged; a launch cannot be
   * decided on its absence, because a pair that was never listed has no
   * liquidity history to be flagged from.
   */
  pairedStockIlliquid?: true;
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
    // ── The five 2026-09-04 fields, EMITTED ONLY WHEN THE WIRE CARRIED THEM ──
    //
    // Absence is the provider's own encoding here: it sends `vexAttested` and
    // `pairedStockIlliquid` only when true, and the holder-rewards pair only on
    // opted-in tokens. Emitting `false`/`null` instead would convert "the
    // launchpad says nothing" into "the launchpad says no" on 96 rows out of
    // 100, which is the tri-state mistake `isOwnLaunch` already exists to avoid.
    ...(row.vexAttested === true ? { vexAttested: true as const } : {}),
    ...(row.holderRewardsMode !== null ? { holderRewardsMode: row.holderRewardsMode } : {}),
    ...(row.holderRewardsDistributor !== null
      ? { holderRewardsDistributor: row.holderRewardsDistributor }
      : {}),
    ...(row.poolsFunBrand !== null ? { poolsFunBrand: row.poolsFunBrand } : {}),
    ...(row.pairedStockIlliquid === true ? { pairedStockIlliquid: true as const } : {}),
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
