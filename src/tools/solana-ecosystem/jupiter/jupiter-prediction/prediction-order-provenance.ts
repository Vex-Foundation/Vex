/**
 * The `route_provenance.prediction_order` payload contract — the PER-ROW
 * identity of the position a Jupiter Prediction payout row is closing.
 *
 * Same shape of concern, and the same home, as `jupiter-swaps/
 * settlement-profile.ts`: the protocol owns its `route_provenance` payload,
 * the venue handler writes it (`tools/protocols/solana-jupiter/
 * predict-execute*.ts`), and the settlement sweep reads it back
 * (`vex-agent/sync/solana-prediction-fill-settlement.ts`). Deliberately a pure
 * module with no DB and no provider imports, so writer and reader can never
 * drift apart and neither has to reach through a persistence layer for a value
 * contract.
 *
 * WHY IT EXISTS. `solana.predict.closeAll` fans out into N `agent_activity`
 * rows inside ONE `protocol_executions` row, and all N share that execution's
 * single `params` echo — the per-item `positionPubkey` reached only the tool
 * RESULT, which nothing can query later. The payout for each of those rows
 * arrives in a KEEPER's separate transaction, so the sweep that settles them
 * has nothing but the row to tell it which position to ask the provider about.
 * Without a per-row position, a wallet with two open positions could have a
 * row matched against its sibling's money.
 *
 * VERSIONED, AND UNKNOWN VERSIONS READ AS ABSENT. A row written before this
 * contract, a malformed fragment, or a future reshape all yield `null` — the
 * sweep then falls back to a per-wallet lookup rather than trusting a shape it
 * does not understand.
 */

/** `route_provenance` key owning the prediction order's per-row identity + its settlement proof. */
export const PREDICTION_ORDER_PROVENANCE_KEY = "prediction_order";

/** Bumped only for a non-backward-compatible reshape. */
const PREDICTION_ORDER_PROVENANCE_VERSION = 1;

/**
 * The fragment every payout-role row persists at INTENT time, naming the
 * position THIS row closes. Written per fan-out item, never once per
 * execution.
 */
export function buildPredictionOrderProvenance(positionPubkey: string): Record<string, unknown> {
  return {
    [PREDICTION_ORDER_PROVENANCE_KEY]: {
      version: PREDICTION_ORDER_PROVENANCE_VERSION,
      positionPubkey,
    },
  };
}

/**
 * The position this row closed, read back out of its OWN persisted
 * provenance. `null` — never a guess — for an absent, malformed, or
 * unrecognized-version fragment. Survives the settlement merge, because the
 * finalizer merges INTO `prediction_order` instead of replacing it.
 */
export function readPredictionOrderPositionPubkey(
  routeProvenance: Record<string, unknown> | null,
): string | null {
  if (routeProvenance === null) return null;
  const fragment = routeProvenance[PREDICTION_ORDER_PROVENANCE_KEY];
  if (typeof fragment !== "object" || fragment === null || Array.isArray(fragment)) return null;
  const record = fragment as Record<string, unknown>;
  if (record.version !== PREDICTION_ORDER_PROVENANCE_VERSION) return null;
  const positionPubkey = record.positionPubkey;
  if (typeof positionPubkey !== "string" || positionPubkey.length === 0) return null;
  return positionPubkey;
}
