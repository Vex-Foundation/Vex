/**
 * The trusted swap-prequote fields a venue extractor produces from an untrusted
 * quote result.
 */

import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";

export interface ExtractedQuote {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly chainId: number | null;
  readonly amount: string;
  readonly slippageBps: number | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}
