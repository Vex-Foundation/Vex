/**
 * Verdict primitives shared by every venue family's extractor.
 */

import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";

export type LegVerdict = "pass" | "fail" | "unknown";

export interface LegVerdictDetail {
  readonly verdict: LegVerdict;
  readonly detail: Record<string, unknown>;
}

/** Worst-leg aggregation: any fail → fail; else any unknown → unknown; else pass. */
export function aggregateVerdict(legs: readonly LegVerdict[]): SafetyVerdict {
  if (legs.includes("fail")) return "fail";
  if (legs.includes("unknown")) return "unknown";
  return "pass";
}
