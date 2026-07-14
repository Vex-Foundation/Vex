/**
 * Wallet send — Solana executor.
 *
 * Inlines the validation + tx-build that previously lived in
 * `sendSol` / `sendSplToken` (`src/tools/solana-ecosystem/shared/solana-transfer.ts`)
 * so the broadcast/confirm split is visible to this caller. The shared
 * helpers stay untouched for Jupiter swap + other consumers.
 *
 * Codex puzzle-5 phase-4 review v3 acceptance: tx hash arrives via
 * `StagedSubmissionResult.signature` post-broadcast; the caller never
 * extracts it heuristically from an opaque throw.
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

import type { SolanaWallet } from "@tools/wallet/multi-auth.js";
import {
  getSolanaConnection,
  signAndSubmitLegacyTxStaged,
} from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { solanaExplorerUrl } from "@tools/solana-ecosystem/shared/solana-validation.js";
import { resolveJupiterToken } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";

import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";

import {
  preBroadcastFailed,
  type ExecuteOutcome,
} from "./send-types.js";

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
  // Pre-broadcast build phase — validation + tx assembly. Any throw here
  // returns `pre_broadcast_failed` (no signature exists).
  let transaction: Transaction;
  let keypair: Keypair;
  let tokenSymbol: string;
  let connection;

  try {
    keypair = Keypair.fromSecretKey(wallet.secretKey);
    connection = getSolanaConnection();
    const toPubkey = new PublicKey(intent.toAddress);

    if (
      intent.token === null
      || intent.token === "native"
      || intent.token.toUpperCase() === "SOL"
    ) {
      const lamports = BigInt(Math.round(Number(intent.amount) * 1e9));
      const balance = await connection.getBalance(keypair.publicKey);
      if (BigInt(balance) < lamports) {
        return preBroadcastFailed(
          new Error("Insufficient SOL balance for transfer"),
        );
      }
      transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey,
          lamports,
        }),
      );
      tokenSymbol = "SOL";
    } else {
      const tokenMeta = await safeResolveSolanaToken(intent.token);
      if (!tokenMeta) {
        return preBroadcastFailed(
          new Error(`Token not found: ${intent.token}`),
        );
      }
      const mintPubkey = new PublicKey(tokenMeta.address);

      // Compute destination ATA address without creating it. If the ATA
      // doesn't exist on-chain we PREPEND the create instruction to our
      // staged transfer transaction so both ops broadcast under one
      // signature — Codex puzzle-5 phase-4 final review point 2: hidden
      // on-chain side effects (getOrCreateAssociatedTokenAccount can
      // broadcast its own tx) MUST NOT escape the staged ExecuteOutcome.
      const destinationAtaAddress = await getAssociatedTokenAddress(
        mintPubkey,
        toPubkey,
      );
      let destinationAtaExists: boolean;
      try {
        await getAccount(connection, destinationAtaAddress);
        destinationAtaExists = true;
      } catch {
        // getAccount throws when the ATA hasn't been initialised. Treat
        // any failure as "needs creation"; the staged transaction below
        // will atomically create + transfer.
        destinationAtaExists = false;
      }

      const sourceAtaAddress = await getAssociatedTokenAddress(
        mintPubkey,
        keypair.publicKey,
      );
      const sourceAccount = await getAccount(connection, sourceAtaAddress);
      const atomicAmount = BigInt(
        Math.round(Number(intent.amount) * 10 ** tokenMeta.decimals),
      );
      if (sourceAccount.amount < atomicAmount) {
        return preBroadcastFailed(
          new Error(`Insufficient token balance for ${intent.token}`),
        );
      }
      const mintInfo = await getMint(connection, mintPubkey);
      const decimals = tokenMeta.decimals || mintInfo.decimals;

      transaction = new Transaction();
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
      tokenSymbol = tokenMeta.symbol;
    }
  } catch (cause) {
    return preBroadcastFailed(cause);
  }

  // Broadcast + confirm staged. `signAndSubmitLegacyTxStaged` only throws
  // for pre-broadcast (sendRawTransaction failed); all post-broadcast
  // branches return a StagedSubmissionResult with `signature` set.
  let submission: Awaited<ReturnType<typeof signAndSubmitLegacyTxStaged>>;
  try {
    submission = await signAndSubmitLegacyTxStaged(transaction, keypair, {
      connection,
    });
  } catch (cause) {
    return preBroadcastFailed(cause);
  }

  if (submission.phase === "chain_failed") {
    return {
      kind: "chain_failed",
      txHash: submission.signature,
      chain: "solana",
      errorKind: submission.errorKind ?? "Unknown",
      errorHash: submission.errorHash ?? "0000000000000000",
    };
  }
  if (submission.phase === "confirmation_unknown") {
    return {
      kind: "confirmation_unknown",
      txHash: submission.signature,
      chain: "solana",
      errorKind: submission.errorKind ?? "Unknown",
      errorHash: submission.errorHash ?? "0000000000000000",
    };
  }

  return {
    kind: "confirmed",
    txHash: submission.signature,
    data: {
      // Curated, cross-network-normalised projection (see
      // formatWalletSendOutput in send/finalize.ts): emit `txHash` (not the
      // Solana-only `signature`), `chain`, `status`, and `explorerUrl`.
      txHash: submission.signature,
      chain: "solana",
      status: "confirmed",
      explorerUrl: solanaExplorerUrl(submission.signature),
      // Full capture stays intact for the sync/activity pipeline — it keeps
      // the dropped-from-output fields (signature, in/out token+amount,
      // walletAddress) under _tradeCapture.
      _tradeCapture: {
        type: "transfer",
        chain: "solana",
        status: "executed",
        inputToken: tokenSymbol,
        inputAmount: intent.amount,
        outputToken: tokenSymbol,
        outputAmount: intent.amount,
        signature: submission.signature,
        walletAddress: intent.walletAddress,
      },
    },
  };
}
