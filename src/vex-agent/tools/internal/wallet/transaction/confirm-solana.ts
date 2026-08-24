/**
 * `WalletSolanaTransactionConfirm` - the call that signs and broadcasts.
 *
 * The Solana half of commit-time revalidation, in the order it must run:
 *
 *   a. CURRENT BLOCK HEIGHT against the intent's `lastValidBlockHeight`. This
 *      is the real expiry: block height has no timestamp, so the displayed 60 s
 *      cap is a readability aid and this check is the authority;
 *   b. the stored canonical message is DECODED AGAIN, which re-resolves every
 *      address lookup table - a table that became unreadable refuses here;
 *   c. the fresh decode must produce the effects the approval described;
 *   d. the message's OWN compute-budget instructions - the actual fee fields on
 *      this family - against the approved lamport ceiling;
 *   e. a fresh simulation of the exact canonical bytes;
 *   f. T2 claims the intent and writes both durable rows, then COMMITS;
 *   g. sign in VERIFY mode with the intent's own blockhash evidence, assert the
 *      MESSAGE BYTES ARE UNCHANGED (only the signature slot may differ), stage
 *      the signature with its evidence, and submit once.
 *
 * The signing helper is the repository's existing one: with known blockhash
 * evidence it VERIFIES rather than rewrites, which is exactly what a message
 * the user already approved requires.
 */

import { Keypair, VersionedMessage, VersionedTransaction } from "@solana/web3.js";

import type { SolanaWallet } from "@tools/wallet/multi-auth.js";
import { solanaExplorerUrl } from "@tools/solana-ecosystem/shared/solana-validation.js";
import type { SolanaTransactionPayload } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { summarizeWalletError } from "../send-types.js";

import type { TransactionActivity } from "./activity-writer.js";
import {
  defaultSolanaPrepareChainFactory,
  type SolanaPrepareChain,
  type SolanaPrepareChainFactory,
} from "./chain-seams.js";
import {
  claimOrRefuse,
  gateConfirm,
  settleExecution,
  type TransactionExecution,
} from "./confirm-shared.js";
import { decodeSolanaTransaction } from "./decode-solana.js";
import { assertQueriedSolanaMessageFee } from "./fee-bounds.js";
import {
  assertSolanaFeeBounds,
  revalidateDecodedEffects,
  revalidateMessageBytes,
  revalidateSolanaBlockHeight,
} from "./revalidate.js";
import { refusalToResult } from "./tool-io.js";

const SOLANA_CHAIN_SLUG = "solana";

/** The signed bytes plus the evidence that must be staged with them. */
export interface SignedSolanaTransaction {
  readonly signature: string;
  readonly serialized: Uint8Array;
  /** The MESSAGE the signed transaction carries, base64. Compared with the approved bytes. */
  readonly messageBase64: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
}

export type SolanaSubmitOutcomeKind =
  | "accepted"
  | "rejected_before_broadcast"
  | "transport_uncertain"
  | "signature_mismatch";

/**
 * Everything the confirm path does that touches a key or the network, behind
 * one seam, so the gates, the revalidation and the settlement above are all
 * provable with an object literal.
 */
export interface SolanaSigningPort {
  /** Sign in VERIFY mode against the intent's own blockhash evidence. Never rewrites it. */
  readonly sign: (input: {
    readonly messageBase64: string;
    readonly wallet: SolanaWallet;
    readonly recentBlockhash: string;
    readonly lastValidBlockHeight: number;
  }) => Promise<SignedSolanaTransaction>;
  /** Submit the exact signed bytes, ONCE. Never re-sent, on any outcome. */
  readonly submit: (prepared: SignedSolanaTransaction) => Promise<{
    readonly kind: SolanaSubmitOutcomeKind;
    readonly cause?: unknown;
  }>;
  /** Ask the chain whether the signature landed. A separate question from submission. */
  readonly confirm: (signature: string) => Promise<{
    readonly phase: "confirmed" | "chain_failed" | "confirmation_unknown";
    readonly errorKind?: string;
    readonly errorHash?: string;
  }>;
}

export interface SolanaConfirmDeps {
  readonly chainFactory: SolanaPrepareChainFactory;
  readonly signing: SolanaSigningPort;
}

export const defaultSolanaSigningPort: SolanaSigningPort = {
  sign: async ({ messageBase64, wallet, recentBlockhash, lastValidBlockHeight }) => {
    const { prepareVersionedTx } = await import(
      "@tools/solana-ecosystem/shared/solana-transaction.js"
    );
    const message = VersionedMessage.deserialize(
      new Uint8Array(Buffer.from(messageBase64, "base64")),
    );
    const unsigned = new VersionedTransaction(message);
    const prepared = await prepareVersionedTx(
      unsigned.serialize(),
      Keypair.fromSecretKey(wallet.secretKey),
      {
        // KNOWN EVIDENCE selects the VERIFY path in that helper: the
        // transaction's own blockhash must equal the one recorded on the
        // intent, and it is never replaced. Replacing it would sign bytes the
        // user never saw.
        knownBlockhash: { blockhash: recentBlockhash, lastValidBlockHeight },
        signerContract: { kind: "soleSigner" },
      },
    );
    const signedMessage = VersionedTransaction.deserialize(prepared.serialized).message;
    return {
      signature: prepared.signature,
      serialized: prepared.serialized,
      messageBase64: Buffer.from(signedMessage.serialize()).toString("base64"),
      recentBlockhash: prepared.recentBlockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    };
  },

  submit: async (prepared) => {
    const { submitPreparedTxOverRpc, getSolanaConnection } = await import(
      "@tools/solana-ecosystem/shared/solana-transaction.js"
    );
    // `maxRetries: 0`, and DELIBERATELY stricter than the transfer lane's 2.
    // That option is the RPC's own re-send of the same signed bytes, which is
    // not a second dispatch decision by Vex - but on a proposal Vex did not
    // build, the honest bound is zero re-sends of any kind. A transaction that
    // does not land is left unlanded: its blockhash expires and it becomes
    // unlandable, which is the fail-closed direction. Nothing here ever
    // re-broadcasts.
    const outcome = await submitPreparedTxOverRpc(
      {
        serialized: prepared.serialized,
        signature: prepared.signature,
        recentBlockhash: prepared.recentBlockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      },
      { connection: getSolanaConnection(), maxRetries: 0 },
    );
    return outcome.kind === "accepted"
      ? { kind: "accepted" }
      : { kind: outcome.kind, cause: "cause" in outcome ? outcome.cause : undefined };
  },

  confirm: async (signature) => {
    const { confirmStagedSignature, getSolanaConnection } = await import(
      "@tools/solana-ecosystem/shared/solana-transaction.js"
    );
    const result = await confirmStagedSignature(getSolanaConnection(), signature);
    return {
      phase: result.phase,
      ...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
      ...(result.errorHash === undefined ? {} : { errorHash: result.errorHash }),
    };
  },
};

const DEFAULT_DEPS: SolanaConfirmDeps = {
  chainFactory: defaultSolanaPrepareChainFactory,
  signing: defaultSolanaSigningPort,
};

export async function handleWalletSolanaTransactionConfirm(
  params: Record<string, unknown>,
  context: InternalToolContext,
  deps: SolanaConfirmDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  const gate = await gateConfirm(params, context, "solana");
  if (gate.kind === "return") return gate.result;
  const { intent, signer } = gate;
  if (signer.family !== "solana" || intent.payload.family !== "solana") {
    return refusalToResult({
      code: "invalid_input",
      message:
        `Refusing to sign: intent ${intent.intentId} is not a Solana intent. Nothing was signed.`,
      details: { intentId: intent.intentId },
    });
  }
  const payload: SolanaTransactionPayload = intent.payload.solana;
  const bounds = intent.feeBounds;
  if (bounds.mode !== "solana") {
    return refusalToResult({
      code: "invalid_input",
      message:
        `Refusing to sign: intent ${intent.intentId} carries EVM fee bounds on a Solana proposal, so `
        + "the caps that were approved cannot be enforced. Nothing was signed.",
      details: { intentId: intent.intentId },
    });
  }

  const chain = await deps.chainFactory();
  const revalidated = await revalidateSolanaAtCommit(intent, payload, chain);
  if (revalidated !== null) return revalidated;

  const claimed = await claimOrRefuse(intent);
  if (claimed.kind === "return") return claimed.result;

  const execution = await executeSolanaTransaction({
    intent,
    payload,
    wallet: signer,
    activity: claimed.claim.activity,
    deps,
  });

  return settleExecution(claimed.claim.intent, claimed.claim.activity, execution, {
    approvedFeeBounds: intent.feeBounds,
  });
}

/** Steps a to e. `null` means every check passed. */
async function revalidateSolanaAtCommit(
  intent: WalletTransactionIntent,
  payload: SolanaTransactionPayload,
  chain: SolanaPrepareChain,
): Promise<ToolResult | null> {
  const height = await chain.getBlockHeight();
  const heightCheck = revalidateSolanaBlockHeight(intent, height);
  if (!heightCheck.ok) return refusalToResult(heightCheck.refusal);

  let message: VersionedMessage;
  try {
    message = VersionedMessage.deserialize(
      new Uint8Array(Buffer.from(payload.messageBase64, "base64")),
    );
  } catch {
    return refusalToResult({
      code: "invalid_input",
      message:
        `Refusing to sign: the canonical message stored on intent ${intent.intentId} can no longer be `
        + "read as a Solana message. Nothing was signed. Prepare the transaction again.",
      details: { intentId: intent.intentId },
    });
  }

  // Re-decoding RE-RESOLVES every address lookup table, so a table that became
  // unreadable refuses here rather than being signed against a fraction of the
  // accounts it names.
  const decoded = await decodeSolanaTransaction(message, chain);
  if (!decoded.ok) return refusalToResult(decoded.refusal);

  const effects = revalidateDecodedEffects(intent, decoded.value);
  if (!effects.ok) return refusalToResult(effects.refusal);

  if (intent.feeBounds.mode === "solana") {
    const fees = assertSolanaFeeBounds(decoded.value, intent.feeBounds);
    if (!fees.ok) return refusalToResult(fees.refusal);

    // The EXACT network fee for these bytes, queried again immediately before
    // signing. This is the authorization basis for the base fee: it catches a
    // fee-schedule change since prepare, and refuses if the node cannot quote it
    // or the quote exceeds the authorized total. Nothing is claimed or signed
    // when it fails - the intent stays `pending`.
    const queriedFee = await chain.getMessageFee(payload.messageBase64);
    const feeOk = assertQueriedSolanaMessageFee(queriedFee, intent.feeBounds, "confirm");
    if (!feeOk.ok) return refusalToResult(feeOk.refusal);
  }

  const simulated = await chain.simulateMessage(payload.messageBase64);
  if (!simulated.ok) return refusalToResult(simulated.refusal);

  return null;
}

async function executeSolanaTransaction(args: {
  readonly intent: WalletTransactionIntent;
  readonly payload: SolanaTransactionPayload;
  readonly wallet: SolanaWallet;
  readonly activity: TransactionActivity;
  readonly deps: SolanaConfirmDeps;
}): Promise<TransactionExecution> {
  const { intent, payload, wallet, activity, deps } = args;

  // SIGN ONLY. Nothing has reached the network yet.
  let signed: SignedSolanaTransaction;
  try {
    signed = await deps.signing.sign({
      messageBase64: payload.messageBase64,
      wallet,
      recentBlockhash: intent.recentBlockhash ?? "",
      lastValidBlockHeight: intent.lastValidBlockHeight ?? 0,
    });
  } catch (cause) {
    return preBroadcast(
      cause,
      "The transaction could not be signed, so nothing reached the network and no funds moved. "
      + "Preparing it again is safe.",
    );
  }

  // THE BYTES THE USER APPROVED. Only the signature slot may differ, which is
  // why this compares the MESSAGE and never the transaction envelope.
  const unchanged = revalidateMessageBytes(intent, signed.messageBase64);
  if (!unchanged.ok) {
    logger.warn("wallet.transaction.solana_message_bytes_changed", { intentId: intent.intentId });
    return {
      kind: "pre_broadcast_failed",
      errorKind: "MessageBytesChanged",
      errorHash: "0000000000000000",
      message: unchanged.refusal.message,
    };
  }

  // STAGE the signature with the blockhash evidence the 049 CHECK requires. A
  // CAS miss means the durable record failed while the intent is already
  // `consuming`, which is exactly `audit_failed`. NOTHING has been submitted.
  try {
    await activity.stageSolana({
      signature: signed.signature,
      fromAddress: payload.feePayer,
      recentBlockhash: signed.recentBlockhash,
      lastValidBlockHeight: signed.lastValidBlockHeight,
    });
  } catch (cause) {
    return {
      ...preBroadcast(
        cause,
        "The durable record of this transaction could not be written, so Vex refused to broadcast it. "
        + "Nothing was broadcast and no funds moved. This is a Vex-side audit failure, not a chain "
        + "rejection.",
      ),
      auditFailed: true,
    };
  }

  const submitted = await deps.signing.submit(signed);

  if (submitted.kind === "rejected_before_broadcast") {
    // DEFINITIVE: the node parsed the bytes and refused them, so nothing
    // reached the network.
    return preBroadcast(
      submitted.cause,
      "The network refused this transaction before it was broadcast, so nothing was sent and no "
      + "funds moved.",
    );
  }

  if (submitted.kind === "transport_uncertain" || submitted.kind === "signature_mismatch") {
    // NOT DEFINITIVE, so NOTHING TERMINAL. The bytes may already be on the
    // network. The activity row keeps the signature we staged - the canonical
    // one for these bytes, never replaced by a divergent RPC echo - and the
    // repair lane owns its fate. Nothing is re-sent, ever.
    if (submitted.kind === "signature_mismatch") {
      logger.warn("wallet.transaction.solana_signature_mismatch", {
        intentId: intent.intentId,
        stagedSignature: signed.signature,
      });
    }
    const sum = summarizeWalletError(
      submitted.kind === "transport_uncertain"
        ? submitted.cause
        : new Error("Solana RPC echoed a signature that does not match the staged transaction."),
    );
    return {
      kind: "confirmation_unknown",
      txHash: signed.signature,
      chain: SOLANA_CHAIN_SLUG,
      errorKind: sum.errorKind,
      errorHash: sum.errorHash,
    };
  }

  await activity.noteAccepted();

  const settled = await deps.signing.confirm(signed.signature);

  if (settled.phase === "chain_failed") {
    return {
      kind: "chain_failed",
      txHash: signed.signature,
      chain: SOLANA_CHAIN_SLUG,
      errorKind: settled.errorKind ?? "Unknown",
      errorHash: settled.errorHash ?? "0000000000000000",
    };
  }

  if (settled.phase === "confirmation_unknown") {
    return {
      kind: "confirmation_unknown",
      txHash: signed.signature,
      chain: SOLANA_CHAIN_SLUG,
      errorKind: settled.errorKind ?? "Unknown",
      errorHash: settled.errorHash ?? "0000000000000000",
    };
  }

  return {
    kind: "confirmed",
    txHash: signed.signature,
    data: {
      txHash: signed.signature,
      chain: SOLANA_CHAIN_SLUG,
      status: "confirmed",
      explorerUrl: solanaExplorerUrl(signed.signature),
      _executionId: activity.executionId,
      _explorerRefs: [{ chain: SOLANA_CHAIN_SLUG, txRef: signed.signature }],
    },
  };
}

function preBroadcast(cause: unknown, message: string): Extract<
  TransactionExecution,
  { kind: "pre_broadcast_failed" }
> {
  const sum = summarizeWalletError(cause);
  return {
    kind: "pre_broadcast_failed",
    errorKind: sum.errorKind,
    errorHash: sum.errorHash,
    message: `${message} Error hash: ${sum.errorHash}.`,
  };
}
