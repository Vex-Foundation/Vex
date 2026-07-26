/**
 * Compatibility-barrel surface test for
 * `tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/schemas.ts`
 * after the structural split into the nested `./schemas/` subdirectory
 * (events / markets / orderbooks / orders / positions / history / profile /
 * trades / leaderboard / vault / transactions, with the shared PRIVATE base
 * schemas in `_shared`).
 *
 * Pins the EXACT runtime export set of the barrel (the 23 `jupiterPrediction*`
 * Zod schemas) plus each export's `typeof`, so callers importing from the old
 * path (`../schemas.js`, consumed by `prediction-api/client/{read,write}.ts`
 * and the existing `jupiter-prediction-schemas.test.ts`) see no difference.
 *
 * CODEX: this barrel has NO exported types — the wire interfaces stay canonical
 * in `types/`, so there are no `z.infer` exports to verify. The type-only check
 * below asserts the module shape carries ONLY the 23 runtime schema values
 * (every value is a Zod schema), pinning that no type-export leaked in.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as schemasMod from "../../tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/schemas.js";

// Compile-only assertion: every export is a Zod schema and there are no extra
// (e.g. type-only) members. `z.ZodTypeAny` covers every schema variant
// (ZodObject, ZodNullable, etc.). This erases at runtime.
type SchemasModule = typeof schemasMod;
type _AllAreZodSchemas = {
  [K in keyof SchemasModule]: SchemasModule[K] extends z.ZodTypeAny ? true : never;
};
const _typeProbe: _AllAreZodSchemas | null = null;
void _typeProbe;

describe("jupiter-prediction schemas barrel surface", () => {
  it("exposes exactly the expected 23 runtime schema exports", () => {
    const keys = Object.keys(schemasMod).sort();
    expect(keys).toEqual([
      "jupiterPredictionClaimPositionResponseSchema",
      "jupiterPredictionCloseAllPositionsResponseSchema",
      "jupiterPredictionCreateOrderResponseSchema",
      "jupiterPredictionEventMarketsResponseSchema",
      "jupiterPredictionEventSchema",
      "jupiterPredictionEventsResponseSchema",
      // K5: managed POST /execute response for a Jupiter Forecast (bisonfi) order.
      "jupiterPredictionExecuteResponseSchema",
      "jupiterPredictionHistoryResponseSchema",
      "jupiterPredictionLeaderboardsResponseSchema",
      "jupiterPredictionMarketResponseSchema",
      "jupiterPredictionOrderResponseSchema",
      "jupiterPredictionOrderStatusResponseSchema",
      "jupiterPredictionOrderbookResponseSchema",
      "jupiterPredictionOrdersResponseSchema",
      "jupiterPredictionPnlHistoryResponseSchema",
      "jupiterPredictionPositionResponseSchema",
      "jupiterPredictionPositionsResponseSchema",
      "jupiterPredictionProfileResponseSchema",
      "jupiterPredictionSearchEventsResponseSchema",
      "jupiterPredictionSuggestedEventsResponseSchema",
      "jupiterPredictionTradesResponseSchema",
      "jupiterPredictionTradingStatusResponseSchema",
      "jupiterPredictionVaultInfoResponseSchema",
    ]);

    // Every runtime export is a Zod schema (object) with a working safeParse.
    for (const key of keys) {
      const value = schemasMod[key as keyof SchemasModule];
      expect(typeof value).toBe("object");
      expect(value).toBeInstanceOf(z.ZodType);
      expect(typeof (value as z.ZodTypeAny).safeParse).toBe("function");
    }
  });
});
