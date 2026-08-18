/**
 * Morpho GraphQL read client (KEYLESS, single endpoint).
 *
 *   POST https://api.morpho.org/graphql
 *     query VexMorphoMarkets   -> filtered/sorted Blue market discovery
 *     query VexMorphoMarket    -> one market's full state
 *     query VexMorphoVaultsV1  -> filtered/sorted MetaMorpho vault discovery
 *     query VexMorphoVaultsV2  -> filtered/sorted VaultV2 discovery
 *     query VexMorphoVaultV1   -> one MetaMorpho vault's full state
 *     query VexMorphoVaultV2   -> one VaultV2's full state
 *     query VexMorphoChains    -> liveness + chain coverage (diagnostics only)
 *
 * This file says WHAT Vex reads. HOW every read is carried - budget and cache,
 * the POST, the non-ok mapping, GraphQL's 200-with-`errors` failure mode, and
 * only then the validator - belongs to `./client/transport.ts`, and every method
 * here goes through it, so none can skip the budget or the error contract.
 *
 * TWO READS ARE NOT LIKE THE OTHERS. `getMarketCuration` and `getVaultCuration`
 * are UNCACHED and STRICTLY typed, because they are the trust root of a signing
 * decision rather than a screen. See their own comments.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { loadConfig } from "../../config/store.js";
import { MorphoBudget, MORPHO_TTL } from "./budget.js";
import type { GraphqlRequest } from "./client/envelope.js";
import { validateMorphoMarketCuration, type MorphoMarketCuration } from "./client/curation.js";
import { validateMorphoVaultCuration, type MorphoVaultCuration } from "./client/vault-curation.js";
import { runMorphoGraphqlRequest } from "./client/transport.js";
import {
  MORPHO_MARKETS_QUERY,
  MORPHO_MARKET_QUERY,
  MORPHO_MARKET_CURATION_QUERY,
  MORPHO_CHAINS_QUERY,
} from "./queries.js";
import {
  MORPHO_MARKET_POSITIONS_QUERY,
  MORPHO_VAULT_POSITIONS_QUERY,
  MORPHO_VAULT_V2_POSITION_QUERY,
  MORPHO_VAULT_V2_USER_VAULTS_QUERY,
} from "./queries-positions.js";
import { MORPHO_MARKET_TRANSACTIONS_QUERY } from "./queries-activity.js";
import {
  MORPHO_VAULTS_V1_QUERY,
  MORPHO_VAULTS_V2_QUERY,
  MORPHO_VAULT_V1_QUERY,
  MORPHO_VAULT_V2_QUERY,
  MORPHO_VAULT_V1_CURATION_QUERY,
  MORPHO_VAULT_V2_CURATION_QUERY,
} from "./queries-vaults.js";
import {
  MORPHO_ACTIVITY_SORTS,
  MORPHO_MARKET_POSITION_SORTS,
  MORPHO_MARKET_SORTS,
  MORPHO_VAULT_V1_SORTS,
  MORPHO_VAULT_V2_SORTS,
  clampActivityLimit,
  clampPageLimit,
  requireMarketId,
  requireQueryChainId,
  requireUserAddress,
  requireVaultAddress,
  type MorphoActivityQuery,
  type MorphoMarketPositionsQuery,
  type MorphoVaultPositionsQuery,
  type MorphoVaultV2PositionQuery,
  type MorphoMarketQuery,
  type MorphoMarketsQuery,
  type MorphoVaultQuery,
  type MorphoVaultsQuery,
} from "./request.js";
import {
  morphoMarketNotFound,
  validateMorphoMarketDetail,
  validateMorphoMarketPage,
} from "./validation/markets.js";
import {
  validateMorphoMarketPositionPage,
  validateMorphoVaultPositionPage,
  validateMorphoVaultV2Position,
  validateMorphoVaultV2UserVaults,
} from "./validation/positions.js";
import { validateMorphoActivityPage } from "./validation/activity.js";
import {
  morphoVaultNotFound,
  validateMorphoVaultPage,
  validateMorphoVaultV1Detail,
  validateMorphoVaultV2Detail,
} from "./validation/vaults.js";
import type {
  MorphoActivityPage,
  MorphoMarketDetail,
  MorphoMarketPage,
  MorphoMarketPositionPage,
  MorphoVaultDetail,
  MorphoVaultPage,
  MorphoVaultPosition,
  MorphoVaultPositionPage,
} from "./types.js";

export class MorphoClient {
  constructor(
    private readonly endpoint: string,
    /** Injectable so tests drive budget arithmetic and breaker behaviour without timers. */
    private readonly budget: MorphoBudget = new MorphoBudget(),
  ) {}

  /** Breaker/budget state, for diagnostics and for an honest degraded report. */
  describeBudget(): ReturnType<MorphoBudget["describeState"]> {
    return this.budget.describeState();
  }

  /** Every read below goes through `./client/transport.ts`; see its header. */
  private async request<T>(req: GraphqlRequest, validator: (raw: unknown) => T, signal?: AbortSignal): Promise<T> {
    return runMorphoGraphqlRequest(this.endpoint, this.budget, req, validator, signal);
  }

  /** One page of filtered, sorted Blue markets. */
  async getMarketPage(query: MorphoMarketsQuery, signal?: AbortSignal): Promise<MorphoMarketPage> {
    return this.request(
      {
        query: MORPHO_MARKETS_QUERY,
        operation: "markets",
        ttlMs: MORPHO_TTL.markets,
        variables: {
          first: clampPageLimit(query.first),
          skip: Math.max(0, Math.floor(query.skip)),
          orderBy: MORPHO_MARKET_SORTS[query.orderBy],
          orderDirection: query.order === "asc" ? "Asc" : "Desc",
          where: query.where,
        },
      },
      validateMorphoMarketPage,
      signal,
    );
  }

  /** One market's full state. `marketId` and `chainId` are guarded before dispatch. */
  async getMarket(query: MorphoMarketQuery, signal?: AbortSignal): Promise<MorphoMarketDetail> {
    return this.request(
      {
        query: MORPHO_MARKET_QUERY,
        operation: "marketById",
        ttlMs: MORPHO_TTL.market,
        variables: {
          marketId: requireMarketId(query.marketId),
          chainId: requireQueryChainId(query.chainId),
        },
        variant: `${query.includeHistory ? query.lookback : "no-history"}:${query.includeSupplyingVaults ? "vaults" : "no-vaults"}`,
        // Morpho answers a nonexistent market id with the SAME HTTP 200 +
        // `data: null` + `errors[NOT_FOUND]` envelope it uses for a removed
        // field (verified live). Without this hook a mistyped id was reported
        // as "Morpho rejected the GraphQL query", which sends the agent looking
        // for a schema fault it cannot fix instead of re-reading the id.
        notFound: () => morphoMarketNotFound(),
      },
      (raw) =>
        validateMorphoMarketDetail(raw, {
          includeHistory: query.includeHistory,
          lookback: query.lookback,
          includeSupplyingVaults: query.includeSupplyingVaults,
        }),
      signal,
    );
  }

  /**
   * IS MORPHO CURATING THIS MARKET, asked live at execution time.
   *
   * UNCACHED ON PURPOSE (`ttlMs: 0`). Every other read here may serve a cached
   * answer because a few seconds cannot mislead a screen. This one decides
   * whether real funds enter a permissionless lending market, and the market
   * gate's own rule is that the curation flag must be no older than the
   * decision it supports. `ttlMs: 0` also skips the cache WRITE, so this call
   * can never seed a stale answer for anything else.
   *
   * STRICTLY TYPED, unlike the `listed` that rides along on the display reads,
   * and BOUND TO THE MARKET IT IS ABOUT: a flag vouches for the market it names,
   * so an answer describing another one is refused (`./client/curation.ts`).
   * Rules/90 splits the two: a display field a provider may legitimately send
   * as null is read tolerantly, and a field a signing decision consumes is
   * read strictly. A `listed` that is absent, null, or not a boolean is a
   * refusal here, never a falsy "no" and never an optimistic "yes".
   */
  async getMarketCuration(
    query: { readonly marketId: string; readonly chainId: number },
    signal?: AbortSignal,
  ): Promise<MorphoMarketCuration> {
    return this.request(
      {
        query: MORPHO_MARKET_CURATION_QUERY,
        operation: "marketById",
        ttlMs: 0,
        variables: {
          marketId: requireMarketId(query.marketId),
          chainId: requireQueryChainId(query.chainId),
        },
        notFound: () => morphoMarketNotFound(),
      },
      (body) => {
        const curation = validateMorphoMarketCuration(body, query);
        if (curation === null) throw morphoMarketNotFound();
        return curation;
      },
      signal,
    );
  }

  /**
   * One page of filtered, sorted vaults from ONE generation.
   *
   * Deliberately per-generation rather than a single "vaults" call. `vaults` and
   * `vaultV2s` are different queries with different filter inputs and different
   * order-by enums; merging them is a decision about ranking honesty, so it
   * belongs one layer up where the merge can be described to the agent, not
   * hidden inside a client method that would silently pick a winner.
   */
  async getVaultPage<F>(
    version: "v1" | "v2",
    query: MorphoVaultsQuery<F>,
    signal?: AbortSignal,
  ): Promise<MorphoVaultPage> {
    const sorts = version === "v1" ? MORPHO_VAULT_V1_SORTS : MORPHO_VAULT_V2_SORTS;
    const orderBy = (sorts as Record<string, string>)[query.orderBy];
    if (orderBy === undefined) {
      throw new VexError(
        ErrorCodes.AGENT_VALIDATION_ERROR,
        `Morpho: vault generation ${version} cannot rank by "${query.orderBy}".`,
        `Morpho declares no such order-by member for ${version}. Choose one both generations serve, or set the `
        + "`version` this key belongs to.",
      );
    }
    return this.request(
      {
        query: version === "v1" ? MORPHO_VAULTS_V1_QUERY : MORPHO_VAULTS_V2_QUERY,
        operation: version === "v1" ? "vaults" : "vaultV2s",
        ttlMs: MORPHO_TTL.vaults,
        variables: {
          first: clampPageLimit(query.first),
          skip: Math.max(0, Math.floor(query.skip)),
          orderBy,
          orderDirection: query.order === "asc" ? "Asc" : "Desc",
          where: query.where,
        },
      },
      (raw) => validateMorphoVaultPage(raw, version),
      signal,
    );
  }

  /**
   * One vault in full, with the generation DETECTED rather than asked for.
   *
   * V2 is tried first and V1 is the fallback. The order is not arbitrary: a V2
   * address read as V1 and a V1 address read as V2 both come back `NOT_FOUND`,
   * so either order works, but V2 is the generation still being deployed and
   * therefore the likelier hit on an address an agent just discovered. A miss
   * costs one extra request against a 15-second cache, and only the SECOND
   * failure is reported - surfacing the first would tell the agent a vault does
   * not exist while we were still looking for it.
   */
  async getVault(query: MorphoVaultQuery, signal?: AbortSignal): Promise<MorphoVaultDetail> {
    const address = requireVaultAddress(query.vaultAddress);
    const chainId = requireQueryChainId(query.chainId);
    const options = { includeAllocations: query.includeAllocations };

    try {
      return await this.request(
        {
          query: MORPHO_VAULT_V2_QUERY,
          operation: "vaultV2ByAddress",
          ttlMs: MORPHO_TTL.vault,
          variables: { address, chainId },
          variant: `v2:${query.includeAllocations ? "alloc" : "no-alloc"}`,
          notFound: (cause) => morphoVaultNotFound(cause),
        },
        (raw) => validateMorphoVaultV2Detail(raw, options),
        signal,
      );
    } catch (err) {
      if (!(err instanceof VexError) || err.code !== ErrorCodes.MORPHO_VAULT_NOT_FOUND) throw err;
    }

    return this.request(
      {
        query: MORPHO_VAULT_V1_QUERY,
        operation: "vaultByAddress",
        ttlMs: MORPHO_TTL.vault,
        variables: { address, chainId },
        variant: `v1:${query.includeAllocations ? "alloc" : "no-alloc"}`,
        notFound: (cause) =>
          morphoVaultNotFound(`${cause} (checked both the V2 and the V1 vault registries on this chain)`),
      },
      (raw) => validateMorphoVaultV1Detail(raw, options),
      signal,
    );
  }

  /**
   * IS MORPHO CURATING THIS VAULT, asked live at execution time.
   *
   * UNCACHED ON PURPOSE (`ttlMs: 0`), exactly like {@link getMarketCuration} and
   * for the same reason. The vault DETAIL read that carries `listed` today is
   * served through a 15-second cache and reads the flag tolerantly, which is
   * correct for a screen and wrong for the one fact a deposit is gated on:
   * `ttlMs: 0` skips the cache READ so the answer is no older than the decision
   * it supports, and skips the cache WRITE so this call can never seed a stale
   * answer for anything else.
   *
   * GENERATION DETECTED, NOT ASKED FOR - V2 first, V1 as the fallback, the same
   * order and the same reasoning as {@link getVault}. Only the SECOND failure is
   * reported; surfacing the first would tell the caller a vault does not exist
   * while we were still looking for it.
   *
   * STRICTLY TYPED AND BOUND TO THE VAULT IT IS ABOUT
   * (`./client/vault-curation.ts`): the address and the chain must both be
   * present and match, and an absent or non-boolean `listed` is a refusal rather
   * than a falsy "no".
   */
  async getVaultCuration(
    query: { readonly vaultAddress: string; readonly chainId: number },
    signal?: AbortSignal,
  ): Promise<MorphoVaultCuration> {
    const address = requireVaultAddress(query.vaultAddress);
    const chainId = requireQueryChainId(query.chainId);
    const subject = { vaultAddress: address, chainId };

    try {
      return await this.readVaultCuration(MORPHO_VAULT_V2_CURATION_QUERY, "vaultV2ByAddress", subject, signal);
    } catch (err) {
      if (!(err instanceof VexError) || err.code !== ErrorCodes.MORPHO_VAULT_NOT_FOUND) throw err;
    }

    return this.readVaultCuration(MORPHO_VAULT_V1_CURATION_QUERY, "vaultByAddress", subject, signal);
  }

  private async readVaultCuration(
    query: string,
    operation: "vaultByAddress" | "vaultV2ByAddress",
    subject: { readonly vaultAddress: string; readonly chainId: number },
    signal?: AbortSignal,
  ): Promise<MorphoVaultCuration> {
    return this.request(
      {
        query,
        operation,
        ttlMs: 0,
        variables: { address: subject.vaultAddress, chainId: subject.chainId },
        variant: "curation",
        notFound: (cause) => morphoVaultNotFound(cause),
      },
      (body) => {
        const curation = validateMorphoVaultCuration(body, operation, subject);
        if (curation === null) throw morphoVaultNotFound("Morpho returned no vault for that address on that chain");
        return curation;
      },
      signal,
    );
  }

  // -- Positions ----------------------------------------------------

  /**
   * One page of a wallet's Blue market positions.
   *
   * The caller decides which non-empty predicate is on `where`; see
   * `MorphoMarketPositionFilters` for why leaving all of them off returns every
   * market the wallet has ever touched rather than the ones it holds.
   */
  async getMarketPositionPage(
    query: MorphoMarketPositionsQuery,
    signal?: AbortSignal,
  ): Promise<MorphoMarketPositionPage> {
    return this.request(
      {
        query: MORPHO_MARKET_POSITIONS_QUERY,
        operation: "marketPositions",
        ttlMs: MORPHO_TTL.positions,
        variables: {
          first: clampPageLimit(query.first),
          skip: Math.max(0, Math.floor(query.skip)),
          orderBy: MORPHO_MARKET_POSITION_SORTS[query.orderBy],
          orderDirection: query.order === "asc" ? "Asc" : "Desc",
          where: { ...query.where, userAddress_in: query.where.userAddress_in.map(requireUserAddress) },
        },
      },
      validateMorphoMarketPositionPage,
      signal,
    );
  }

  /** One page of a wallet's V1 (MetaMorpho) vault positions. */
  async getVaultPositionPage(
    query: MorphoVaultPositionsQuery,
    signal?: AbortSignal,
  ): Promise<MorphoVaultPositionPage> {
    return this.request(
      {
        query: MORPHO_VAULT_POSITIONS_QUERY,
        operation: "vaultPositions",
        ttlMs: MORPHO_TTL.positions,
        variables: {
          first: clampPageLimit(query.first),
          skip: Math.max(0, Math.floor(query.skip)),
          orderDirection: query.order === "asc" ? "Asc" : "Desc",
          where: { ...query.where, userAddress_in: query.where.userAddress_in.map(requireUserAddress) },
        },
      },
      validateMorphoVaultPositionPage,
      signal,
    );
  }

  /**
   * One V2 vault position, or `null` when the wallet holds nothing in it.
   *
   * `null` is an ANSWER, not an error: this read is aimed at vaults the wallet
   * once transacted with, and a fully exited position is exactly what a valid
   * query returns for one of those.
   */
  async getVaultV2Position(
    query: MorphoVaultV2PositionQuery,
    signal?: AbortSignal,
  ): Promise<MorphoVaultPosition | null> {
    return this.request(
      {
        query: MORPHO_VAULT_V2_POSITION_QUERY,
        operation: "vaultV2PositionByAddress",
        ttlMs: MORPHO_TTL.positions,
        variables: {
          userAddress: requireUserAddress(query.userAddress),
          vaultAddress: requireVaultAddress(query.vaultAddress),
          chainId: requireQueryChainId(query.chainId),
        },
        notFound: () => morphoVaultNotFound("no such VaultV2 on that chain"),
      },
      validateMorphoVaultV2Position,
      signal,
    );
  }

  /**
   * Which V2 vaults a wallet has transacted with, and how much of its history
   * that scan covered.
   *
   * The schema has no per-user V2 position list, so this is the discovery half
   * of the only honest composition available. The coverage numbers travel with
   * the result because a partial scan and a complete one are indistinguishable
   * from the vault list alone.
   */
  async getVaultV2UserVaults(
    userAddress: string,
    chainIds: readonly number[] | undefined,
    scanLimit: number,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof validateMorphoVaultV2UserVaults>> {
    return this.request(
      {
        query: MORPHO_VAULT_V2_USER_VAULTS_QUERY,
        operation: "vaultV2transactions",
        ttlMs: MORPHO_TTL.positions,
        variables: {
          first: clampActivityLimit(scanLimit),
          orderDirection: "Desc",
          where: {
            userAddress_in: [requireUserAddress(userAddress)],
            ...(chainIds !== undefined && chainIds.length > 0 ? { chainId_in: chainIds } : {}),
          },
        },
      },
      validateMorphoVaultV2UserVaults,
      signal,
    );
  }

  // -- Activity -----------------------------------------------------

  /** One page of Morpho Blue market transactions. */
  async getActivityPage(query: MorphoActivityQuery, signal?: AbortSignal): Promise<MorphoActivityPage> {
    return this.request(
      {
        query: MORPHO_MARKET_TRANSACTIONS_QUERY,
        operation: "marketTransactions",
        ttlMs: MORPHO_TTL.activity,
        variables: {
          first: clampActivityLimit(query.first),
          skip: Math.max(0, Math.floor(query.skip)),
          orderBy: MORPHO_ACTIVITY_SORTS[query.orderBy],
          orderDirection: query.order === "asc" ? "Asc" : "Desc",
          where: query.where,
        },
      },
      validateMorphoActivityPage,
      signal,
    );
  }

  /**
   * Chains Morpho serves. Diagnostics and tests only: what Vex READS is the
   * static intersection in `./chains.ts`, which is a product decision and must
   * not widen because a provider list grew.
   */
  async getChains(signal?: AbortSignal): Promise<unknown> {
    return this.request(
      { query: MORPHO_CHAINS_QUERY, operation: "chains", ttlMs: MORPHO_TTL.chains, variables: {} },
      (raw) => raw,
      signal,
    );
  }
}

// -- Singleton -------------------------------------------------------

let cachedClient: MorphoClient | null = null;
let cachedEndpoint: string | null = null;

/**
 * Process-wide client, keyed on the configured endpoint. One instance means ONE
 * budget: a second client would double our request rate against a single
 * per-IP ceiling, which is the exact over-subscription the Pendle read lane
 * documents as a known gap.
 */
export function getMorphoClient(): MorphoClient {
  const endpoint = loadConfig().services.morphoApiUrl;
  if (cachedClient && cachedEndpoint === endpoint) return cachedClient;
  cachedClient = new MorphoClient(endpoint);
  cachedEndpoint = endpoint;
  return cachedClient;
}
