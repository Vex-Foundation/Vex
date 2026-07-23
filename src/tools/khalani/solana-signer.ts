import { Buffer } from "node:buffer";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { VexError, ErrorCodes } from "../../errors.js";

export function signSolanaTransaction(secretKey: Uint8Array, base64Tx: string): string {
  try {
    const txBytes = Buffer.from(base64Tx, "base64");
    const transaction = VersionedTransaction.deserialize(txBytes);
    const keypair = Keypair.fromSecretKey(secretKey);
    transaction.sign([keypair]);
    return Buffer.from(transaction.serialize()).toString("base64");
  } catch (err) {
    throw new VexError(
      ErrorCodes.KHALANI_SOLANA_SIGN_FAILED,
      `Failed to sign Solana transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Sign a Solana deposit transaction and return BOTH the signed payload AND the
 * base58 transaction signature — WITHOUT broadcasting. The signature is derived
 * from the signed `VersionedTransaction` (`bs58(signatures[0])`), which is
 * exactly what `sendRawTransaction` will later return, so a DB-backed caller can
 * persist the signature (Khalani's `txHash` field carries the Solana signature
 * by API contract) BEFORE the transaction reaches the network — the staged
 * sign→persist→broadcast discipline (Phase-2 R4), Solana equivalent of the EVM
 * hash staging.
 */
export function signSolanaTransactionWithSignature(
  secretKey: Uint8Array,
  base64Tx: string,
): { signedBase64: string; signature: string } {
  try {
    const txBytes = Buffer.from(base64Tx, "base64");
    const transaction = VersionedTransaction.deserialize(txBytes);
    const keypair = Keypair.fromSecretKey(secretKey);
    transaction.sign([keypair]);
    const rawSignature = transaction.signatures[0];
    if (!rawSignature || rawSignature.length === 0) {
      throw new VexError(
        ErrorCodes.KHALANI_SOLANA_SIGN_FAILED,
        "Signed Solana transaction did not produce a signature.",
      );
    }
    return {
      signedBase64: Buffer.from(transaction.serialize()).toString("base64"),
      signature: bs58.encode(rawSignature),
    };
  } catch (err) {
    if (err instanceof VexError) throw err;
    throw new VexError(
      ErrorCodes.KHALANI_SOLANA_SIGN_FAILED,
      `Failed to sign Solana transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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

export async function signAndSendSolanaTransaction(
  rpcUrl: string,
  secretKey: Uint8Array,
  base64Tx: string,
): Promise<string> {
  try {
    const signedBase64 = signSolanaTransaction(secretKey, base64Tx);
    const connection = new Connection(rpcUrl, "confirmed");
    const signature = await connection.sendRawTransaction(Buffer.from(signedBase64, "base64"));
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    // A resolved confirmation with a non-null `value.err` is a mined-but-failed
    // transaction, not a success (Codex final-review blocker 2).
    if (confirmation.value.err !== null) {
      throw new VexError(
        ErrorCodes.KHALANI_BROADCAST_FAILED,
        `Solana transaction ${signature} reverted on-chain.`,
      );
    }
    return signature;
  } catch (err) {
    if (err instanceof VexError) {
      throw err;
    }
    throw new VexError(
      ErrorCodes.KHALANI_BROADCAST_FAILED,
      `Failed to broadcast Solana transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
