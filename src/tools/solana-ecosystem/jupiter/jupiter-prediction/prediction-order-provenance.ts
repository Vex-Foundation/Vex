/**
 * The `route_provenance.prediction_order` payload contract — the PER-ROW
 * identity of the position a Jupiter Prediction payout row is closing.
 *
 * Same shape of concern, and the same home, as `jupiter-swaps/
 * settlement-profile.ts`: the protocol owns its `route_provenance` payload and
 * the venue handler writes it (`tools/protocols/solana-jupiter/
 * predict-execute*.ts`). Deliberately a pure module with no DB and no provider
 * imports, so the contract never has to reach through a persistence layer.
 *
 * WRITE-ONLY TODAY (2026-07-30). The in-repo READER died with the prediction
 * fill-settlement lane when the repair sweeps became status-only. The write
 * stays: it is per-row audit metadata for a self-custodial money app, and it is
 * the only durable record of which position each fanned-out row closed.
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
 * VERSIONED. `version` is bumped only for a non-backward-compatible reshape, so
 * a later reader can tell a shape it understands from one it does not.
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
