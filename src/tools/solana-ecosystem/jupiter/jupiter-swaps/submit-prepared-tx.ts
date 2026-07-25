/**
 * Jupiter's `POST /tx/v1/submit` landing lane for a transaction that was
 * already signed + persisted via `prepareVersionedTx` +
 * `markActivitySolanaBroadcast` (W5 design `w5-design.md` §2/R2; landing-lane
 * design `solana-landing-lanes-design.md` D1/D4).
 *
 * TIP-GATED BY THE TYPE SYSTEM (design D1). This endpoint REQUIRES the
 * transaction to carry a SOL tip of at least 1,000,000 lamports to one of
 * Jupiter's 16 published receivers; a tipless transaction is rejected or never
 * lands. The `JupiterSubmitTipProof` argument is not optional and cannot be
 * constructed outside `submit-tip-proof.ts`, so a caller holding a tipless
 * provider blob (Lend, Borrow, Prediction) CANNOT call this function at all —
 * it must use the RPC lane (`shared/solana-transaction/rpc-submit.ts`). This
 * replaces the pre-2026-07-24 behaviour, where every Solana mutation path
 * reached this endpoint and the tipless ones silently vanished on real funds.
 *
 * The LOCAL signature (derived at sign time — already the row's canonical
 * `tx_hash`) is authoritative. Jupiter's response signature MUST equal it: a
 * mismatch NEVER replaces the persisted signature and NEVER terminalizes the
 * row — the row remains `pending` for the sweep. "Abort" means stop
 * submitting, not fail the activity: submission may already have landed under
 * the local signature.
 *
 * This function does not throw. A failure is classified into the shared
 * `SolanaSubmitOutcome` vocabulary so the caller can tell a DEFINITIVE
 * provider refusal (4xx — e.g. "missing or insufficient tip"; nothing was
 * broadcast, so claiming "pending confirmation" would be a lie) from an
 * AMBIGUOUS transport failure (the bytes may already be in flight, so the row
 * stays truthful-pending). Neither outcome terminalizes the row — the K3
 * sweep remains the sole settlement/expiry authority (design D4).
 */

import { jupiterSwapSubmit } from "./client.js";
import type { JupiterSubmitTipProof } from "./submit-tip-proof.js";
import {
  classifyProviderSubmitFailure,
  type SolanaSubmitOutcome,
} from "../../shared/solana-transaction/submit-outcome.js";
import type { PreparedSolanaTx } from "../../shared/solana-transaction.js";

/**
 * @param tipProof PROOF that `prepared` carries a qualifying tip. Obtainable
 * only from `assertBuildResponseSafeToSign` — see `submit-tip-proof.ts`.
 */
export async function submitPreparedTx(
  prepared: PreparedSolanaTx,
  tipProof: JupiterSubmitTipProof,
): Promise<SolanaSubmitOutcome> {
  // `tipProof` gates the lane at the type level; its value is not otherwise
  // needed here. Referenced so the parameter is unmistakably load-bearing.
  void tipProof;

  let signature: string;
  try {
    // The already-signed bytes, unchanged — never rebuilt or re-signed.
    const signedTransaction = Buffer.from(prepared.serialized).toString("base64");
    const response = await jupiterSwapSubmit({ signedTransaction });
    signature = response.signature;
  } catch (err) {
    return classifyProviderSubmitFailure(err);
  }

  if (signature !== prepared.signature) {
    return {
      kind: "signature_mismatch",
      localSignature: prepared.signature,
      providerSignature: signature,
    };
  }
  return { kind: "accepted", signature };
}
