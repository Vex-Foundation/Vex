/**
 * Surface pin for the Khalani `validation.ts` barrel after the resource-grouped
 * structural split into `validation/` (chains+tokens / quotes / deposits /
 * submit+orders / errors).
 *
 * Guards the PUBLIC export surface against drift: the exact 14-key set and the
 * `typeof` of each export (all functions). `parseKhalaniErrorBody`,
 * `parseKhalaniErrorPayload` and `isSolanaAddressLike` are consumed by the
 * Khalani client/helpers, so they are pinned alongside the strict response
 * validators. The split is behaviour-
 * preserving; equivalence is covered by `khalani-validation-equivalence.test.ts`.
 */

import { describe, expect, it } from "vitest";
import * as barrel from "@tools/khalani/validation.js";

// ── Exact key pin ───────────────────────────────────────────────────

const EXPECTED_KEYS = [
  "isSolanaAddressLike",
  "parseKhalaniErrorBody",
  "parseKhalaniErrorPayload",
  "validateAutocompleteResponse",
  "validateChainsResponse",
  "validateDepositPlan",
  "validateOrderResponse",
  "validateOrdersResponse",
  "validateQuoteResponse",
  "validateQuoteStreamRoute",
  "validateSubmitResponse",
  "validateTokenBalancesResponse",
  "validateTokenSearchResponse",
  "validateTokensResponse",
] as const;

describe("khalani validation barrel surface", () => {
  it("exposes exactly the expected 14 exports", () => {
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_KEYS]);
  });

  it("every export is a function", () => {
    for (const key of Object.keys(barrel)) {
      expect(typeof (barrel as Record<string, unknown>)[key]).toBe("function");
    }
  });
});
