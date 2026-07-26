/**
 * Managed-execution submit step for Jupiter Prediction orders (W5 design
 * `w5-design.md` §3; Batch-4-closure blocker 1) — the ONLY consumer of
 * `jupiterPredictionExecute` for a transaction that was already signed +
 * persisted via `prepareVersionedTx` + `markActivitySolanaBroadcast`. Mirrors
 * `jupiter-swaps/submit-prepared-tx.ts`'s role/shape exactly (same
 * `SolanaSubmitOutcome` contract, reused rather than duplicated).
 *
 * SCOPE CORRECTION (2026-07-25, live-proven): this was named
 * `submitPreparedForecastExecute` and documented as Forecast-only, on the
 * belief that "kalshi/polymarket (keeper-filled) orders never carry an
 * `execution` object and stay on the generic path". That belief was FALSE and
 * was the direct cause of `solana.predict.*` never being able to execute — a
 * keeper-filled Polymarket order carries `execution` too. EVERY prediction
 * build that returns an `execution` object comes here;
 * `prediction-api/managed-execution.ts` is the routing gate. Nothing
 * prediction-shaped goes to `/tx/v1/submit` (it carries no tip) or to the raw
 * RPC lane.
 *
 * The provider validates the signed transaction against the `execution.context`
 * object from the build (passed unchanged, per the OpenAPI spec) and settles
 * the order itself.
 *
 * The LOCAL signature (derived at sign time — already the row's canonical
 * `tx_hash`) is authoritative, exactly as for the generic submit path
 * (design R2/R2b): a `status: "Success"` whose `signature` does not equal the
 * local one is a `signature_mismatch` outcome, never a silent replace.
 *
 * This function does not throw. Failure classification (landing-lane design
 * `solana-landing-lanes-design.md` D4):
 *   - HTTP 4xx — the provider refused the request outright; nothing was
 *     executed, so the caller may honestly report a rejection.
 *   - `status: "Failed"` — deliberately AMBIGUOUS. This endpoint executes the
 *     swap leg on our behalf, and the documented response does not establish
 *     whether the failure happened before or after anything was broadcast.
 *     Claiming "nothing went on-chain" would be an unprovable financial
 *     assertion, so the row stays truthful-pending and the K3 sweep resolves
 *     it from the canonical local signature (same posture as before this
 *     change, which surfaced it as a throw the caller logged as pending).
 *   - anything else (5xx, timeout, network, unparseable body) — ambiguous.
 * No outcome terminalizes the row; the sweep remains the sole settlement
 * authority.
 */

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { jupiterPredictionExecute } from "./client.js";
import type { JupiterPredictionExecuteResponse } from "./types.js";
import {
  classifyProviderSubmitFailure,
  type SolanaSubmitOutcome,
} from "../../../shared/solana-transaction/submit-outcome.js";
import type { PreparedSolanaTx } from "../../../shared/solana-transaction.js";

export async function submitPreparedManagedExecute(
  prepared: PreparedSolanaTx,
  context: Record<string, unknown>,
): Promise<SolanaSubmitOutcome> {
  let response: JupiterPredictionExecuteResponse;
  try {
    // The already-signed bytes, unchanged — never rebuilt or re-signed.
    const signedTransaction = Buffer.from(prepared.serialized).toString("base64");
    response = await jupiterPredictionExecute({ signedTransaction, context });
  } catch (err) {
    return classifyProviderSubmitFailure(err);
  }

  if (response.status === "Failed") {
    // See the module doc: ambiguous by decision, not by omission.
    return {
      kind: "transport_uncertain",
      cause: new VexError(
        ErrorCodes.HTTP_REQUEST_FAILED,
        response.error ?? "Jupiter Prediction managed execution failed.",
      ),
    };
  }
  if (response.signature !== prepared.signature) {
    return {
      kind: "signature_mismatch",
      localSignature: prepared.signature,
      providerSignature: response.signature ?? "",
    };
  }
  return { kind: "accepted", signature: response.signature };
}
