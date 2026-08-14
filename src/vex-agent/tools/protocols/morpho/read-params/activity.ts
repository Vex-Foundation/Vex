/**
 * Input contract for `morpho.markets.activity`.
 *
 * Two guards here are worth naming, because both protect against a filter that
 * would appear to work.
 *
 * THE TYPE VOCABULARY IS CLOSED. `types` is mapped through
 * `MORPHO_ACTIVITY_TYPES`, whose keys are this tree's camelCase grammar and
 * whose values are Morpho's PascalCase enum members verbatim. A value outside
 * the table is refused by name; passing the model's spelling through would earn
 * a GraphQL validation error at best, and at worst a page nobody filtered.
 *
 * TIME IS UNIX SECONDS, NOT MILLISECONDS. The two differ by a factor of a
 * thousand and both are plausible integers, so a millisecond value silently
 * selects a window some fifty thousand years out and returns an empty history
 * that reads as "this market is dead". Values above the seconds range are
 * therefore refused by name, with the millisecond mistake named as the likely
 * cause.
 *
 * The reject-by-name discipline behind every guard used here is documented in
 * `./_primitives.ts`.
 */

import {
  MORPHO_ACTIVITY_SORT_KEYS,
  MORPHO_ACTIVITY_TYPES,
  MORPHO_ACTIVITY_TYPE_KEYS,
  MORPHO_MAX_ACTIVITY_LIMIT,
  MORPHO_ORDERS,
  type MorphoActivityFilters,
  type MorphoActivitySort,
  type MorphoOrder,
} from "@tools/morpho/request.js";
import {
  ADDRESS_PATTERN,
  MARKET_ID_PATTERN,
  MAX_CSV_ENTRIES,
  checkRange,
  readChains,
  readOptionalEnum,
  readOptionalNumber,
  readOptionalString,
  reject,
  type MorphoParams,
} from "./_primitives.js";

/**
 * A unix SECONDS timestamp this far in the future is a milliseconds value.
 *
 * The bound is the year 4000 rather than "now": a caller may legitimately ask
 * for a window ending slightly ahead of the clock, and refusing that would be
 * pedantry, while nothing legitimate reaches four digits of extra magnitude.
 */
const MAX_UNIX_SECONDS = 64_060_588_800;

export interface MorphoActivityQueryParams {
  filters: MorphoActivityFilters;
  sort: MorphoActivitySort;
  order: MorphoOrder;
  limit: number;
  offset: number;
  types: string[] | undefined;
  echo: Record<string, unknown>;
}

/** Comma-separated 64-hex market ids, lowercased. An address here is named as one. */
function readMarketIdCsv(raw: unknown, param: string): MorphoParams<string[] | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  const items = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length > MAX_CSV_ENTRIES) {
    return reject(
      param,
      `\`${param}\` accepts at most ${MAX_CSV_ENTRIES} comma-separated market ids; ${items.length} were supplied.`,
    );
  }
  const out: string[] = [];
  for (const item of items) {
    if (!MARKET_ID_PATTERN.test(item)) {
      return reject(
        param,
        `\`${param}\` contains "${item}", which is not a 0x-prefixed 64-hex market id.`
        + (ADDRESS_PATTERN.test(item) ? " That is a 20-byte contract ADDRESS, not a market id." : "")
        + " Read one from morpho.markets.discover.",
      );
    }
    const lower = item.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

/** The closed transaction-type vocabulary. Accepts a CSV string or a string array. */
function readTypes(raw: unknown, param: string): MorphoParams<string[] | undefined> {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") return reject(param, `\`${param}\` array entries must be strings.`);
      tokens.push(entry);
    }
  } else {
    const value = readOptionalString(raw);
    if (value === undefined) return { ok: true, value: undefined };
    tokens.push(...value.split(","));
  }

  const out: string[] = [];
  for (const token of tokens.map((s) => s.trim()).filter((s) => s.length > 0)) {
    const match = MORPHO_ACTIVITY_TYPE_KEYS.find((key) => key.toLowerCase() === token.toLowerCase());
    if (match === undefined) {
      return reject(
        param,
        `\`${param}\` contains "${token}", which is not a Morpho market transaction type. `
        + `Accepted: ${MORPHO_ACTIVITY_TYPE_KEYS.join(", ")}.`,
      );
    }
    if (!out.includes(match)) out.push(match);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

function readUnixSeconds(raw: unknown, param: string): MorphoParams<number | undefined> {
  const value = readOptionalNumber(raw, param, { min: 0, integer: true });
  if (!value.ok) return value;
  if (value.value !== undefined && value.value > MAX_UNIX_SECONDS) {
    return reject(
      param,
      `\`${param}\` (${value.value}) is not a unix SECONDS timestamp - it is about a thousand times too large, `
      + "which is what a milliseconds value looks like. Divide by 1000 and retry; sent as is it selects a window "
      + "far in the future and returns an empty history that reads as a dead market.",
    );
  }
  return value;
}

export function parseMorphoActivityParams(p: Record<string, unknown>): MorphoParams<MorphoActivityQueryParams> {
  const chainIds = readChains(p["chainIds"], "chainIds");
  if (!chainIds.ok) return chainIds;
  const marketIds = readMarketIdCsv(p["marketIds"], "marketIds");
  if (!marketIds.ok) return marketIds;

  const walletRaw = readOptionalString(p["walletAddress"]);
  if (walletRaw !== undefined && !ADDRESS_PATTERN.test(walletRaw)) {
    return reject("walletAddress", `\`walletAddress\` "${walletRaw}" is not a 0x-prefixed 40-hex EVM address.`);
  }

  const types = readTypes(p["types"], "types");
  if (!types.ok) return types;
  const since = readUnixSeconds(p["since"], "since");
  if (!since.ok) return since;
  const until = readUnixSeconds(p["until"], "until");
  if (!until.ok) return until;
  const sort = readOptionalEnum(p["sort"], "sort", MORPHO_ACTIVITY_SORT_KEYS);
  if (!sort.ok) return sort;
  const order = readOptionalEnum(p["order"], "order", MORPHO_ORDERS);
  if (!order.ok) return order;
  const limit = readOptionalNumber(p["limit"], "limit", { min: 1, max: MORPHO_MAX_ACTIVITY_LIMIT, integer: true });
  if (!limit.ok) return limit;
  const offset = readOptionalNumber(p["offset"], "offset", { min: 0, integer: true });
  if (!offset.ok) return offset;

  const rangeRejection = checkRange("since", since.value, "until", until.value);
  if (rangeRejection !== null) return { ok: false, rejection: rangeRejection };

  const wallet = walletRaw?.toLowerCase();
  const filters: MorphoActivityFilters = {
    ...(chainIds.value ? { chainId_in: chainIds.value } : {}),
    ...(marketIds.value ? { marketUniqueKey_in: marketIds.value } : {}),
    ...(wallet !== undefined ? { userAddress_in: [wallet] } : {}),
    ...(types.value ? { type_in: types.value.map((key) => MORPHO_ACTIVITY_TYPES[key as keyof typeof MORPHO_ACTIVITY_TYPES]) } : {}),
    ...(since.value !== undefined ? { timestamp_gte: since.value } : {}),
    ...(until.value !== undefined ? { timestamp_lte: until.value } : {}),
  };

  return {
    ok: true,
    value: {
      filters,
      sort: sort.value ?? "timestamp",
      order: order.value ?? "desc",
      limit: limit.value ?? 25,
      offset: offset.value ?? 0,
      types: types.value,
      echo: {
        ...(chainIds.value ? { chainIds: chainIds.value } : {}),
        ...(marketIds.value ? { marketIds: marketIds.value } : {}),
        ...(wallet !== undefined ? { walletAddress: wallet } : {}),
        ...(types.value ? { types: types.value } : {}),
        ...(since.value !== undefined ? { since: since.value } : {}),
        ...(until.value !== undefined ? { until: until.value } : {}),
        sort: sort.value ?? "timestamp",
        order: order.value ?? "desc",
        limit: limit.value ?? 25,
        offset: offset.value ?? 0,
      },
    },
  };
}
