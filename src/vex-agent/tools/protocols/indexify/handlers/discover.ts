/**
 * Indexify discovery handlers — browse, search, single-stack read, token
 * catalogue. All public (keyless) reads; every list is projected and capped.
 */

import { getIndexifyClient } from "@tools/indexify/client.js";
import type { IndexifyStackFeed, IndexifyStackSort } from "@tools/indexify/constants.js";
import {
  INDEXIFY_CHAIN_SLUG,
  INDEXIFY_LIST_LIMIT_CAP,
  INDEXIFY_LIST_LIMIT_DEFAULT,
  INDEXIFY_STACK_FEEDS,
  INDEXIFY_STACK_SORTS,
} from "@tools/indexify/constants.js";
import { ok, fail, num, str } from "../../handler-helpers.js";
import { readEnum, readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { indexifyFailureDetail } from "./failure.js";
import { projectStackDetail, projectStackRow } from "./project.js";

export const MAX_QUERY_LENGTH = 64;

const LIST_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: INDEXIFY_LIST_LIMIT_CAP },
  offset: { domain: "nonNegative", integer: true },
  minMarketCapUsd: { domain: "nonNegative" },
  maxMarketCapUsd: { domain: "nonNegative" },
};

export async function indexifyStacksHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const feedRead = readEnum<IndexifyStackFeed>(p, "feed", INDEXIFY_STACK_FEEDS, "all");
  if (!feedRead.ok) return fail(feedRead.reason);
  const limitRead = readNumber(p, "limit", LIST_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  const offsetRead = readNumber(p, "offset", LIST_NUMERIC_PARAMS);
  if (!offsetRead.ok) return fail(offsetRead.reason);
  const minMcapRead = readNumber(p, "minMarketCapUsd", LIST_NUMERIC_PARAMS);
  if (!minMcapRead.ok) return fail(minMcapRead.reason);
  const maxMcapRead = readNumber(p, "maxMarketCapUsd", LIST_NUMERIC_PARAMS);
  if (!maxMcapRead.ok) return fail(maxMcapRead.reason);

  // `sort`/`order` only shape the `all` feed; trending and official carry the
  // provider's own ranking, so a sort there is refused by name, not ignored.
  const sortRaw = str(p, "sort");
  const orderRaw = str(p, "order");
  if (feedRead.value !== "all" && (sortRaw || orderRaw)) {
    return fail(
      `"sort"/"order" only apply to feed "all" — the ${feedRead.value} feed carries the provider's own ranking. Drop them or switch feed.`,
    );
  }
  let sort: IndexifyStackSort | undefined;
  if (sortRaw) {
    const match = INDEXIFY_STACK_SORTS.find((candidate) => candidate.toLowerCase() === sortRaw.trim().toLowerCase());
    if (!match) return fail(`"sort" must be one of: ${INDEXIFY_STACK_SORTS.join(", ")}.`);
    sort = match;
  }
  let order: "ASC" | "DESC" | undefined;
  if (orderRaw) {
    const normalized = orderRaw.trim().toLowerCase();
    if (normalized !== "asc" && normalized !== "desc") return fail(`"order" must be asc or desc.`);
    order = normalized === "asc" ? "ASC" : "DESC";
  }

  try {
    const rows = await getIndexifyClient().listStacks(
      {
        feed: feedRead.value,
        limit: limitRead.value ?? INDEXIFY_LIST_LIMIT_DEFAULT,
        offset: offsetRead.value ?? 0,
        ...(sort !== undefined ? { sort } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(minMcapRead.value !== null ? { minMarketCapUsd: minMcapRead.value } : {}),
        ...(maxMcapRead.value !== null ? { maxMarketCapUsd: maxMcapRead.value } : {}),
      },
      { signal: context.abortSignal },
    );
    return ok({
      chain: INDEXIFY_CHAIN_SLUG,
      feed: feedRead.value,
      count: rows.length,
      stacks: rows.map(projectStackRow),
    });
  } catch (err) {
    return fail(`Indexify stacks unavailable (${indexifyFailureDetail("indexify__stacks_discover", err)})`);
  }
}

export async function indexifySearchHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const query = str(p, "query").trim();
  if (!query) return fail("Missing required: query (a stack name or name fragment).");
  if (query.length > MAX_QUERY_LENGTH) {
    return fail(`"query" must be at most ${MAX_QUERY_LENGTH} characters, received ${query.length}.`);
  }
  try {
    const rows = await getIndexifyClient().searchStacks(query, { signal: context.abortSignal });
    return ok({
      chain: INDEXIFY_CHAIN_SLUG,
      query,
      count: rows.length,
      ...(rows.length > 1
        ? {
          note: "More than one stack matched. Stack names are NOT unique on Indexify — "
              + "confirm which one the user means by its stackId or slug before acting.",
        }
        : {}),
      stacks: rows.map((row) => ({
        stackId: row.stack_id,
        slug: row.slug,
        name: row.stack_name,
        description: row.description_truncated ?? null,
      })),
    });
  } catch (err) {
    return fail(`Indexify search unavailable (${indexifyFailureDetail("indexify__stacks_search", err)})`);
  }
}

export async function indexifyStackHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  // The exclusive slug|stackId group is enforced at the boundary; here we only
  // need to read whichever arrived.
  const slug = str(p, "slug").trim();
  const stackId = num(p, "stackId");
  try {
    const client = getIndexifyClient();
    const row = await client.fetchStack(
      slug ? { slug } : { stackId: stackId as number },
      { signal: context.abortSignal },
    );
    if (row === null) {
      return fail(`Indexify knows no stack ${slug ? `with slug "${slug}"` : `with id ${stackId}`}. Confirm it via indexify__stacks_search.`);
    }
    // Investor count is a second, cheap read; a failure there must not take
    // the whole detail down.
    let investorCount: number | null = null;
    try {
      investorCount = await client.stackInvestors(row.id, { signal: context.abortSignal });
    } catch {
      investorCount = null;
    }
    return ok({
      chain: INDEXIFY_CHAIN_SLUG,
      investorCount,
      stack: projectStackDetail(row),
    });
  } catch (err) {
    return fail(`Indexify stack read unavailable (${indexifyFailureDetail("indexify__stack_get", err)})`);
  }
}

export async function indexifyTokensHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const query = str(p, "query").trim();
  if (!query) return fail("Missing required: query (a token name or symbol fragment).");
  if (query.length > MAX_QUERY_LENGTH) {
    return fail(`"query" must be at most ${MAX_QUERY_LENGTH} characters, received ${query.length}.`);
  }
  try {
    const rows = await getIndexifyClient().searchTokens(query, { signal: context.abortSignal });
    return ok({
      chain: INDEXIFY_CHAIN_SLUG,
      query,
      count: rows.length,
      tokens: rows.map((row) => ({
        symbol: row.symbol,
        name: row.name,
        mintAddress: row.address,
        isVerified: row.is_verified === true,
      })),
    });
  } catch (err) {
    return fail(`Indexify token search unavailable (${indexifyFailureDetail("indexify__tokens_search", err)})`);
  }
}
