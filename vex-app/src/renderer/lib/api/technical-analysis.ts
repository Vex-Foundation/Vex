/**
 * The technical analysis card's read: a TanStack Query hook over
 * `window.vex.market.readTechnicalAnalysis`.
 *
 * Main runs the engine and owns every provider request; the renderer only
 * names the market, interval and cut-off. A read is a snapshot of closed
 * candles, so it is cached for the session view (no refetch on focus or
 * remount) and never retried here: main's limiter and the providers' own
 * throttles decide, and a refusal is a value the card shows in words.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  TechnicalAnalysisReadInput,
  TechnicalAnalysisReadOutput,
} from "@shared/schemas/technical-analysis.js";
import { marketKeys } from "./queryKeys.js";

export function useTechnicalAnalysisRead(
  input: TechnicalAnalysisReadInput,
): UseQueryResult<Result<TechnicalAnalysisReadOutput>> {
  return useQuery({
    queryKey: marketKeys.technicalAnalysis(input),
    queryFn: () => window.vex.market.readTechnicalAnalysis(input),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}
