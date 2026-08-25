/**
 * The UNSIGNED Solana canonicalization seam. PUBLIC KEY ONLY. NEVER SIGNS.
 *
 * ## Why this exists as its own module
 *
 * The existing helper `tools/solana-ecosystem/shared/solana-transaction/
 * prepare.ts` takes a `Keypair`, and everything it does is arranged around
 * producing signed bytes. Prepare-time work has the opposite requirement: it
 * must decide exactly what will be signed, show it to the user, and hold no key
 * material at all while doing so. Passing a decrypted signer through the
 * approval path so it can be handed back later is the failure this module
 * exists to prevent, so the type it accepts is a `PublicKey`, and there is no
 * code path in it that could sign.
 *
 * ## Fresh blockhash BEFORE simulation and approval
 *
 * The blockhash is REPLACED here, before the preview is built and before the
 * user sees anything. Simulating and approving the caller's stale blockhash and
 * then rewriting it at signing time would mean the user approved a message that
 * was never the message signed. So the order is: verify shape, install a fresh
 * blockhash, serialize the canonical bytes, and only then simulate and preview.
 * Confirm later uses the existing helper's VERIFY path with this evidence -
 * in that helper, known evidence selects `verifyKnownBlockhash` and only
 * MISSING evidence rewrites.
 *
 * ## `lastValidBlockHeight` is the authority; the clock is a display cap
 *
 * The intent's displayed expiry is frozen at 60 seconds because a user needs a
 * number they can read. It is not the real bound: block height does not convert
 * to a timestamp, so confirm rechecks the CURRENT height against
 * `lastValidBlockHeight` regardless of what the clock says.
 */

import { PublicKey, VersionedMessage, VersionedTransaction } from "@solana/web3.js";

import { accept, refuse, type TransactionOutcome } from "./refusal.js";

/** The one chain read canonicalization performs. Faked in a line for tests. */
export interface SolanaBlockhashProvider {
  readonly getLatestBlockhash: () => Promise<{
    readonly blockhash: string;
    readonly lastValidBlockHeight: number;
  }>;
}

export interface CanonicalSolanaMessage {
  /** The message with the FRESH blockhash installed. Nothing downstream re-derives it. */
  readonly message: VersionedMessage;
  /** Canonical unsigned message bytes, base64. Confirm asserts these are unchanged. */
  readonly messageBase64: string;
  readonly feePayer: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
}

/** The displayed expiry cap. `lastValidBlockHeight` remains the real authority. */
export const SOLANA_INTENT_DISPLAY_TTL_MS = 60_000;

/**
 * Verify the sole-signer shape and the fee payer, install a fresh blockhash,
 * and return the canonical unsigned bytes.
 *
 * `selectedPublicKey` is the session's selected Solana wallet address. It is
 * host-supplied evidence, never a tool parameter: a caller-named fee payer is
 * exactly the redirect the forbidden-field gate refuses.
 */
export async function canonicalizeSolanaMessage(
  proposalBase64: string,
  selectedPublicKey: string,
  blockhashes: SolanaBlockhashProvider,
): Promise<TransactionOutcome<CanonicalSolanaMessage>> {
  const parsed = parseProposal(proposalBase64);
  if (!parsed.ok) return parsed;
  const message = parsed.value;

  // SOLE SIGNER. Vex signs for itself or not at all: a message requiring more
  // than one signature is either co-signed by a party this path never
  // negotiated with, or it is a multisig whose other signers we cannot show.
  const required = message.header.numRequiredSignatures;
  if (required !== 1) {
    return refuse(
      "unsupported_instruction",
      `Refusing to prepare: this message requires ${required} signatures. The generic Solana signing `
      + "path signs transactions where your wallet is the sole signer and the fee payer; a co-signed "
      + "or multisig message has parties this path cannot show you.",
      { requiredSignatures: String(required) },
    );
  }

  // FEE PAYER. Account 0 of a Solana message pays the fee, and the fee payer is
  // also the only required signer here, so the two checks are one check with two
  // reasons to fail.
  const feePayerKey = message.staticAccountKeys[0];
  if (feePayerKey === undefined) {
    return refuse(
      "invalid_input",
      "Refusing to prepare: the message names no accounts, so it has no fee payer.",
    );
  }
  const feePayer = feePayerKey.toBase58();
  let selected: PublicKey;
  try {
    selected = new PublicKey(selectedPublicKey);
  } catch {
    return refuse(
      "invalid_input",
      "Refusing to prepare: the session's selected Solana wallet address is not a valid public key.",
    );
  }
  if (!feePayerKey.equals(selected)) {
    return refuse(
      "forbidden_field",
      `Refusing to prepare: the message's fee payer is ${feePayer}, but the wallet selected for this `
      + `session is ${selected.toBase58()}. Vex signs only for the selected wallet; it does not `
      + "re-point a proposal at a different payer.",
      { feePayer, selectedWallet: selected.toBase58() },
    );
  }

  const { blockhash, lastValidBlockHeight } = await blockhashes.getLatestBlockhash();
  message.recentBlockhash = blockhash;

  return accept<CanonicalSolanaMessage>({
    message,
    messageBase64: Buffer.from(message.serialize()).toString("base64"),
    feePayer,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
  });
}

/**
 * Accept either a serialized VersionedTransaction (the shape a wallet adapter
 * or an agent SDK hands out, signature slots empty) or a bare serialized
 * message. Both are tried; a value that is neither refuses rather than being
 * coerced.
 *
 * A transaction arriving with signatures already filled is REFUSED: this path
 * replaces the blockhash, which invalidates any signature over the old bytes,
 * and silently discarding somebody else's signature is not something to do
 * quietly.
 */
function parseProposal(proposalBase64: string): TransactionOutcome<VersionedMessage> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(proposalBase64, "base64");
  } catch {
    return refuse("invalid_input", "Refusing to prepare: the proposal is not valid base64.");
  }
  if (bytes.length === 0) {
    return refuse("invalid_input", "Refusing to prepare: the proposal is empty.");
  }

  try {
    const tx = VersionedTransaction.deserialize(bytes);
    const signed = tx.signatures.filter((sig) => sig.some((byte) => byte !== 0));
    if (signed.length > 0) {
      return refuse(
        "invalid_input",
        "Refusing to prepare: the proposal already carries a signature. Preparing installs a fresh "
        + "blockhash, which invalidates any signature over the previous bytes, so an already-signed "
        + "transaction cannot be prepared without silently discarding that signature. Submit the "
        + "unsigned message instead.",
      );
    }
    return accept(tx.message);
  } catch {
    // Not a transaction envelope. Fall through to the bare-message reading.
  }

  try {
    return accept(VersionedMessage.deserialize(new Uint8Array(bytes)));
  } catch {
    return refuse(
      "invalid_input",
      "Refusing to prepare: the proposal is neither a serialized Solana transaction nor a serialized "
      + "transaction message.",
    );
  }
}
