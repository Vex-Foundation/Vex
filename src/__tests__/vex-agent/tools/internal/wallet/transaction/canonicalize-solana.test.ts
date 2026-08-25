/**
 * The unsigned Solana canonicalization seam.
 *
 * Two properties carry the money-path weight and both are asserted directly:
 * the FRESH BLOCKHASH is installed before the caller ever sees the bytes, so
 * what a user approves is what will be signed; and NOTHING here signs, so no
 * decrypted key can be smuggled into the prepare path.
 */

import { describe, it, expect } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  canonicalizeSolanaMessage,
  SOLANA_INTENT_DISPLAY_TTL_MS,
  type SolanaBlockhashProvider,
} from "@vex-agent/tools/internal/wallet/transaction/canonicalize-solana.js";

const payer = Keypair.generate();
const other = Keypair.generate();
const STALE_BLOCKHASH = "11111111111111111111111111111111";
const FRESH_BLOCKHASH = "GfV1yD9tvJoNGrLPbYSHQCPKXPPMFcpUFNWzhEUUqCXt";

const BLOCKHASHES: SolanaBlockhashProvider = {
  getLatestBlockhash: async () => ({
    blockhash: FRESH_BLOCKHASH,
    lastValidBlockHeight: 987_654_321,
  }),
};

function unsignedTransactionBase64(blockhash = STALE_BLOCKHASH): string {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: other.publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

describe("canonicalizeSolanaMessage", () => {
  it("REPLACES a stale blockhash before the caller sees anything", async () => {
    const result = await canonicalizeSolanaMessage(
      unsignedTransactionBase64(),
      payer.publicKey.toBase58(),
      BLOCKHASHES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recentBlockhash).toBe(FRESH_BLOCKHASH);
    expect(result.value.lastValidBlockHeight).toBe(987_654_321);
    // The returned bytes carry the fresh hash, not the caller's: approving a
    // stale hash and rewriting it at signing time would mean the user approved
    // a message that was never signed.
    const roundTripped = VersionedMessage.deserialize(
      new Uint8Array(Buffer.from(result.value.messageBase64, "base64")),
    );
    expect(roundTripped.recentBlockhash).toBe(FRESH_BLOCKHASH);
  });

  it("verifies the fee payer against the SESSION's selected wallet", async () => {
    const result = await canonicalizeSolanaMessage(
      unsignedTransactionBase64(),
      other.publicKey.toBase58(),
      BLOCKHASHES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("forbidden_field");
    expect(result.refusal.details?.feePayer).toBe(payer.publicKey.toBase58());
    expect(result.refusal.details?.selectedWallet).toBe(other.publicKey.toBase58());
  });

  it("refuses a proposal that already carries a signature", async () => {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: STALE_BLOCKHASH,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: other.publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);

    const result = await canonicalizeSolanaMessage(
      Buffer.from(tx.serialize()).toString("base64"),
      payer.publicKey.toBase58(),
      BLOCKHASHES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Installing a fresh blockhash invalidates any signature over the old
    // bytes; discarding somebody's signature silently is not acceptable.
    expect(result.refusal.message).toContain("already carries a signature");
  });

  it("accepts a BARE serialized message, not only a transaction envelope", async () => {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: STALE_BLOCKHASH,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: other.publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const result = await canonicalizeSolanaMessage(
      Buffer.from(message.serialize()).toString("base64"),
      payer.publicKey.toBase58(),
      BLOCKHASHES,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses input that is neither a transaction nor a message", async () => {
    for (const bad of ["", Buffer.from("not solana at all").toString("base64")]) {
      const result = await canonicalizeSolanaMessage(bad, payer.publicKey.toBase58(), BLOCKHASHES);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe("invalid_input");
    }
  });

  it("refuses a selected wallet address that is not a public key", async () => {
    const result = await canonicalizeSolanaMessage(
      unsignedTransactionBase64(),
      "not-a-key",
      BLOCKHASHES,
    );
    expect(result.ok).toBe(false);
  });

  it("the displayed expiry cap is 60 seconds and is not the authority", () => {
    // The number is frozen so a user has something readable. Block height does
    // not convert to a timestamp, which is why the height is stored too and
    // confirm rechecks it regardless of the clock.
    expect(SOLANA_INTENT_DISPLAY_TTL_MS).toBe(60_000);
  });
});
