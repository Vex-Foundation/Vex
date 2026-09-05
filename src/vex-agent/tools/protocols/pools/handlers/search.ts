/**
 * `pools.search` handler - name/symbol lookup over `/discover?q=` (READ-ONLY).
 *
 * Defaults to `platform: "all"` rather than `poolsfun`, because a user naming a
 * token does not know which of the two launchers on this chain made it, and a
 * lookup that quietly excludes half the market is worse than one that returns a
 * row the user then has to disambiguate.
 *
 * Symbols are NOT unique here (three live SUSHICATs when this was measured), so
 * the reply says so whenever more than one row came back.
 */

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import type { PoolsPlatform } from "@tools/pools-fun/constants.js";
import { POOLS_CHAIN_SLUG, POOLS_DISCOVER_LIMIT_CAP, POOLS_PLATFORMS } from "@tools/pools-fun/constants.js";
import { ok, fail } from "../../handler-helpers.js";
import { readBoolean, readEnum, readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import { poolsFailureDetail } from "./failure.js";
import { applyOwnLaunchFlag, projectToken, resolveOwnDeployer } from "./project.js";
import { MAX_QUERY_LENGTH, readCursor } from "./list.js";
import type { ProtocolExecutionContext } from "../../types.js";

const SEARCH_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: POOLS_DISCOVER_LIMIT_CAP },
};

const DEFAULT_LIMIT = 10;

export async function poolsSearchHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const query = typeof p.query === "string" ? p.query.trim() : "";
  if (!query) return fail("Missing required: query (a token name or symbol fragment).");
  if (query.length > MAX_QUERY_LENGTH) {
    return fail(`"query" must be at most ${MAX_QUERY_LENGTH} characters, received ${query.length}.`);
  }

  const platformRead = readEnum<PoolsPlatform>(p, "platform", POOLS_PLATFORMS, "all");
  if (!platformRead.ok) return fail(platformRead.reason);
  const limitRead = readNumber(p, "limit", SEARCH_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  // Same opt-in switches as `pools.tokens`: the provider takes only the literal
  // "true" and 400s on `false`, so `false` means "filter off" and the key is
  // never sent. A name lookup narrowed to attested or fees-to-holders tokens is
  // how an agent confirms which of several same-symbol tokens it means.
  const vexAttestedRead = readBoolean(p, "vexAttested");
  if (!vexAttestedRead.ok) return fail(vexAttestedRead.reason);
  const holderRewardsRead = readBoolean(p, "holderRewards");
  if (!holderRewardsRead.ok) return fail(holderRewardsRead.reason);
  const cursor = readCursor(p);

  try {
    const page = await getPoolsFunClient().discover(
      {
        platform: platformRead.value,
        query,
        limit: limitRead.value ?? DEFAULT_LIMIT,
        ...(cursor !== null ? { cursor } : {}),
        ...(vexAttestedRead.value ? { vexAttested: true } : {}),
        ...(holderRewardsRead.value ? { holderRewards: true } : {}),
      },
      { signal: context.abortSignal },
    );
    const now = Date.now();
    const rows = applyOwnLaunchFlag(
      page.results.map((row) => projectToken(row, now)),
      resolveOwnDeployer(context),
    );

    return ok({
      chain: POOLS_CHAIN_SLUG,
      platform: platformRead.value,
      query,
      // Echoed so a narrowed search's emptiness is attributable to the filter
      // rather than to the name.
      ...(vexAttestedRead.value ? { vexAttested: true } : {}),
      ...(holderRewardsRead.value ? { holderRewards: true } : {}),
      count: rows.length,
      // The provider returns a cursor even for a one-row name search, and this
      // tool declares `cursor`, so the token is spendable rather than decorative.
      nextCursor: page.nextCursor,
      // Said in the payload, not only in the manifest prose: the agent reads
      // this reply, and a list of same-symbol rows is the moment it matters.
      ...(rows.length > 1
        ? {
          note: "More than one token matched. Symbols and names are NOT unique on pools.fun - "
              + "confirm which token the user means by its ADDRESS before acting.",
        }
        : {}),
      tokens: rows,
    });
  } catch (err) {
    return fail(`pools.fun search unavailable (${poolsFailureDetail("pools__tokens_search", err)})`);
  }
}
