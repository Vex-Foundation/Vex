/**
 * COMMIT-TIME REVALIDATION - spec item 7, the checklist that runs immediately
 * before the consume/sign boundary and refuses BY NAME with nothing signed.
 *
 * ## Why any of this is needed after the approval gate
 *
 * The A3 approval gate commits BEFORE the handler is dispatched. Everything it
 * proved is therefore a statement about the past: the wallet selection may have
 * moved, the chain may have been re-registered under a different id, a Solana
 * blockhash may have expired, and the intent row itself is external input that
 * crossed persistence. So the whole authority chain is re-established here, at
 * the last moment where refusing still costs nothing.
 *
 * ## The checklist, in the order it runs and the reason for the order
 *
 *   1. the intent exists, is owned by THIS session, is `pending` and unexpired;
 *   2. its digest VERSION is one this build computes (an unknown version is
 *      refused as such, never reported as proposal drift);
 *   3. the digest RECOMPUTED from the row's own stored fields equals the stored
 *      digest - the row has not been edited underneath the proposal;
 *   4. the APPROVAL-BOUND digest equals it too, when this dispatch is the resume
 *      of an approval: what the human approved, not what currently sits beside
 *      the row;
 *   5. the authoritative CURRENT session wallet - resolved and decrypted here,
 *      after the approval gate - matches the intent's family and address;
 *   6. per family: chain identity and code-at-target (EVM), block height and
 *      lookup-table resolution (Solana);
 *   7. the effects DECODED AGAIN from the payload are byte-identical in meaning
 *      to the ones the user approved, proven by recomputing the digest over the
 *      FRESH decode;
 *   8. a fresh simulation against current chain state.
 *
 * Steps 3 and 7 are the same computation over different inputs, and both are
 * run on purpose: step 3 says the ROW is intact, step 7 says the WORLD still
 * decodes it the way the approval card described. A single check would confuse
 * "somebody edited the row" with "the chain changed underneath it", and those
 * have different operator responses.
 *
 * The ACTUAL fee fields are NOT checked here. They do not exist yet: they are
 * produced by preparing the exact request, which happens inside the signing
 * primitive. EVM enforces them through `signStageBroadcast`'s `bounds`
 * parameter; Solana enforces them here in {@link assertSolanaFeeBounds}, where
 * the message's own compute-budget instructions ARE the actual fields.
 *
 * Nothing in this module signs, claims, writes or broadcasts. It reads, it
 * compares, and it returns a refusal or a go-ahead.
 */

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { walletAddressesEqual } from "@tools/wallet/inventory.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import type {
  DecodedWalletTransaction,
  SolanaFeeBounds,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";

import { computeProposalDigest, type ProposalDigestInput } from "./proposal-digest.js";
import { accept, refuse, type TransactionOutcome } from "./refusal.js";

/** The payload as the digest preimage spells it: string values only. */
function payloadOf(intent: WalletTransactionIntent): Readonly<Record<string, string>> {
  return intent.payload.family === "eip155"
    ? {
        to: intent.payload.evm.to.toLowerCase(),
        data: intent.payload.evm.data.toLowerCase(),
        valueWei: intent.payload.evm.valueWei,
      }
    : {
        messageBase64: intent.payload.solana.messageBase64,
        feePayer: intent.payload.solana.feePayer,
      };
}

/**
 * The digest this build computes for a row, optionally with a FRESHLY decoded
 * effect set in place of the stored one. Exported so a test can prove the two
 * inputs differ only in that field.
 */
export function digestOfIntent(
  intent: WalletTransactionIntent,
  decoded: DecodedWalletTransaction = intent.decoded,
): string {
  const input: ProposalDigestInput = {
    intentId: intent.intentId,
    family: intent.family,
    walletAddress: intent.walletAddress,
    chainAlias: intent.chainAlias,
    chainId: intent.chainId,
    payload: payloadOf(intent),
    decoded,
    feeBounds: intent.feeBounds,
    recentBlockhash: intent.recentBlockhash,
    lastValidBlockHeight: intent.lastValidBlockHeight,
    expiresAt: intent.expiresAt,
  };
  return computeProposalDigest(input).digest;
}

// ── Steps 1-4: the row, its digest, and the approval it is bound to ────

/**
 * Steps 1 to 4. `approvalBoundDigest` is the digest recorded on the approval
 * this dispatch resumes, or `null` when the call is not an approved resume
 * (a full-permission session signs without an approval row, and there is then
 * no second digest to compare against - the row's own integrity check in step 3
 * still runs).
 */
export function revalidateIntentRow(
  intent: WalletTransactionIntent,
  approvalBoundDigest: string | null,
  now: Date = new Date(),
): TransactionOutcome<void> {
  if (intent.proposalDigestVersion !== PROPOSAL_DIGEST_VERSION) {
    return refuse(
      "invalid_input",
      `Refusing to sign: intent ${intent.intentId} carries proposal digest version `
      + `"${intent.proposalDigestVersion}", and this build computes "${PROPOSAL_DIGEST_VERSION}". A `
      + "digest from a different serialization cannot be compared, so this is refused rather than "
      + "reported as proposal drift. Nothing was signed. Prepare the transaction again on this build.",
      { intentId: intent.intentId, storedVersion: intent.proposalDigestVersion },
    );
  }

  if (intent.status !== "pending") {
    return refuse(
      "invalid_input",
      `Refusing to sign: intent ${intent.intentId} is ${intent.status}, and only a pending intent may `
      + "be confirmed. Nothing was signed and no funds moved.",
      { intentId: intent.intentId, status: intent.status },
    );
  }

  if (new Date(intent.expiresAt) <= now) {
    return refuse(
      "invalid_input",
      `Refusing to sign: intent ${intent.intentId} expired at ${intent.expiresAt}. Prepare the `
      + "transaction again to review current chain state and fees. Nothing was signed.",
      { intentId: intent.intentId, expiresAt: intent.expiresAt },
    );
  }

  const recomputed = digestOfIntent(intent);
  if (recomputed !== intent.proposalDigest) {
    return refuse(
      "invalid_input",
      `Refusing to sign: the proposal digest recomputed from intent ${intent.intentId}'s own stored `
      + "fields does not match the digest stored beside them, so the row was changed after it was "
      + "prepared. Nothing was signed and no funds moved. Prepare the transaction again.",
      { intentId: intent.intentId },
    );
  }

  if (approvalBoundDigest !== null && approvalBoundDigest !== intent.proposalDigest) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the proposal this approval was granted for is not the proposal on this "
      + `intent. The approval is bound to the exact transaction the user read, so intent `
      + `${intent.intentId} cannot be signed under it. Nothing was signed and no funds moved. Prepare `
      + "the transaction again and request a fresh approval.",
      { intentId: intent.intentId },
    );
  }

  return accept(undefined);
}

// ── Step 5: the authoritative current wallet ───────────────────────────

/**
 * Step 5. The signer resolved from the session RIGHT NOW must be the wallet the
 * intent was prepared against, on the right family.
 *
 * A mismatch fails closed WITHOUT mutating the intent: it is still `pending`,
 * it expires on its own, and the user can select the original wallet and
 * confirm, or cancel. Signing from a different address is the one thing that
 * must never happen quietly.
 */
/**
 * The ADDRESS half of the signer check, provable WITHOUT decrypting anything.
 *
 * Split out so the gate can prove "this session's selection is the approved
 * wallet" before any key material exists, and `revalidateSigner` can re-prove
 * the same fact about the key it actually loaded. Both call it, so the two can
 * never state different rules.
 */
export function revalidateSignerAddress(
  intent: WalletTransactionIntent,
  address: string,
): TransactionOutcome<void> {
  const inventoryFamily = intent.family === "solana" ? "solana" : "evm";
  if (!walletAddressesEqual(inventoryFamily, address, intent.walletAddress)) {
    return refuse(
      "forbidden_field",
      "Refusing to sign: the wallet selected for this session is not the wallet this transaction was "
      + "prepared for, so signing it would send the transaction from an address the user never "
      + "approved. Nothing was signed and no funds moved. Select the original wallet and confirm "
      + "again, or prepare the transaction anew.",
      { intentId: intent.intentId, preparedFor: intent.walletAddress },
    );
  }
  return accept(undefined);
}

export function revalidateSigner(
  intent: WalletTransactionIntent,
  signer: ChainWallet,
): TransactionOutcome<void> {
  if (signer.family !== intent.family) {
    return refuse(
      "invalid_input",
      `Refusing to sign: this session's selected wallet is a ${signer.family} wallet and intent `
      + `${intent.intentId} was prepared for ${intent.family}. Nothing was signed.`,
      { intentId: intent.intentId, expectedFamily: intent.family },
    );
  }
  return revalidateSignerAddress(intent, signer.address);
}

// ── Step 6/7: chain identity and the fresh decode ──────────────────────

/** Step 6, EVM half. The chain a name resolves to today must be the one approved. */
export function revalidateEvmChainIdentity(
  intent: WalletTransactionIntent,
  current: { readonly chainId: number; readonly chainAlias: string },
): TransactionOutcome<void> {
  if (current.chainId !== intent.chainId || current.chainAlias !== intent.chainAlias) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the chain this intent names no longer resolves to the chain it was prepared "
      + `on (approved chain id ${String(intent.chainId)}, current ${String(current.chainId)}). Nothing `
      + "was signed. Prepare the transaction again.",
      {
        intentId: intent.intentId,
        approvedChainId: String(intent.chainId),
        currentChainId: String(current.chainId),
      },
    );
  }
  return accept(undefined);
}

/**
 * Step 7. The freshly decoded effects must mean exactly what the approved ones
 * meant, proven by recomputing the digest over them.
 *
 * A digest comparison rather than a field-by-field walk on purpose: the digest
 * is already the canonical serialization of the decode, so a new decoder field
 * is covered the day it is added instead of the day somebody remembers to add
 * it to a comparison list.
 */
export function revalidateDecodedEffects(
  intent: WalletTransactionIntent,
  freshlyDecoded: DecodedWalletTransaction,
): TransactionOutcome<void> {
  if (digestOfIntent(intent, freshlyDecoded) !== intent.proposalDigest) {
    return refuse(
      "invalid_input",
      "Refusing to sign: decoding this transaction against current chain state produces different "
      + "effects from the ones the approval described, so what would be signed is not what was "
      + "approved. Nothing was signed and no funds moved. Prepare the transaction again and read the "
      + "new preview.",
      { intentId: intent.intentId },
    );
  }
  return accept(undefined);
}

// ── Step 6, Solana half: the height that is the real expiry ────────────

/** Step 6, Solana. `lastValidBlockHeight` is the authority; the clock is a display cap. */
export function revalidateSolanaBlockHeight(
  intent: WalletTransactionIntent,
  currentBlockHeight: number,
): TransactionOutcome<void> {
  const lastValid = intent.lastValidBlockHeight;
  if (lastValid === null) {
    return refuse(
      "invalid_input",
      `Refusing to sign: Solana intent ${intent.intentId} carries no lastValidBlockHeight, so its `
      + "blockhash cannot be proven current. Nothing was signed. Prepare the transaction again.",
      { intentId: intent.intentId },
    );
  }
  if (currentBlockHeight > lastValid) {
    return refuse(
      "invalid_input",
      `Refusing to sign: this transaction's blockhash is no longer valid (current block height `
      + `${String(currentBlockHeight)} is past the last valid height ${String(lastValid)}), so the `
      + "network would reject it. Nothing was signed and no fee was paid. Prepare the transaction "
      + "again to get a fresh blockhash.",
      {
        intentId: intent.intentId,
        currentBlockHeight: String(currentBlockHeight),
        lastValidBlockHeight: String(lastValid),
      },
    );
  }
  return accept(undefined);
}

/**
 * The canonical message bytes that will be signed must be the bytes that were
 * approved. Only the signature slot may differ, which is why this compares the
 * MESSAGE and never the transaction envelope.
 */
export function revalidateMessageBytes(
  intent: WalletTransactionIntent,
  actualMessageBase64: string,
): TransactionOutcome<void> {
  if (intent.payload.family !== "solana") {
    return refuse(
      "invalid_input",
      `Refusing to sign: intent ${intent.intentId} is not a Solana intent.`,
      { intentId: intent.intentId },
    );
  }
  if (actualMessageBase64 !== intent.payload.solana.messageBase64) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the message bytes about to be signed are not the bytes that were approved. "
      + "Only the signature slot may differ between the approved message and the signed one. Nothing "
      + "was broadcast. Prepare the transaction again.",
      { intentId: intent.intentId },
    );
  }
  return accept(undefined);
}

// ── The ACTUAL Solana fee fields against the approved caps ─────────────

const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/**
 * The message's OWN compute-budget instructions are the actual fee fields on
 * this family, so they are checked against the approved caps here rather than
 * inside a signing primitive.
 *
 * THE ABSENT-LIMIT CASE IS REFUSED WHEN A PRICE IS SET, and that is the whole
 * subtlety: the priority fee is `price * limit`, and with no explicit limit the
 * runtime supplies a default this code would have to assume. Assuming it would
 * mean authorizing a number nobody computed, so a priced message without an
 * explicit compute-unit limit is refused by name instead.
 */
export function assertSolanaFeeBounds(
  decoded: Extract<DecodedWalletTransaction, { family: "solana" }>,
  bounds: SolanaFeeBounds,
): TransactionOutcome<void> {
  let actualLimit: bigint | null = null;
  let actualPrice = 0n;
  for (const instruction of decoded.instructions) {
    if (instruction.program !== "compute_budget") continue;
    const limit = instruction.criticalArgs.computeUnitLimit;
    const price = instruction.criticalArgs.computeUnitPriceMicroLamports;
    if (limit !== undefined) actualLimit = BigInt(limit);
    if (price !== undefined) actualPrice = BigInt(price);
  }

  const boundLimit = BigInt(bounds.computeUnitLimit);
  const boundPrice = BigInt(bounds.computeUnitPriceMicroLamports);

  if (actualPrice > boundPrice) {
    return refuse(
      "invalid_input",
      `Refusing to sign: this transaction sets a priority price of ${actualPrice.toString()} `
      + `micro-lamports per compute unit, above the ${boundPrice.toString()} that was authorized. `
      + "Nothing was signed and no fee was paid.",
      {
        actualComputeUnitPriceMicroLamports: actualPrice.toString(),
        approvedComputeUnitPriceMicroLamports: boundPrice.toString(),
      },
    );
  }
  if (actualLimit !== null && actualLimit > boundLimit) {
    return refuse(
      "invalid_input",
      `Refusing to sign: this transaction requests ${actualLimit.toString()} compute units, above the `
      + `${boundLimit.toString()} that was authorized. The priority fee is charged on the REQUESTED `
      + "limit, so this would cost more than was approved. Nothing was signed and no fee was paid.",
      {
        actualComputeUnitLimit: actualLimit.toString(),
        approvedComputeUnitLimit: boundLimit.toString(),
      },
    );
  }
  if (actualLimit === null && actualPrice > 0n) {
    return refuse(
      "invalid_input",
      "Refusing to sign: this transaction sets a priority price but no explicit compute-unit limit, "
      + "so the priority fee it would pay depends on a runtime default rather than on anything that "
      + "was authorized. Nothing was signed. Prepare a message that sets its compute-unit limit "
      + "explicitly.",
    );
  }

  // Ceiling division in integers: the runtime rounds the micro-lamport product
  // UP to whole lamports, and a ceiling that rounded down would be one the
  // actual charge exceeds by a lamport on most transactions.
  const effectiveLimit = actualLimit ?? boundLimit;
  const priority =
    (effectiveLimit * actualPrice + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
  const total = BigInt(bounds.baseFeeLamports) + priority;
  const boundTotal = BigInt(bounds.maxTotalFeeLamports);
  if (total > boundTotal) {
    return refuse(
      "invalid_input",
      `Refusing to sign: the maximum fee this transaction can pay is ${total.toString()} lamports, `
      + `above the ${boundTotal.toString()} that was authorized. Nothing was signed and no fee was `
      + "paid.",
      { actualMaxTotalFeeLamports: total.toString(), approvedMaxTotalFeeLamports: boundTotal.toString() },
    );
  }
  return accept(undefined);
}
