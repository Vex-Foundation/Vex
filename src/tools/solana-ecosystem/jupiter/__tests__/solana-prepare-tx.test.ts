/**
 * `prepareVersionedTx` unit tests (W5 design §2/R2/R2b) — the staged Solana
 * seam's sign-only step. Mirrors `solana-transaction-idempotency.test.ts`'s
 * pattern: real, deserializable `VersionedTransaction`s built with
 * `@solana/web3.js`, driven against a fake `Connection` for the REPLACE mode.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    solana: {
      rpcUrl: "http://localhost:8899",
      commitment: "confirmed",
      explorerUrl: "https://explorer.solana.com",
      cluster: "mainnet-beta",
    },
  }),
}));

const { prepareVersionedTx } = await import("@tools/solana-ecosystem/shared/solana-transaction.js");
const { VexError, ErrorCodes } = await import("../../../../errors.js");

const {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} = await import("@solana/web3.js");
type Connection = import("@solana/web3.js").Connection;

const SIGNER = Keypair.generate();
const OTHER_SIGNER = Keypair.generate();
// Stand-ins for Jupiter's two provider-side signers (fee payer + co-signer).
const PROVIDER_FEE_PAYER = Keypair.generate();
const PROVIDER_COSIGNER = Keypair.generate();
// 32-byte all-ones is a valid base58 blockhash placeholder for compile/serialize.
const ORIGINAL_BLOCKHASH = PublicKey.default.toBase58();
// A different, syntactically-valid base58 string standing in for a "fresh" hash.
const FRESH_BLOCKHASH = "11111111111111111111111111111112";

/**
 * Every fixture in this file declares an explicit `SetComputeUnitLimit`,
 * because that matches reality: a Jupiter `/build` swap and a Prediction
 * transaction both bake one in. Nothing in the sign path reads it — the
 * subject here is the SIGNER and BLOCKHASH contracts.
 */
const FIXTURE_COMPUTE_UNIT_LIMIT = 200_000;

function buildSoleSignerTx(recentBlockhash = ORIGINAL_BLOCKHASH): InstanceType<typeof VersionedTransaction> {
  const ix = SystemProgram.transfer({
    fromPubkey: SIGNER.publicKey,
    toPubkey: new PublicKey("11111111111111111111111111111112"),
    lamports: 1,
  });
  const message = new TransactionMessage({
    payerKey: SIGNER.publicKey,
    recentBlockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: FIXTURE_COMPUTE_UNIT_LIMIT }), ix],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function buildTwoSignerTx(): InstanceType<typeof VersionedTransaction> {
  const ix = SystemProgram.createAccount({
    fromPubkey: SIGNER.publicKey,
    newAccountPubkey: OTHER_SIGNER.publicKey,
    lamports: 1_000_000,
    space: 0,
    programId: SystemProgram.programId,
  });
  const message = new TransactionMessage({
    payerKey: SIGNER.publicKey,
    recentBlockhash: ORIGINAL_BLOCKHASH,
    instructions: [ix],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/**
 * The REAL Jupiter Prediction keeper-filled shape, captured live 2026-07-25
 * (`agents_dm/verify/probe-predict-execution-lanes.ts`, POLY-1654958):
 * numRequiredSignatures=3, numReadonlySignedAccounts=2 — slot 0 the provider's
 * writable fee payer, slot 1 a provider readonly co-signer, slot 2 OUR wallet
 * as a readonly signer. Both provider slots arrive ALREADY SIGNED; only ours is
 * empty. `preSign` mirrors that so the fixture is not a fiction.
 */
function buildProviderCoSignedTx(
  ourKey: InstanceType<typeof Keypair> = SIGNER,
  preSign = true,
): InstanceType<typeof VersionedTransaction> {
  const ix = new TransactionInstruction({
    programId: new PublicKey("11111111111111111111111111111112"),
    keys: [
      { pubkey: PROVIDER_COSIGNER.publicKey, isSigner: true, isWritable: false },
      { pubkey: ourKey.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
  const message = new TransactionMessage({
    payerKey: PROVIDER_FEE_PAYER.publicKey,
    recentBlockhash: ORIGINAL_BLOCKHASH,
    // The ComputeBudget instruction introduces no signer, so the 3-slot signer
    // block this fixture is built to reproduce is unchanged.
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: FIXTURE_COMPUTE_UNIT_LIMIT }), ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (preSign) tx.sign([PROVIDER_FEE_PAYER, PROVIDER_COSIGNER]);
  return tx;
}

function coSigned(requiredSigners: readonly string[]) {
  return {
    connection: makeFakeConnection(),
    knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 413108534 },
    signerContract: { kind: "coSigned" as const, requiredSigners },
  };
}

function toBase64(tx: InstanceType<typeof VersionedTransaction>): string {
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * The only RPC call the sign path makes is REPLACE mode's `getLatestBlockhash`.
 * VERIFY mode needs no `Connection` at all.
 */
function makeFakeConnection(blockhash: string = FRESH_BLOCKHASH, lastValidBlockHeight = 1) {
  const getLatestBlockhash = vi.fn(async () => ({ blockhash, lastValidBlockHeight }));
  return { getLatestBlockhash } as unknown as Connection & {
    getLatestBlockhash: typeof getLatestBlockhash;
  };
}

describe("prepareVersionedTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("VERIFY mode (knownBlockhash given)", () => {
    it("signs and returns the given evidence when the embedded blockhash matches", async () => {
      const tx = buildSoleSignerTx();
      const prepared = await prepareVersionedTx(toBase64(tx), SIGNER, {
        connection: makeFakeConnection(),
        knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 12345 },
      });

      expect(prepared.recentBlockhash).toBe(ORIGINAL_BLOCKHASH);
      expect(prepared.lastValidBlockHeight).toBe(12345);
      expect(typeof prepared.signature).toBe("string");
      expect(prepared.signature.length).toBeGreaterThan(0);

      // The returned bytes must deserialize to a tx carrying a real (non-zero) signature.
      const resigned = VersionedTransaction.deserialize(prepared.serialized);
      expect(resigned.signatures[0]!.some((byte) => byte !== 0)).toBe(true);
    });

    /**
     * VERIFY mode has FRESH blockhash evidence tied to these exact bytes, so
     * signing needs nothing from the network. Pinned by omitting `connection`
     * entirely: any RPC call on this path would fall back to
     * `getSolanaConnection()` and reach for `http://localhost:8899`, so a
     * network round-trip cannot hide behind an injected fake here.
     */
    it("signs with no Connection at all — VERIFY mode makes no network call", async () => {
      const prepared = await prepareVersionedTx(toBase64(buildSoleSignerTx()), SIGNER, {
        knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 12345 },
      });

      expect(prepared.recentBlockhash).toBe(ORIGINAL_BLOCKHASH);
      expect(prepared.signature.length).toBeGreaterThan(0);
    });

    it("refuses when the given evidence does not match the transaction's embedded blockhash", async () => {
      const tx = buildSoleSignerTx(ORIGINAL_BLOCKHASH);
      await expect(
        prepareVersionedTx(toBase64(tx), SIGNER, {
          knownBlockhash: { blockhash: FRESH_BLOCKHASH, lastValidBlockHeight: 1 },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_BLOCKHASH_MISMATCH });
    });
  });

  describe("REPLACE / MANDATORY-HEIGHT mode (no knownBlockhash)", () => {
    it("fetches a fresh blockhash, replaces the embedded one, and persists the FRESH pair as evidence", async () => {
      const tx = buildSoleSignerTx(ORIGINAL_BLOCKHASH);
      const connection = makeFakeConnection(FRESH_BLOCKHASH, 999);

      const prepared = await prepareVersionedTx(toBase64(tx), SIGNER, { connection });

      expect(prepared.recentBlockhash).toBe(FRESH_BLOCKHASH);
      expect(prepared.lastValidBlockHeight).toBe(999);

      // The signed bytes must carry the FRESH blockhash, not the original one.
      const resigned = VersionedTransaction.deserialize(prepared.serialized);
      expect(resigned.message.recentBlockhash).toBe(FRESH_BLOCKHASH);
    });
  });

  describe("strict sole-signer check", () => {
    it("refuses a transaction requiring more than one signer", async () => {
      const tx = buildTwoSignerTx();
      await expect(
        prepareVersionedTx(toBase64(tx), SIGNER, {
          knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 1 },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("refuses when the sole required signer does not match the given signer", async () => {
      const tx = buildSoleSignerTx();
      await expect(
        prepareVersionedTx(toBase64(tx), OTHER_SIGNER, {
          knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 1 },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("refuses a transaction that already carries a preserved (nonzero) signature", async () => {
      const tx = buildSoleSignerTx();
      tx.sign([SIGNER]); // pre-populate slot 0 — simulates a provider-preserved signature.
      const base64 = toBase64(tx);

      await expect(
        prepareVersionedTx(base64, SIGNER, {
          knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 1 },
        }),
      ).rejects.toBeInstanceOf(VexError);
      await expect(
        prepareVersionedTx(base64, SIGNER, {
          knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 1 },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });
  });

  /**
   * REGRESSION GUARD. The co-signed contract below widens what Vex will sign.
   * These four cases pin the paths it must NOT touch: the fee-bearing Jupiter
   * `/build` swap and Lend Earn/Borrow, where Vex is the sole signer AND the
   * fee payer. If any of these start passing a multi-signer transaction, the
   * widening has leaked.
   */
  describe("sole-signer strictness is UNCHANGED for the swap and lend paths", () => {
    it("still refuses a multi-signer transaction when no contract is named (the default)", async () => {
      await expect(
        prepareVersionedTx(toBase64(buildTwoSignerTx()), SIGNER, {
          knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 1 },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("still refuses a multi-signer transaction when soleSigner is named EXPLICITLY", async () => {
      await expect(
        prepareVersionedTx(toBase64(buildTwoSignerTx()), SIGNER, {
          knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 1 },
          signerContract: { kind: "soleSigner" },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("still refuses the provider-co-signed shape under the default contract — the exact live-gate refusal", async () => {
      await expect(
        prepareVersionedTx(toBase64(buildProviderCoSignedTx()), SIGNER, {
          knownBlockhash: { blockhash: ORIGINAL_BLOCKHASH, lastValidBlockHeight: 1 },
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("still refuses a pre-signed sole-signer transaction (REPLACE mode would void the signature)", async () => {
      const tx = buildSoleSignerTx();
      tx.sign([SIGNER]);
      await expect(
        prepareVersionedTx(toBase64(tx), SIGNER, { signerContract: { kind: "soleSigner" }, connection: makeFakeConnection(FRESH_BLOCKHASH, 1) }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });
  });

  describe("coSigned contract (provider-co-signed prediction transactions)", () => {
    it("signs ONLY our slot and leaves the provider's signatures byte-for-byte untouched", async () => {
      const tx = buildProviderCoSignedTx();
      const before = tx.signatures.map((s) => Uint8Array.from(s));

      const prepared = await prepareVersionedTx(toBase64(tx), SIGNER, coSigned([SIGNER.publicKey.toBase58()]));

      const after = VersionedTransaction.deserialize(prepared.serialized);
      expect(after.signatures).toHaveLength(3);
      expect(Array.from(after.signatures[0]!)).toEqual(Array.from(before[0]!));
      expect(Array.from(after.signatures[1]!)).toEqual(Array.from(before[1]!));
      // Our slot went from empty to filled.
      expect(before[2]!.every((b) => b === 0)).toBe(true);
      expect(after.signatures[2]!.some((b) => b !== 0)).toBe(true);
    });

    it("stages the FEE PAYER's signature as the transaction id — not ours", async () => {
      const tx = buildProviderCoSignedTx();
      const feePayerSig = bs58.encode(tx.signatures[0]!);
      const prepared = await prepareVersionedTx(toBase64(tx), SIGNER, coSigned([SIGNER.publicKey.toBase58()]));

      // Solana's txid is signatures[0]. Ours (slot 2) is NOT the txid, and
      // staging it would make the row unresolvable for the reconciliation sweep.
      expect(prepared.signature).toBe(feePayerSig);
      const after = VersionedTransaction.deserialize(prepared.serialized);
      expect(prepared.signature).not.toBe(bs58.encode(after.signatures[2]!));
    });

    it("keeps the provider's blockhash (VERIFY mode) so the pre-signatures stay valid", async () => {
      const prepared = await prepareVersionedTx(
        toBase64(buildProviderCoSignedTx()), SIGNER, coSigned([SIGNER.publicKey.toBase58()]),
      );
      expect(prepared.recentBlockhash).toBe(ORIGINAL_BLOCKHASH);
      expect(VersionedTransaction.deserialize(prepared.serialized).message.recentBlockhash).toBe(ORIGINAL_BLOCKHASH);
    });

    it("REFUSES without blockhash evidence — a REPLACE would silently void the provider's signatures", async () => {
      await expect(
        prepareVersionedTx(toBase64(buildProviderCoSignedTx()), SIGNER, {
          signerContract: { kind: "coSigned", requiredSigners: [SIGNER.publicKey.toBase58()] },
          connection: makeFakeConnection(FRESH_BLOCKHASH, 1),
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("REFUSES when requiredSigners names a key that is not ours", async () => {
      await expect(
        prepareVersionedTx(
          toBase64(buildProviderCoSignedTx()), SIGNER, coSigned([OTHER_SIGNER.publicKey.toBase58()]),
        ),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("REFUSES when requiredSigners omits our wallet entirely", async () => {
      await expect(
        prepareVersionedTx(toBase64(buildProviderCoSignedTx()), SIGNER, coSigned([])),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("REFUSES the Forecast shape — a second outstanding signer means the fee-payer slot may still be empty, so no transaction id exists to stage", async () => {
      await expect(
        prepareVersionedTx(
          toBase64(buildProviderCoSignedTx(SIGNER, false)),
          SIGNER,
          coSigned([PROVIDER_FEE_PAYER.publicKey.toBase58(), SIGNER.publicKey.toBase58()]),
        ),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("REFUSES when our wallet is not in the transaction's own signer block, however requiredSigners reads", async () => {
      // Provider claims it needs OUR signature, but the transaction is built
      // for a different wallet — the two must agree.
      await expect(
        prepareVersionedTx(
          toBase64(buildProviderCoSignedTx(OTHER_SIGNER)), SIGNER, coSigned([SIGNER.publicKey.toBase58()]),
        ),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("REFUSES when our own slot is already filled (never re-sign or overwrite)", async () => {
      const tx = buildProviderCoSignedTx();
      tx.sign([SIGNER]);
      await expect(
        prepareVersionedTx(toBase64(tx), SIGNER, coSigned([SIGNER.publicKey.toBase58()])),
      ).rejects.toMatchObject({ code: ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION });
    });

    it("REFUSES when the fee payer's slot is empty — there would be no transaction id to stage", async () => {
      await expect(
        prepareVersionedTx(
          toBase64(buildProviderCoSignedTx(SIGNER, false)), SIGNER, coSigned([SIGNER.publicKey.toBase58()]),
        ),
      ).rejects.toBeInstanceOf(VexError);
    });
  });

});
