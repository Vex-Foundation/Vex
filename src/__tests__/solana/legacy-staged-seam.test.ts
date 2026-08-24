/**
 * The legacy sign/submit/confirm SEAM itself - `prepareLegacyTx`,
 * `submitPreparedLegacyTxStaged`, `confirmStagedSignature` - exercised as REAL
 * functions against a scripted `Connection`.
 *
 * WHY DIRECTLY, and not only through the wallet executor. The executor tests
 * mock this module, so they pin how the executor REACTS to each outcome and
 * prove nothing about which outcome these functions actually produce. The split
 * introduced for migration 084 exists to make a durable row possible before
 * money moves, and its load-bearing claims are all in here:
 *
 *   - the signature is derived from the SIGNED BYTES, so it is available before
 *     anything is submitted, and it equals what the RPC would echo;
 *   - the blockhash evidence the 049 CHECK requires comes back with it;
 *   - preparing submits NOTHING;
 *   - `signAndSubmitLegacyTxStaged` still behaves exactly as it did for its
 *     existing (Jupiter) callers, because it is now those halves composed.
 *
 * The `Connection` is scripted rather than mocked at the module level: these
 * tests are about what the real functions do with a node's answers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import {
  prepareLegacyTx,
  submitPreparedLegacyTxStaged,
  confirmStagedSignature,
  signAndSubmitLegacyTxStaged,
} from "@tools/solana-ecosystem/shared/solana-transaction.js";

vi.mock("@tools/solana-ecosystem/shared/solana-transaction/confirm.js", () => ({
  confirmVersionedTx: (...args: unknown[]) => mockConfirm(...(args as [])),
}));
const mockConfirm = vi.fn<(...args: unknown[]) => Promise<void>>();

const BLOCKHASH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const LAST_VALID_BLOCK_HEIGHT = 4242;

/** Typed exactly like the method it stands in for, so `mock.calls[0]` is a real tuple. */
type SendRawTransactionSpy = ReturnType<
  typeof vi.fn<(raw: Uint8Array | Buffer | Array<number>, options?: unknown) => Promise<string>>
>;

/** A `Connection` with only the three methods this seam touches scripted. */
function scriptedConnection(overrides: Partial<{
  sendRawTransaction: SendRawTransactionSpy;
}> = {}) {
  const connection = Object.create(Connection.prototype) as Connection;
  return Object.assign(connection, {
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    })),
    sendRawTransaction:
      overrides.sendRawTransaction
      ?? (vi.fn(async () => "unused") as SendRawTransactionSpy),
  });
}

function transferTx(from: Keypair, to: PublicKey): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: 1_000n }),
  );
}

describe("prepareLegacyTx", () => {
  it("signs locally and submits NOTHING", async () => {
    const keypair = Keypair.generate();
    const connection = scriptedConnection();

    const prepared = await prepareLegacyTx(
      transferTx(keypair, Keypair.generate().publicKey),
      keypair,
      { connection },
    );

    // The whole point of the split: nothing reached the network.
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(prepared.serialized.length).toBeGreaterThan(0);
  });

  it("returns the signature the SIGNED BYTES carry, so it can be staged before submission", async () => {
    const keypair = Keypair.generate();
    const connection = scriptedConnection();
    const tx = transferTx(keypair, Keypair.generate().publicKey);

    const prepared = await prepareLegacyTx(tx, keypair, { connection });

    // A Solana transaction id IS the base58 of its first signature. Recomputing
    // it from the transaction independently proves the derivation, rather than
    // trusting the value the function chose to report.
    const feePayerSignature = tx.signature;
    if (feePayerSignature === null) throw new Error("the transaction was not signed");
    expect(prepared.signature).toBe(bs58.encode(feePayerSignature));
    // And it verifies against the signer, so it is a real signature over these
    // bytes and not an identifier assembled from something else.
    expect(tx.verifySignatures()).toBe(true);
  });

  it("returns the blockhash evidence the 049 staged-evidence CHECK requires", async () => {
    const keypair = Keypair.generate();
    const connection = scriptedConnection();

    const prepared = await prepareLegacyTx(
      transferTx(keypair, Keypair.generate().publicKey),
      keypair,
      { connection },
    );

    expect(prepared.recentBlockhash).toBe(BLOCKHASH);
    expect(prepared.lastValidBlockHeight).toBe(LAST_VALID_BLOCK_HEIGHT);
  });

  it("signs the blockhash it reports, so the staged evidence describes the staged bytes", async () => {
    const keypair = Keypair.generate();
    const connection = scriptedConnection();
    const tx = transferTx(keypair, Keypair.generate().publicKey);

    const prepared = await prepareLegacyTx(tx, keypair, { connection });

    expect(tx.recentBlockhash).toBe(prepared.recentBlockhash);
    expect(tx.feePayer?.equals(keypair.publicKey)).toBe(true);
  });
});

describe("submitPreparedLegacyTxStaged", () => {
  it("sends the prepared bytes UNCHANGED, exactly once", async () => {
    const keypair = Keypair.generate();
    const sendRawTransaction = vi.fn(async () => "sig") as SendRawTransactionSpy;
    const connection = scriptedConnection({ sendRawTransaction });
    const prepared = await prepareLegacyTx(
      transferTx(keypair, Keypair.generate().publicKey),
      keypair,
      { connection },
    );
    mockConfirm.mockResolvedValueOnce(undefined);

    await submitPreparedLegacyTxStaged(prepared, { connection });

    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    // Byte-for-byte: re-signing or refreshing a blockhash here would invalidate
    // the signature already persisted on the durable row.
    expect(sendRawTransaction.mock.calls[0]?.[0]).toBe(prepared.serialized);
  });

  it("reports the PREPARED signature, not the RPC echo", async () => {
    const keypair = Keypair.generate();
    const connection = scriptedConnection({
      sendRawTransaction: vi.fn(async () => "a-different-string-entirely") as SendRawTransactionSpy,
    });
    const prepared = await prepareLegacyTx(
      transferTx(keypair, Keypair.generate().publicKey),
      keypair,
      { connection },
    );
    mockConfirm.mockResolvedValueOnce(undefined);

    const result = await submitPreparedLegacyTxStaged(prepared, { connection });

    // The staged value is the identity the durable row already holds.
    expect(result.signature).toBe(prepared.signature);
    expect(result.phase).toBe("confirmed");
  });
});

describe("confirmStagedSignature", () => {
  it("reports confirmed when the confirmation returns", async () => {
    mockConfirm.mockResolvedValueOnce(undefined);
    const result = await confirmStagedSignature(scriptedConnection(), "sig-1");
    expect(result).toEqual({ signature: "sig-1", phase: "confirmed" });
  });

  it("classifies a chain failure as chain_failed, carrying the signature", async () => {
    const { VexError, ErrorCodes } = await import("../../errors.js");
    mockConfirm.mockRejectedValueOnce(new VexError(ErrorCodes.SOLANA_TX_FAILED, "tx failed"));

    const result = await confirmStagedSignature(scriptedConnection(), "sig-2");

    expect(result.phase).toBe("chain_failed");
    expect(result.signature).toBe("sig-2");
    // Structural label only - never the raw cause text.
    expect(result.errorKind).toBe(ErrorCodes.SOLANA_TX_FAILED);
  });

  it("classifies a timeout as confirmation_unknown - never a failure", async () => {
    const { VexError, ErrorCodes } = await import("../../errors.js");
    mockConfirm.mockRejectedValueOnce(new VexError(ErrorCodes.SOLANA_TX_TIMEOUT, "timed out"));

    const result = await confirmStagedSignature(scriptedConnection(), "sig-3");

    expect(result.phase).toBe("confirmation_unknown");
    expect(result.signature).toBe("sig-3");
  });

  it("defaults an UNRECOGNISED throw to confirmation_unknown rather than claiming failure", async () => {
    mockConfirm.mockRejectedValueOnce(new Error("websocket closed"));

    const result = await confirmStagedSignature(scriptedConnection(), "sig-4");

    // Claiming "definitely failed" when we do not know is the exact lie the
    // staged vocabulary exists to prevent.
    expect(result.phase).toBe("confirmation_unknown");
  });

  it("never throws", async () => {
    mockConfirm.mockRejectedValueOnce("a bare string, not an Error");
    await expect(confirmStagedSignature(scriptedConnection(), "sig-5")).resolves.toBeDefined();
  });
});

describe("signAndSubmitLegacyTxStaged (existing callers unchanged)", () => {
  it("still signs, submits and confirms in one call, reporting the signed bytes' signature", async () => {
    const keypair = Keypair.generate();
    const sendRawTransaction = vi.fn(async () => "echo") as SendRawTransactionSpy;
    const connection = scriptedConnection({ sendRawTransaction });
    const tx = transferTx(keypair, Keypair.generate().publicKey);
    mockConfirm.mockResolvedValueOnce(undefined);

    const result = await signAndSubmitLegacyTxStaged(tx, keypair, { connection });

    expect(result.phase).toBe("confirmed");
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    // The signature of the bytes it signed - not the RPC's "echo" string.
    const feePayerSignature = tx.signature;
    if (feePayerSignature === null) throw new Error("the transaction was not signed");
    expect(result.signature).toBe(bs58.encode(feePayerSignature));
  });

  it("still lets a send failure THROW for its existing callers", async () => {
    const keypair = Keypair.generate();
    const connection = scriptedConnection({
      sendRawTransaction: vi.fn(async () => {
        throw new Error("node refused");
      }) as SendRawTransactionSpy,
    });

    // This throw-on-send contract is why a DB-backed caller must not use this
    // function: it cannot tell a refusal from a lost response. The wallet send
    // path goes through `submitPreparedTxOverRpc` instead.
    await expect(
      signAndSubmitLegacyTxStaged(transferTx(keypair, Keypair.generate().publicKey), keypair, {
        connection,
      }),
    ).rejects.toThrow("node refused");
  });
});
