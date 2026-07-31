/**
 * `trench.search` handler — name/symbol lookup over `/api/search` (READ-ONLY).
 */

import { getTrenchExpressClient } from "@tools/trench-express/client.js";
import { ok, fail } from "../../handler-helpers.js";
import { readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import { projectToken } from "./list.js";
import { trenchFailureDetail } from "./failure.js";

const SEARCH_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: 30 },
};

export async function trenchSearchHandler(p: Record<string, unknown>) {
  const query = typeof p.query === "string" ? p.query.trim() : "";
  if (!query) return fail("Missing required: query (a token name or symbol fragment).");

  const limitRead = readNumber(p, "limit", SEARCH_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);

  try {
    const client = getTrenchExpressClient();
    const rows = await client.search({ search: query, limit: limitRead.value ?? undefined });
    const projected = rows.map(projectToken);
    return ok({ query, count: projected.length, tokens: projected });
  } catch (err) {
    return fail(`Trench search unavailable (${trenchFailureDetail("trench.search", err)})`);
  }
}
