/**
 * Khalani Solana broadcast/confirm helpers.
 *
 * NO SIGNING LIVES HERE (2026-07-25). This module used to export
 * `signSolanaTransaction` and `signAndSendSolanaTransaction`, which called
 * `transaction.sign([keypair])` on an externally-supplied blob with NO
 * signer-shape check of any kind — no sole-signer assertion, no check that the
 * transaction's required signer was actually ours, no check that we were not
 * overwriting a signature already in the blob. Both had ZERO callers anywhere
 * in the tree; the live Khalani deposit leg
 * (`bridge-executor.ts`'s `signStageSolanaLeg`) signs through the shared
 * `prepareVersionedTx`, which enforces the `soleSigner` contract. They were
 * deleted rather than retrofitted with a guard: removing an unguarded signing
 * entry point is strictly safer than documenting one nobody runs. Any future
 * Khalani signing must go through `prepareVersionedTx` with an explicit
 * `signerContract`, like every other Solana write path.
 */

import { Buffer } from "node:buffer";
import { Connection } from "@solana/web3.js";

/** Broadcast an already-signed Solana payload (base64). Returns the network-reported signature. */
export async function broadcastSignedSolanaTransaction(rpcUrl: string, signedBase64: string): Promise<string> {
  const connection = new Connection(rpcUrl, "confirmed");
  return connection.sendRawTransaction(Buffer.from(signedBase64, "base64"));
}

/** The outcome of confirming a broadcast Solana signature — mirrors the EVM receipt status. */
export type SolanaConfirmationOutcome =
  | { readonly status: "confirmed" }
  | { readonly status: "reverted"; readonly error: string };

/**
 * Await confirmation of a broadcast Solana signature and INSPECT the RPC result.
 *
 * `confirmTransaction` RESOLVES (it does NOT reject) for a transaction that landed
 * on-chain but FAILED — the failure is carried in `value.err`. Treating any
 * resolved response as success would confirm a reverted deposit and submit it to
 * Khalani (Codex final-review blocker 2). A non-null `value.err` is therefore
 * surfaced as a `reverted` outcome, exactly like an EVM receipt with
 * `status !== "success"`. An RPC/network error still THROWS, so the staged caller
 * maps it to an ambiguous (unknown) outcome rather than a false success.
 */
export async function confirmSolanaSignature(
  rpcUrl: string,
  signature: string,
): Promise<SolanaConfirmationOutcome> {
  const connection = new Connection(rpcUrl, "confirmed");
  const confirmation = await connection.confirmTransaction(signature, "confirmed");
  const err = confirmation.value.err;
  if (err !== null) {
    return { status: "reverted", error: typeof err === "string" ? err : JSON.stringify(err) };
  }
  return { status: "confirmed" };
}
