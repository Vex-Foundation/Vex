/**
 * The REPAIRED fill, judged against the floor the human approved.
 *
 * The immediate execute path already does this: both venue handlers call
 * `assessApprovedFloor` on the amounts they decoded and name a materially-short
 * fill instead of letting a confirmed row read as a good one. A settlement that
 * reached its amounts through the repair sweep instead - a crash between
 * broadcast and decode, a receipt this process never watched - had NO such
 * assessment, so exactly the fills nobody was watching were the ones nobody
 * checked. This module closes that asymmetry for EVERY venue at once, because
 * the input it needs is not venue-specific: the row's own non-attested
 * `approvedMinOutRaw`, written into `route_provenance` at intent time.
 *
 * IT OWNS NO POLICY. The comparison, the 1-raw-unit rederivation allowance and
 * the verdict sentence all belong to `assessApprovedFloor`; this file resolves
 * that function's inputs from a row and nothing more. DETECTION ONLY: it never
 * changes a settlement status, never re-decides an amount, and never fails a
 * repair pass.
 */

import { assessApprovedFloor, type ApprovedFloorAssessment } from "@tools/evm-chains/post-buy-delivery.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

/**
 * The floor the quote was approved at, as persisted beside this row.
 *
 * `route_provenance` is untrusted JSONB here - it is read back from the
 * database, so its shape is asserted rather than assumed. Anything that is not
 * a raw decimal string is left to `assessApprovedFloor`, which answers
 * `not_assessable` for it: a row written before the floor was recorded proves
 * nothing about its fill, and inventing a verdict from an absent number is
 * worse than staying silent.
 */
function approvedMinOutRawOf(routeProvenance: Record<string, unknown> | null): unknown {
  if (routeProvenance === null) return undefined;
  return routeProvenance.approvedMinOutRaw;
}

/**
 * Assess a repaired settlement against its approved floor.
 *
 * `executedAmountOutRaw` is what the sweep just decoded, passed in rather than
 * re-read from the row so the number judged is the number written.
 */
export function assessRepairedFill(input: {
  readonly row: AgentActivityEvent;
  readonly executedAmountOutRaw: string | undefined;
}): ApprovedFloorAssessment {
  return assessApprovedFloor({
    executedAmountOutRaw: input.executedAmountOutRaw,
    approvedMinOutRaw: approvedMinOutRawOf(input.row.routeProvenance),
    // The symbol is for the human sentence only; the comparison is raw units.
    // A row without one names the token by address rather than by nothing.
    tokenOutSymbol: input.row.tokenOutSymbol ?? input.row.tokenOutAddress ?? "the output token",
  });
}
