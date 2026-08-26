/**
 * Wallet send - Solana executor.
 *
 * Inlines the validation + tx-build that previously lived in
 * `sendSol` / `sendSplToken` (`src/tools/solana-ecosystem/shared/solana-transfer.ts`)
 * so the broadcast/confirm split is visible to this caller. The shared
 * helpers stay untouched for Jupiter swap + other consumers.
 *
 * STAGED SINCE MIGRATION 084, and the amount arithmetic is EXACT. Two changes,
 * both of them corrections:
 *
 *   1. Signing and submitting are SPLIT (`prepareLegacyTx` then
 *      `submitPreparedLegacyTxStaged`), so the durable `agent_activity` row
 *      carries the signature AND the blockhash evidence BEFORE the funds can
 *      move. `signAndSubmitLegacyTxStaged` did both in one step, leaving a
 *      window in which a crash meant money moved against a hashless row.
 *   2. The atomic amount is derived ONCE with exact decimal arithmetic
 *      (`parseUnits`) instead of `BigInt(Math.round(Number(amount) * 10 ** d))`.
 *      That expression routed a token amount through a float: it rounds
 *      silently, and above 2^53 atomic units - one SOL is 10^9, a 9-decimal SPL
 *      balance reaches it easily - it loses precision outright. The same bigint
 *      now feeds the transaction and the activity row, so the two cannot
 *      disagree about how much money moved.
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import { formatUnits, parseUnits } from "viem";

import type { SolanaWallet } from "@tools/wallet/multi-auth.js";
import {
  getSolanaConnection,
  prepareLegacyTx,
  submitPreparedTxOverRpc,
  confirmStagedSignature,
} from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { solanaExplorerUrl } from "@tools/solana-ecosystem/shared/solana-validation.js";
import { resolveJupiterToken } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import { SOL_DECIMALS, SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
// The repo-canonical synthetic id every Solana `agent_activity` row carries. The
// 049 `agent_activity_kind_family_binding` CHECK is written against this value,
// so a locally-invented literal (101, Solana's cluster id) would file transfers
// under a chain nothing else in this database uses.
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";

import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";
import logger from "@utils/logger.js";

import {
  preBroadcastFailed,
  summarizeWalletError,
  type ExecuteOutcome,
} from "./send-types.js";
import {
  openWalletTransferActivity,
  recordWalletTransferPlanFailure,
  type WalletTransferActivity,
  type WalletTransferPlan,
} from "./send/activity-writer.js";

const SOLANA_CHAIN_SLUG = "solana";

async function safeResolveSolanaToken(
  token: string,
): Promise<{ address: string; symbol: string; decimals: number } | undefined> {
  try {
    return await resolveJupiterToken(token);
  } catch {
    // resolveJupiterToken throws if JUPITER_API_KEY missing.
    return undefined;
  }
}

export async function executeSolanaTransfer(
  intent: WalletIntent,
  wallet: SolanaWallet,
): Promise<ExecuteOutcome> {
  const resolved = await resolveSolanaTransferPlan(intent, wallet);
  if (!resolved.ok) {
    // No intent row exists yet, so this is the ONE arm that writes a hashless
    // terminal row. Nothing was signed and nothing was sent.
    await recordWalletTransferPlanFailure(intent, {
      failureCode: resolved.failureCode,
      failureReason: resolved.failureReason,
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      chainFamily: "solana",
    });
    return preBroadcastFailed(resolved.cause);
  }

  const { plan, transaction, keypair, connection } = resolved;

  // The durable row BEFORE anything is signed.
  let activity: WalletTransferActivity;
  try {
    activity = await openWalletTransferActivity(intent, plan);
  } catch (cause) {
    logger.warn("wallet.send.activity_intent_write_failed", {
      intentId: intent.intentId, ...summarizeWalletError(cause),
    });
    return preBroadcastFailed(cause);
  }

  // SIGN ONLY. Nothing has reached the network yet.
  let prepared;
  try {
    prepared = await prepareLegacyTx(transaction, keypair, { connection });
  } catch (cause) {
    const sum = summarizeWalletError(cause);
    await activity.completeExecution({ kind: "failed_before_broadcast" });
    await activity.fail({
      failureCode: "broadcast_error",
      failureReason: `PreSign:${sum.errorKind}:${sum.errorHash}`,
    });
    return preBroadcastFailed(cause);
  }

  // STAGE the signature together with the blockhash evidence the 049
  // `agent_activity_solana_staged_has_evidence` CHECK requires. A CAS miss
  // throws, and NOTHING has been submitted at that point.
  try {
    await activity.stageSolana({
      signature: prepared.signature,
      fromAddress: keypair.publicKey.toBase58(),
      recentBlockhash: prepared.recentBlockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  } catch (cause) {
    const sum = summarizeWalletError(cause);
    await activity.completeExecution({ kind: "failed_before_broadcast" });
    await activity.fail({
      failureCode: "broadcast_error",
      failureReason: `SignedNotBroadcast:${sum.errorKind}:${sum.errorHash}`,
    });
    return preBroadcastFailed(cause);
  }

  // SUBMIT the exact signed bytes, once, through the CLASSIFYING lane.
  //
  // `submitPreparedLegacyTxStaged` reports every send throw as pre-broadcast,
  // which is true for a preflight rejection and FALSE for a socket timeout after
  // the node already took the bytes. Terminalizing that second case would fail
  // the activity row, complete the execution, and hand back a hashless
  // `pre_broadcast_failed` while the staged signature was still landing - money
  // gates clearing on a transfer that in fact went through.
  //
  // `submitPreparedTxOverRpc` is the repository's existing owner of exactly this
  // distinction (`solana-landing-lanes-design.md` D2/D4): a `SendTransactionError`
  // means the node ANSWERED and refused, anything else is ambiguous, and it also
  // validates the RPC's echoed signature against the one we staged. Reused
  // rather than mirrored, so the classification cannot drift in two places.
  //
  // `maxRetries: 2` PRESERVES this lane's pre-existing submit bound. Adopting
  // the shared classifier must not silently expand retry semantics on a money
  // path; the classifier's own omitted-default stays for protocol lanes.
  const submitOutcome = await submitPreparedTxOverRpc(prepared, { connection, maxRetries: 2 });

  if (submitOutcome.kind === "rejected_before_broadcast") {
    // DEFINITIVE. The node parsed the bytes and refused them (preflight,
    // simulation, or signature verification), so nothing reached the network.
    const sum = summarizeWalletError(submitOutcome.cause);
    await activity.completeExecution({ kind: "failed_before_broadcast" });
    await activity.failSignedNotSubmitted({
      failureReason: `SubmitRejected:${sum.errorKind}:${sum.errorHash}`,
    });
    return preBroadcastFailed(submitOutcome.cause);
  }

  if (submitOutcome.kind === "transport_uncertain" || submitOutcome.kind === "signature_mismatch") {
    // NOT DEFINITIVE, so NOTHING TERMINAL. The bytes may already be on the
    // network. The activity row stays `pending` carrying the signature we staged
    // - which is the canonical one for these bytes, never replaced by a
    // divergent RPC echo - and the repair sweep owns its fate. The execution
    // attempt is completed so the compaction gate is not blocked forever
    // (finding 2b). Nothing is re-sent, ever.
    if (submitOutcome.kind === "signature_mismatch") {
      logger.warn("wallet.send.solana_signature_mismatch", {
        rowId: activity.rowId,
        // The staged (canonical) signature only. The provider's divergent value
        // is deliberately not persisted anywhere it could be mistaken for truth.
        stagedSignature: submitOutcome.localSignature,
      });
    }
    const sum = summarizeWalletError(
      submitOutcome.kind === "transport_uncertain"
        ? submitOutcome.cause
        : new Error("Solana RPC echoed a signature that does not match the staged transaction."),
    );
    await activity.completeExecution({
      kind: "confirmation_unknown",
      txHash: prepared.signature,
    });
    return {
      kind: "confirmation_unknown",
      txHash: prepared.signature,
      chain: SOLANA_CHAIN_SLUG,
      errorKind: sum.errorKind,
      errorHash: sum.errorHash,
    };
  }

  await activity.noteAccepted();

  // Accepted by the node. Confirmation is a SEPARATE question, answered by the
  // shared confirm-only classifier so this lane reports the same vocabulary as
  // `signAndSubmitLegacyTxStaged`.
  const submission = await confirmStagedSignature(connection, prepared.signature);

  if (submission.phase === "chain_failed") {
    await activity.completeExecution({ kind: "reverted", txHash: submission.signature });
    await activity.fail({
      failureCode: "mined_revert",
      failureReason: "the transfer transaction failed on-chain",
    });
    return {
      kind: "chain_failed",
      txHash: submission.signature,
      chain: SOLANA_CHAIN_SLUG,
      errorKind: submission.errorKind ?? "Unknown",
      errorHash: submission.errorHash ?? "0000000000000000",
    };
  }

  if (submission.phase === "confirmation_unknown") {
    // NOTHING TERMINAL. The transaction may be settling right now, and the row
    // is already staged with the blockhash evidence the repair sweep needs to
    // resolve it. Nothing is re-sent, ever.
    //
    // The EXECUTION attempt is completed all the same (finding 2b): the tool is
    // returning, and an `execution_status = 'intent'` row is selected by the
    // compaction safe-moment gate on its own, so leaving it open would block
    // compaction even after the sweep resolved the activity row.
    await activity.completeExecution({
      kind: "confirmation_unknown",
      txHash: submission.signature,
    });
    return {
      kind: "confirmation_unknown",
      txHash: submission.signature,
      chain: SOLANA_CHAIN_SLUG,
      errorKind: submission.errorKind ?? "Unknown",
      errorHash: submission.errorHash ?? "0000000000000000",
    };
  }

  // Confirmation PROVES the amount on this family: `SystemProgram.transfer`
  // debits exactly its `lamports`, and `transferChecked` moves exactly its
  // amount and additionally verifies the mint's decimals on-chain - neither can
  // succeed having moved something else. That is why no log decoding is needed
  // here, unlike the EVM ERC-20 path, where `transfer` returns a `bool` a token
  // may set to `false` without reverting.
  //
  // No `settled_block_time` is written on this family: the Solana confirm
  // helper reports success without a slot, so there is no block to read a time
  // from here. A missing block time is the normal state that module documents,
  // and it degrades a later report's precision rather than any money fact -
  // reporting an OBSERVATION time as a settlement time is the thing that must
  // not happen, and this avoids it.
  await activity.completeExecution({ kind: "confirmed", txHash: submission.signature });
  await activity.confirm({ txHash: submission.signature, provenAmountRaw: plan.amountRaw });

  return {
    kind: "confirmed",
    txHash: submission.signature,
    data: {
      // Curated, cross-network-normalised projection (see formatWalletSendOutput
      // in send/finalize.ts): emit `txHash` (not the Solana-only `signature`),
      // `chain`, `status`, and `explorerUrl`.
      txHash: submission.signature,
      chain: SOLANA_CHAIN_SLUG,
      status: "confirmed",
      explorerUrl: solanaExplorerUrl(submission.signature),
      // The durable record of this transfer is its own `agent_activity` row
      // (migration 084). `_executionId` names the `protocol_executions` row this
      // path already opened AND completed itself - the internal tool route never
      // reaches `protocols/runtime/capture.ts`, which is why the writer owns
      // that completion. It rides here for correlation.
      _executionId: activity.executionId,
      // The explorer link, through the EXPLICIT channel the failure arms
      // already use - replacing the `_tradeCapture` blob whose comment claimed
      // it fed a sync/activity pipeline that never ran on the internal route.
      _explorerRefs: [{ chain: SOLANA_CHAIN_SLUG, txRef: submission.signature }],
    },
  };
}

type ResolvedSolanaTransfer =
  | {
      readonly ok: true;
      readonly plan: WalletTransferPlan;
      readonly transaction: Transaction;
      readonly keypair: Keypair;
      readonly connection: ReturnType<typeof getSolanaConnection>;
    }
  | {
      readonly ok: false;
      readonly cause: unknown;
      readonly failureCode: "allowance_or_balance" | "route_not_found" | "unknown";
      readonly failureReason: string;
    };

/**
 * Resolve EXACTLY ONE unsigned transfer: token identity, the atomic amount, and
 * the instructions that spend it. The amount is derived ONCE, by exact decimal
 * arithmetic, and the SAME bigint reaches both the instruction and the durable
 * row.
 */
async function resolveSolanaTransferPlan(
  intent: WalletIntent,
  wallet: SolanaWallet,
): Promise<ResolvedSolanaTransfer> {
  try {
    const keypair = Keypair.fromSecretKey(wallet.secretKey);
    const connection = getSolanaConnection();
    const toPubkey = new PublicKey(intent.toAddress);

    if (
      intent.token === null
      || intent.token === "native"
      || intent.token.toUpperCase() === "SOL"
    ) {
      // EXACT. `parseUnits` is string arithmetic; the float round-trip this
      // replaced could return a different number of lamports than the operator
      // authorized.
      const lamports = parseUnits(intent.amount, SOL_DECIMALS);
      const balance = await connection.getBalance(keypair.publicKey);
      if (BigInt(balance) < lamports) {
        return {
          ok: false,
          cause: new Error("Insufficient SOL balance for transfer"),
          failureCode: "allowance_or_balance",
          failureReason: "insufficient SOL balance for the requested transfer",
        };
      }
      const transaction = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey, lamports }),
      );
      return {
        ok: true,
        transaction,
        keypair,
        connection,
        plan: {
          chainId: SOLANA_SYNTHETIC_CHAIN_ID,
          chainSlug: SOLANA_CHAIN_SLUG,
          chainFamily: "solana",
          // The wrapped-SOL mint is the identity every other Solana row in this
          // database uses for native value, so a send joins the same asset as a
          // swap of the same asset instead of forking a second name for SOL.
          tokenAddress: SOL_MINT,
          tokenSymbol: "SOL",
          tokenDecimals: SOL_DECIMALS,
          amountRaw: lamports,
          amountHuman: formatUnits(lamports, SOL_DECIMALS),
        },
      };
    }

    const tokenMeta = await safeResolveSolanaToken(intent.token);
    if (!tokenMeta) {
      return {
        ok: false,
        cause: new Error(`Token not found: ${intent.token}`),
        failureCode: "route_not_found",
        failureReason: "the SPL token could not be resolved to a mint",
      };
    }
    const mintPubkey = new PublicKey(tokenMeta.address);

    // Compute destination ATA address without creating it. If the ATA doesn't
    // exist on-chain we PREPEND the create instruction to our staged transfer
    // transaction so both ops broadcast under one signature - a hidden on-chain
    // side effect (getOrCreateAssociatedTokenAccount can broadcast its own tx)
    // MUST NOT escape the staged outcome.
    const destinationAtaAddress = await getAssociatedTokenAddress(mintPubkey, toPubkey);
    let destinationAtaExists: boolean;
    try {
      await getAccount(connection, destinationAtaAddress);
      destinationAtaExists = true;
    } catch {
      // getAccount throws when the ATA hasn't been initialised. Treat any
      // failure as "needs creation"; the staged transaction below will
      // atomically create + transfer.
      destinationAtaExists = false;
    }

    const sourceAtaAddress = await getAssociatedTokenAddress(mintPubkey, keypair.publicKey);
    const sourceAccount = await getAccount(connection, sourceAtaAddress);
    const mintInfo = await getMint(connection, mintPubkey);
    // The MINT is the authority on scale. Jupiter's metadata is a label source;
    // when the two disagree the chain's own value is the one the instruction is
    // checked against, and `transferChecked` rejects a mismatch outright.
    const decimals = mintInfo.decimals;
    const atomicAmount = parseUnits(intent.amount, decimals);
    if (sourceAccount.amount < atomicAmount) {
      return {
        ok: false,
        cause: new Error(`Insufficient token balance for ${intent.token}`),
        failureCode: "allowance_or_balance",
        failureReason: "insufficient SPL token balance for the requested transfer",
      };
    }

    const transaction = new Transaction();
    if (!destinationAtaExists) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          keypair.publicKey, // payer
          destinationAtaAddress,
          toPubkey, // owner
          mintPubkey,
        ),
      );
    }
    transaction.add(
      createTransferCheckedInstruction(
        sourceAtaAddress,
        mintPubkey,
        destinationAtaAddress,
        keypair.publicKey,
        atomicAmount,
        decimals,
      ),
    );

    return {
      ok: true,
      transaction,
      keypair,
      connection,
      plan: {
        chainId: SOLANA_SYNTHETIC_CHAIN_ID,
        chainSlug: SOLANA_CHAIN_SLUG,
        chainFamily: "solana",
        tokenAddress: tokenMeta.address,
        tokenSymbol: tokenMeta.symbol,
        tokenDecimals: decimals,
        amountRaw: atomicAmount,
        amountHuman: formatUnits(atomicAmount, decimals),
      },
    };
  } catch (cause) {
    const sum = summarizeWalletError(cause);
    return {
      ok: false,
      cause,
      failureCode: "unknown",
      failureReason: `PlanUnresolved:${sum.errorKind}:${sum.errorHash}`,
    };
  }
}
