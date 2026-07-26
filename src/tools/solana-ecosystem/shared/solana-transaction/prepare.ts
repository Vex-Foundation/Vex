/**
 * Staged Solana transaction preparation — the sign-without-send seam (W5
 * design `w5-design.md` §2/R2/R2b/R2c). Splits what `signAndSendVersionedTx`
 * did monolithically into a SIGN-ONLY step so a caller can persist the
 * derived signature (+ blockhash evidence) BEFORE anything reaches the
 * network:
 *
 *   prepareVersionedTx(tx, signer)  -> PreparedSolanaTx (sign, DO NOT send)
 *   persist                         -> markActivitySolanaBroadcast (atomic CAS)
 *   submit                          -> a landing lane chosen by PROVEN tip:
 *     `jupiter-swaps/submit-prepared-tx.ts` (/tx/v1/submit — requires a
 *     `JupiterSubmitTipProof`) or `./rpc-submit.ts` (RPC, byte-for-byte, the
 *     lane for every tipless provider-built transaction)
 *
 * TWO SIGNER CONTRACTS, named by the caller (`options.signerContract`) so a
 * reader sees which invariant a given call site expects. Both share ONE
 * non-negotiable rule: we sign our OWN slot and nothing else, and we never
 * stage a `tx_hash` that is not a real Solana transaction id.
 *
 *   - `soleSigner` (DEFAULT, unchanged): the transaction's OWN
 *     `numRequiredSignatures` must be exactly 1, that ONE required signer must
 *     equal the caller's `signer.publicKey`, and its signature slot must be
 *     unsigned. This is the contract for the fee-bearing Jupiter `/build` swap
 *     and for Lend Earn/Borrow, where Vex IS the fee payer and the sole
 *     signer. Not relaxed by the co-signed contract below.
 *
 *   - `coSigned`: a PROVIDER-co-signed transaction (Jupiter Prediction) where
 *     Vex is NOT the fee payer. The provider names the signatures it is still
 *     waiting for in the response's `requiredSigners`; that list is untrusted
 *     input and must name EXACTLY our wallet. That single condition is what
 *     makes this contract safe, and it is load-bearing for a second reason
 *     (proven live 2026-07-25): when we are the LAST outstanding signer the
 *     provider has ALREADY filled the fee payer's slot, so `signatures[0]` —
 *     the Solana transaction id — is a real signature we can stage BEFORE
 *     submitting. A response naming any other outstanding signer means the
 *     fee-payer slot may still be empty, the transaction id is therefore NOT
 *     locally derivable, and this function REFUSES rather than stage a hash
 *     the reconciliation sweep could never resolve.
 *
 * `coSigned` REQUIRES VERIFY mode (below). The provider pre-signs the slots it
 * owns, and those signatures cover the message as built — replacing the
 * blockhash would silently invalidate every one of them.
 *
 * Blockhash evidence has two modes (R2/R2b):
 *   - VERIFY (`options.knownBlockhash` given): the caller already has FRESH
 *     evidence tied to these exact bytes (Jupiter `/build`'s
 *     `blockhashWithMetadata`; Jupiter Prediction's `txMeta`) — the
 *     deserialized transaction's OWN `recentBlockhash` must equal it; a
 *     mismatch refuses rather than silently trusting evidence that does not
 *     describe these bytes.
 *   - REPLACE / MANDATORY-HEIGHT (default, no `knownBlockhash`): a lend/borrow
 *     transaction carries no separate height evidence, and Solana has no RPC
 *     method to recover `lastValidBlockHeight` for an ALREADY-baked blockhash
 *     after the fact — the only honest option is to fetch a FRESH
 *     `{blockhash, lastValidBlockHeight}` pair and REPLACE the transaction's
 *     blockhash with it before signing.
 *
 *     CORRECTION (2026-07-25, live-proven): this module previously claimed
 *     every provider-built Solana transaction — "lend/prediction/Forecast" —
 *     carries no height evidence. That is FALSE for Jupiter Prediction, whose
 *     order/close/claim builds return `txMeta: {blockhash,
 *     lastValidBlockHeight}` matching the transaction's own embedded
 *     blockhash. Prediction therefore uses VERIFY mode, which it must: see the
 *     `coSigned` contract above.
 *
 * NO COMPUTE-BUDGET CHECK HAPPENS HERE (owner decision, 2026-07-25). A
 * pre-sign gate that simulated the transaction and refused an insufficient
 * compute budget shipped and was removed the same day: Jupiter sets the limit
 * itself via `dynamicComputeUnitLimit`, a starved transaction reverts
 * ATOMICALLY so no funds move, and the entire cost of the live failure that
 * motivated it was 15,023 lamports (~$0.0011). Refusing a trade worth orders of
 * magnitude more to avoid a tenth of a cent is the wrong trade, and the chain
 * already enforces the limit. Do not reintroduce it without an owner decision.
 *
 * A throw from this function is a POST-INTENT failure whenever the caller
 * has already run `createAgentActivityIntent` (the W5 write-protocol order is
 * always: create the intent row(s) FIRST, then prepare/sign) — the caller
 * MUST finalize the EXISTING event via `failActivityEvent` (single event) or
 * `abortPlannedEvents` (sibling never-signed rows), NEVER
 * `createAgentActivityPreBroadcastFailure`, which would create a SECOND
 * `protocol_executions` row for the same attempt (design REVISION 1 R2).
 *
 * DB-free by design (mirrors `./sign.js` / `./deserialize.js`): this module
 * only signs bytes and derives evidence. The caller (a
 * `vex-agent/tools/protocols/*` handler orchestrator) owns every
 * `agent_activity` write.
 */

import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { VexError, ErrorCodes } from "../../../../errors.js";
import { deserializeVersionedTx } from "./deserialize.js";
import { signVersionedTx } from "./sign.js";
import { getSolanaConnection } from "./connection.js";

/** Fresh blockhash evidence already tied to the transaction's bytes (e.g. Jupiter `/build`'s `blockhashWithMetadata`). */
export interface KnownSolanaBlockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

/**
 * Which signer invariant this call site expects — see the module doc. Stated
 * explicitly at every call site rather than inferred, because `soleSigner` and
 * `coSigned` protect against different things and silently picking the wrong
 * one is a money-path error.
 */
export type SolanaSignerContract =
  /** Vex is the sole signer AND the fee payer (Jupiter `/build` swap, Lend Earn/Borrow). */
  | { readonly kind: "soleSigner" }
  /**
   * A provider-co-signed transaction. `requiredSigners` is the provider's own
   * untrusted list of signatures it is still waiting for; it must name exactly
   * our wallet.
   */
  | { readonly kind: "coSigned"; readonly requiredSigners: readonly string[] };

export interface PrepareVersionedTxOptions {
  /** Defaults to the shared cached Solana connection. Inject for tests or a non-default RPC. */
  readonly connection?: Connection;
  /** See module doc — VERIFY mode. Omit for REPLACE / MANDATORY-HEIGHT mode. */
  readonly knownBlockhash?: KnownSolanaBlockhash;
  /** Defaults to `soleSigner`, so every pre-existing call site keeps its exact contract. */
  readonly signerContract?: SolanaSignerContract;
}

/**
 * The ONE currency between prepare/persist/submit (design R2): serialized
 * SIGNED bytes, the derived base58 signature, and the blockhash evidence
 * that must be persisted alongside it via `markActivitySolanaBroadcast`.
 */
export interface PreparedSolanaTx {
  readonly serialized: Uint8Array;
  readonly signature: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
}

export async function prepareVersionedTx(
  txInput: Uint8Array | string,
  signer: Keypair,
  options: PrepareVersionedTxOptions = {},
): Promise<PreparedSolanaTx> {
  const tx = deserializeVersionedTx(txInput);
  const contract = options.signerContract ?? { kind: "soleSigner" };

  const ourSlot = contract.kind === "soleSigner"
    ? assertUnsignedSoleSigner(tx, signer)
    : assertCoSignedSlot(tx, signer, contract.requiredSigners, options.knownBlockhash);

  // Snapshot every slot BEFORE signing so the post-condition below can prove
  // we touched exactly one — the provider's own signatures must survive
  // byte-for-byte.
  const slotsBefore = tx.signatures.map((sig) => Uint8Array.from(sig));

  const evidence = options.knownBlockhash
    ? verifyKnownBlockhash(tx, options.knownBlockhash)
    : await replaceWithFreshBlockhash(tx, options.connection ?? getSolanaConnection());

  signVersionedTx(tx, [signer]);
  assertOnlyOurSlotChanged(tx, slotsBefore, ourSlot);

  // ALWAYS slot 0: the Solana transaction id is the FEE PAYER's signature. In
  // `soleSigner` that is our own; in `coSigned` it is the provider's
  // pre-filled one. A zero here means the transaction has no derivable id, so
  // there is nothing honest to stage as `tx_hash` — refuse.
  const rawSignature = tx.signatures[0];
  if (!rawSignature || isZeroSignature(rawSignature)) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_FAILED,
      "Signing did not produce a transaction id: the fee payer's signature slot is empty.",
    );
  }

  return {
    serialized: tx.serialize(),
    signature: bs58.encode(rawSignature),
    recentBlockhash: evidence.blockhash,
    lastValidBlockHeight: evidence.lastValidBlockHeight,
  };
}

/**
 * STRICT sole-signer check (Codex BATCH-4 final design note) — see module doc.
 * UNCHANGED by the 2026-07-25 co-signed widening: this remains the contract for
 * the fee-bearing `/build` swap and for Lend Earn/Borrow. Returns our signature
 * slot index (always 0 here).
 */
function assertUnsignedSoleSigner(tx: VersionedTransaction, signer: Keypair): number {
  const { numRequiredSignatures } = tx.message.header;
  if (numRequiredSignatures !== 1) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
      `Refusing to sign: transaction requires ${numRequiredSignatures} signers, expected exactly 1.`,
    );
  }
  const requiredSigner = tx.message.staticAccountKeys[0];
  if (!requiredSigner || !requiredSigner.equals(signer.publicKey)) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
      "Refusing to sign: the transaction's sole required signer does not match the selected wallet.",
    );
  }
  if (tx.signatures.length !== 1 || !isZeroSignature(tx.signatures[0])) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
      "Refusing to sign: the transaction already carries a preserved signature — replacing the blockhash would invalidate it.",
    );
  }
  return 0;
}

/**
 * Co-signed check — see the module doc for why each clause exists. Returns the
 * index of OUR signature slot, the only slot this function will let us fill.
 *
 * `requiredSigners` is provider-controlled input: it is validated for shape
 * (non-empty base58 strings) and for content (exactly our wallet) before it is
 * allowed to influence anything.
 */
function assertCoSignedSlot(
  tx: VersionedTransaction,
  signer: Keypair,
  requiredSigners: readonly string[],
  knownBlockhash: KnownSolanaBlockhash | undefined,
): number {
  // The provider pre-signs the slots it owns; a blockhash rewrite would void
  // those signatures, so VERIFY mode is mandatory here, never a default.
  if (!knownBlockhash) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
      "Refusing to sign a co-signed transaction without blockhash evidence: rewriting the blockhash "
        + "would invalidate the provider's own signatures.",
    );
  }

  const ourKey = signer.publicKey.toBase58();
  if (requiredSigners.length !== 1 || requiredSigners[0] !== ourKey) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
      `Refusing to sign: the provider asked for ${requiredSigners.length} outstanding signature(s), `
        + "expected exactly the selected wallet's. Vex signs only its own key, and only when it is the "
        + "last signature the transaction is waiting for.",
    );
  }

  const { numRequiredSignatures } = tx.message.header;
  if (tx.signatures.length !== numRequiredSignatures) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
      "Refusing to sign: the transaction's signature slots do not match its required-signer count.",
    );
  }

  const signerBlock = tx.message.staticAccountKeys.slice(0, numRequiredSignatures);
  const matches = signerBlock.filter((key) => key.equals(signer.publicKey));
  if (matches.length !== 1) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
      `Refusing to sign: the selected wallet appears ${matches.length} times in the transaction's `
        + "required-signer list, expected exactly once.",
    );
  }
  const ourSlot = signerBlock.findIndex((key) => key.equals(signer.publicKey));

  if (!isZeroSignature(tx.signatures[ourSlot])) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
      "Refusing to sign: the selected wallet's signature slot is already filled.",
    );
  }
  return ourSlot;
}

/**
 * Post-condition: signing filled OUR slot and left every other slot exactly as
 * the provider sent it. Cheap, and it is the property the whole co-signed
 * contract rests on — never inferred from `signVersionedTx`'s behaviour.
 */
function assertOnlyOurSlotChanged(
  tx: VersionedTransaction,
  slotsBefore: readonly Uint8Array[],
  ourSlot: number,
): void {
  for (let i = 0; i < slotsBefore.length; i += 1) {
    const before = slotsBefore[i]!;
    const after = tx.signatures[i];
    const changed = !after || after.length !== before.length || after.some((byte, b) => byte !== before[b]);
    if (i === ourSlot) {
      if (!after || !changed || isZeroSignature(after)) {
        throw new VexError(
          ErrorCodes.SOLANA_TX_FAILED,
          "Signing did not fill the selected wallet's signature slot.",
        );
      }
      continue;
    }
    if (changed) {
      throw new VexError(
        ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
        `Refusing to submit: signing altered signature slot ${i}, which does not belong to the selected wallet.`,
      );
    }
  }
}

function isZeroSignature(sig: Uint8Array | undefined): boolean {
  if (!sig) return false;
  return sig.every((byte) => byte === 0);
}

function verifyKnownBlockhash(tx: VersionedTransaction, known: KnownSolanaBlockhash): KnownSolanaBlockhash {
  if (tx.message.recentBlockhash !== known.blockhash) {
    throw new VexError(
      ErrorCodes.SOLANA_TX_BLOCKHASH_MISMATCH,
      "Refusing to sign: the transaction's embedded blockhash does not match the provided evidence.",
    );
  }
  return known;
}

async function replaceWithFreshBlockhash(
  tx: VersionedTransaction,
  connection: Connection,
): Promise<KnownSolanaBlockhash> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  return { blockhash, lastValidBlockHeight };
}
