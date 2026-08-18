/**
 * Merkl read client (KEYLESS REST).
 *
 *   GET /v4/users/{address}/rewards?chainId=N   -> one wallet's rewards, one chain
 *   GET /v4/opportunities/{id}                  -> the campaign's protocol attribution
 *
 * ONE private request method does the whole shape: budget/cache -> fetch ->
 * non-ok error mapping -> readJson -> validator. Every read goes through it, so
 * none can skip the budget or the error contract.
 *
 * THREE properties of this API shaped the code and are stated here because each
 * one is a trap discovered by the 2026-08-14 live probe rather than by reading
 * documentation.
 *
 * ONE CHAIN PER REQUEST, ALWAYS. `chainId` is required (omitting it answers HTTP
 * 400) and repeating it does NOT widen the query - `?chainId=8453&chainId=1`
 * returned Base alone, with Ethereum silently absent. A multi-chain answer is
 * therefore a fan-out of single-chain reads, and a caller that assumed otherwise
 * would report "no rewards on Ethereum" for a chain that was never asked.
 *
 * UNKNOWN QUERY PARAMETERS ARE SILENTLY IGNORED. `?id=<opportunityId>` on the
 * opportunities list returned an unrelated opportunity rather than an error, so
 * there is no usable bulk-by-id fetch and attribution is one request per distinct
 * opportunity, bounded by {@link MERKL_MAX_OPPORTUNITY_LOOKUPS}. No parameter is
 * ever sent hoping it might filter.
 *
 * ATTRIBUTION IS A SECOND CALL. A reward row names a campaign and an opportunity
 * id; it does not name a protocol. `protocol.id` lives on the opportunity, and
 * an opportunity that cannot be fetched is reported as UNATTRIBUTED rather than
 * assumed to belong to Morpho.
 */

import { fetchWithTimeout, readJson } from "../../utils/http.js";
import logger from "../../utils/logger.js";
import { MerklBudget } from "./budget.js";
import {
  MERKL_API_BASE_URL,
  MERKL_TTL,
  MERKL_USER_AGENT,
} from "./constants.js";
import { mapMerklHttpError, mapMerklTransportError } from "./errors.js";
import { validateMerklOpportunity, validateMerklUserRewards } from "./validation.js";
import type { MerklOpportunity, MerklUserRewards } from "./types.js";

/** Parse `Retry-After` (delta-seconds or HTTP-date) into whole seconds. */
function parseRetryAfterSeconds(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.floor((date - Date.now()) / 1_000));
  return undefined;
}

export class MerklClient {
  constructor(
    private readonly baseUrl: string = MERKL_API_BASE_URL,
    /** Injectable so tests drive budget arithmetic without timers. */
    private readonly budget: MerklBudget = new MerklBudget(),
  ) {}

  private async request<T>(
    path: string,
    operation: string,
    ttlMs: number,
    validator: (raw: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await this.budget.run(`${operation}:${path}`, ttlMs, async () => {
        const response = await fetchWithTimeout(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": MERKL_USER_AGENT,
          },
          ...(signal ? { signal } : {}),
        });

        const body = await readJson(response);

        if (!response.ok) {
          const retryAfter = parseRetryAfterSeconds(response.headers?.get?.("retry-after"));
          logger.warn("merkl.http_error", {
            status: response.status,
            operation,
            retryAfterSeconds: retryAfter ?? null,
          });
          // The BODY travels with the status: Merkl's problem+json names the
          // offending field, and a bare status names nothing.
          throw mapMerklHttpError(response.status, body, retryAfter);
        }

        return validator(body);
      });
    } catch (err) {
      mapMerklTransportError(err);
    }
  }

  /**
   * Every reward Merkl holds for one wallet on ONE chain, across every protocol
   * it distributes for. Attribution to Morpho is applied by the caller from
   * {@link getOpportunity}; this method deliberately does not filter, because a
   * reward whose opportunity cannot be resolved must still be reported.
   */
  async getUserRewards(walletAddress: string, chainId: number, signal?: AbortSignal): Promise<MerklUserRewards> {
    const path = `/v4/users/${walletAddress}/rewards?chainId=${chainId}`;
    return this.request(
      path,
      "userRewards",
      MERKL_TTL.userRewards,
      (raw) => validateMerklUserRewards(raw, chainId),
      signal,
    );
  }

  /** One opportunity's identity and protocol attribution. */
  async getOpportunity(opportunityId: string, signal?: AbortSignal): Promise<MerklOpportunity> {
    const path = `/v4/opportunities/${encodeURIComponent(opportunityId)}`;
    return this.request(path, "opportunity", MERKL_TTL.opportunity, validateMerklOpportunity, signal);
  }
}

let shared: MerklClient | null = null;

/** Process-wide client, so the budget and cache are shared across tool calls. */
export function getMerklClient(): MerklClient {
  shared ??= new MerklClient();
  return shared;
}
