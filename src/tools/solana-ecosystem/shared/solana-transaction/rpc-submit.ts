/**
 * The protocol-agnostic RPC landing lane for an already-signed, already-staged
 * Solana transaction (design `solana-landing-lanes-design.md` D2/D3).
 *
 * WHY THIS EXISTS: `POST https://api.jup.ag/tx/v1/submit` REQUIRES a SOL tip
 * of at least 1,000,000 lamports to one of Jupiter's 16 published receivers
 * (developers.jup.ag/docs/transaction/submit — the OpenAPI schema states the
 * transaction "must contain" it and documents `400` for a missing/insufficient
 * tip). Only the fee-bearing `/build` swap carries such a tip. Lend, Borrow
 * and Prediction transactions are built by their own provider endpoints and
 * are TIPLESS, so submitting them there violated the endpoint's contract and
 * they silently vanished on real funds during the 2026-07-24 funded gate.
 * Those transactions go out here instead.
 *
 * CONTRACT (all four points are load-bearing):
 *
 *  1. BYTE-FOR-BYTE. `prepared.serialized` is handed to `sendRawTransaction`
 *     unchanged. `sendTransaction` "does not alter the transaction in any way;
 *     it relays the transaction created by clients to the node as-is"
 *     (solana.com/docs/rpc/http/sendtransaction). This module NEVER rebuilds,
 *     re-signs, refreshes a blockhash, or re-enters a provider transaction
 *     endpoint — the signature already persisted on the row must stay the one
 *     the bytes carry.
 *
 *  2. PREFLIGHT ON. `skipPreflight` is left false and `preflightCommitment` is
 *     `confirmed`, so the node verifies the signatures and simulates against
 *     confirmed state before accepting. A simulation failure is thereby
 *     reported to us synchronously instead of becoming a silent disappearance.
 *
 *  3. `maxRetries` is OMITTED, so "the RPC node will retry the transaction
 *     until it is finalized or until the blockhash expires"
 *     (solana.com/developers/guides/advanced/retry). The guide's recommended
 *     alternative — `maxRetries: 0` plus an application-owned rebroadcast loop
 *     — needs a durable outbox holding signed bytes, which is explicitly out
 *     of scope this wave (design D3) and needs its own security design. Node-
 *     side retry re-sends the SAME bytes, so it cannot violate point 1.
 *
 *  4. A successful return does NOT mean confirmation — the docs are explicit
 *     that acceptance "does not guarantee the transaction is processed or
 *     confirmed by the cluster". The caller stays truthful-pending and the K3
 *     sweep owns terminality (design D4).
 *
 * This module never throws: every failure is classified into the shared
 * `SolanaSubmitOutcome` vocabulary. A `SendTransactionError` means the node
 * ANSWERED and refused (preflight/simulation/signature-verification failure,
 * JSON-RPC error response), so nothing was broadcast; anything else is
 * ambiguous. Signed bytes are never logged and never appear in an outcome.
 */

import { Connection, SendTransactionError } from "@solana/web3.js";

import { getSolanaConnection } from "./connection.js";
import type { PreparedSolanaTx } from "./prepare.js";
import type { SolanaSubmitOutcome } from "./submit-outcome.js";

export interface SubmitPreparedTxOverRpcOptions {
  /** Defaults to the shared cached Solana connection. Inject for tests or a non-default RPC. */
  readonly connection?: Connection;
}

export async function submitPreparedTxOverRpc(
  prepared: PreparedSolanaTx,
  options: SubmitPreparedTxOverRpcOptions = {},
): Promise<SolanaSubmitOutcome> {
  let rpcSignature: unknown;
  try {
    const connection = options.connection ?? getSolanaConnection();
    // `prepared.serialized` is passed through untouched — see contract point 1.
    rpcSignature = await connection.sendRawTransaction(prepared.serialized, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
  } catch (err) {
    if (err instanceof SendTransactionError) {
      return { kind: "rejected_before_broadcast", cause: err };
    }
    return { kind: "transport_uncertain", cause: err };
  }

  // The RPC response is untrusted input: validate the shape before comparing
  // it against the canonical local signature.
  if (typeof rpcSignature !== "string" || rpcSignature.length === 0) {
    return {
      kind: "transport_uncertain",
      cause: new Error("Solana RPC returned no usable signature for the submitted transaction."),
    };
  }

  // `sendTransaction` returns "the first transaction signature embedded in the
  // transaction" — it must equal the signature already persisted on the row.
  // A divergence never replaces the persisted signature and never terminalizes.
  if (rpcSignature !== prepared.signature) {
    return {
      kind: "signature_mismatch",
      localSignature: prepared.signature,
      providerSignature: rpcSignature,
    };
  }

  return { kind: "accepted", signature: rpcSignature };
}
