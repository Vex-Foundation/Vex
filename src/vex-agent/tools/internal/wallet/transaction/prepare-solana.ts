/**
 * `WalletSolanaTransactionPrepare`. Signs nothing, holds no key, writes ONE
 * durable `wallet_transaction_intents` row.
 *
 * The Solana order differs from EVM's in one decisive way: CANONICALIZATION
 * COMES FIRST, and it installs a FRESH BLOCKHASH before anything is simulated,
 * previewed or approved. Approving the caller's stale blockhash and rewriting
 * it at signing time would mean the user approved a message that was never the
 * message signed, so the bytes are fixed here and confirm asserts they are
 * unchanged.
 *
 *  1. refuse caller-supplied redirect fields BY NAME;
 *  2. resolve the session's selected Solana PUBLIC KEY (no decrypt, ever);
 *  3. canonicalize: sole-signer and fee-payer verification, fresh blockhash,
 *     canonical message bytes plus `lastValidBlockHeight`;
 *  4. DECODE fail-closed, resolving address lookup tables FIRST;
 *  5. simulate the CANONICAL message;
 *  6. require the MANDATORY fee bounds;
 *  7. compute the versioned proposal digest;
 *  8. INSERT the intent (T1) with a 60 s DISPLAYED expiry.
 *
 * The 60 s expiry is a display cap, not the authority. Block height does not
 * convert to a timestamp, so `lastValidBlockHeight` is stored and confirm
 * rechecks the current height regardless of what the clock says.
 */

import { randomUUID } from "node:crypto";

import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../resolve.js";
import { ok } from "../send/results.js";

import {
  canonicalizeSolanaMessage,
  SOLANA_INTENT_DISPLAY_TTL_MS,
} from "./canonicalize-solana.js";
import {
  defaultSolanaPrepareChainFactory,
  type SolanaPrepareChainFactory,
} from "./chain-seams.js";
import { decodeSolanaTransaction } from "./decode-solana.js";
import {
  assertQueriedSolanaMessageFee,
  forbiddenRedirectFieldRefusal,
  parseSolanaFeeBounds,
} from "./fee-bounds.js";
import { canonicalTransactionPreview } from "./preview.js";
import { computeProposalDigest } from "./proposal-digest.js";
import { refusalToResult, requireString } from "./tool-io.js";

export interface SolanaPrepareDeps {
  readonly chainFactory: SolanaPrepareChainFactory;
}

const DEFAULT_DEPS: SolanaPrepareDeps = { chainFactory: defaultSolanaPrepareChainFactory };

export async function handleWalletSolanaTransactionPrepare(
  params: Record<string, unknown>,
  context: InternalToolContext,
  deps: SolanaPrepareDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  const forbidden = forbiddenRedirectFieldRefusal(params);
  if (forbidden !== null) return refusalToResult(forbidden);

  const proposal = requireString(params, "transactionBase64");
  if (!proposal.ok) return refusalToResult(proposal.refusal);

  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "solana");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const chain = await deps.chainFactory();

  // 3. Fresh blockhash BEFORE simulation and approval. Public key only.
  const canonical = await canonicalizeSolanaMessage(proposal.value, walletAddress, chain);
  if (!canonical.ok) return refusalToResult(canonical.refusal);

  // 4. Decode the CANONICAL message. ALTs resolve before program and account
  // verification, so nothing is verified against a fraction of the accounts.
  const decoded = await decodeSolanaTransaction(canonical.value.message, chain);
  if (!decoded.ok) return refusalToResult(decoded.refusal);

  // 5. Simulate the exact bytes that were canonicalized.
  const simulated = await chain.simulateMessage(canonical.value.messageBase64);
  if (!simulated.ok) return refusalToResult(simulated.refusal);

  // 6. MANDATORY bounds. The estimate only labels the refusal.
  const feeBounds = parseSolanaFeeBounds(
    params,
    canonical.value.message.header.numRequiredSignatures,
    await chain.estimateFees(),
  );
  if (!feeBounds.ok) return refusalToResult(feeBounds.refusal);

  // 6b. The EXACT network fee for these canonical bytes, queried now. Refuse to
  // prepare an intent whose real fee already exceeds the caps the caller set,
  // rather than discovering it only at signing time. The queried fee is the
  // authorization basis for the base fee, not the per-signature constant.
  const preparedFee = await chain.getMessageFee(canonical.value.messageBase64);
  const preparedFeeOk = assertQueriedSolanaMessageFee(preparedFee, feeBounds.value, "prepare");
  if (!preparedFeeOk.ok) return refusalToResult(preparedFeeOk.refusal);

  const intentId = `wtx-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + SOLANA_INTENT_DISPLAY_TTL_MS).toISOString();
  const preview = canonicalTransactionPreview({
    family: "solana",
    chainAlias: null,
    decoded: decoded.value,
    feeBounds: feeBounds.value,
    // Solana charges no Vex fee on this lane (migration 088 binds `tx_vex_fee`
    // to eip155), so there is no fee section to render and no base for one.
    evmValueWei: null,
  });

  const digest = computeProposalDigest({
    intentId,
    family: "solana",
    walletAddress,
    chainAlias: null,
    chainId: null,
    payload: {
      messageBase64: canonical.value.messageBase64,
      feePayer: canonical.value.feePayer,
    },
    decoded: decoded.value,
    feeBounds: feeBounds.value,
    recentBlockhash: canonical.value.recentBlockhash,
    lastValidBlockHeight: canonical.value.lastValidBlockHeight,
    expiresAt,
  });

  await withSessionControlLock(context.sessionId, (client) =>
    intentsRepo.createWith(client, {
      intentId,
      sessionId: context.sessionId,
      walletAddress,
      family: "solana",
      chainAlias: null,
      chainId: null,
      payload: {
        family: "solana",
        solana: {
          messageBase64: canonical.value.messageBase64,
          feePayer: canonical.value.feePayer,
        },
      },
      decoded: decoded.value,
      preview,
      feeBounds: feeBounds.value,
      proposalDigest: digest.digest,
      proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
      recentBlockhash: canonical.value.recentBlockhash,
      lastValidBlockHeight: canonical.value.lastValidBlockHeight,
      expiresAt,
    }),
  );

  return ok({
    intentId,
    walletFamily: "solana",
    walletAddress,
    feePayer: canonical.value.feePayer,
    status: "prepared",
    // The DISPLAYED bound. `lastValidBlockHeight` below is the real one.
    expiresAt,
    expiryNote:
      "This displayed expiry is a 60 second cap for readability. The real bound is "
      + "lastValidBlockHeight: confirm rechecks the current block height against it before signing, "
      + "whatever the clock says.",
    recentBlockhash: canonical.value.recentBlockhash,
    lastValidBlockHeight: canonical.value.lastValidBlockHeight,
    // The bytes that were canonicalized here are the bytes confirm asserts are
    // unchanged, so the caller can hold them and compare too.
    canonicalMessageBase64: canonical.value.messageBase64,
    preview,
    decoded: decoded.value,
    approvedFeeBounds: feeBounds.value,
    message:
      "Prepared with a fresh blockhash. Nothing was signed and nothing was spent. Confirm with "
      + "WalletSolanaTransactionConfirm to broadcast it.",
  });
}
