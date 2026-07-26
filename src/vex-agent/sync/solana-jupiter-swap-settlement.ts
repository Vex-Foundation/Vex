/**
 * PROTOCOL-AWARE settlement decoding for a fee-bearing Jupiter `/build` swap
 * (design `solana-settlement-profile-design.md` D4; the protocol/role decoder
 * `w5-design.md` R3 called for and the generic implementation deliberately
 * deferred).
 *
 * WHY A DEDICATED DECODER: the generic balance decoder
 * (`solana-settlement-decoders.ts`) declines the moment the wallet sources a
 * `system` transfer, because structure alone cannot tell a landing tip or a
 * SOL-wrap funding transfer apart from an unrelated payment. Our fee-bearing
 * swap ALWAYS contains at least one such transfer, so every native-SOL swap
 * stayed `pending` forever even when it had settled perfectly on-chain. This
 * decoder is allowed to classify those transfers because — and ONLY because —
 * the row carries a settlement profile Vex itself persisted at intent time
 * (`jupiter-swaps/settlement-profile.ts`), naming the exact tip recipient, the
 * exact tip lamports and the exact approved input amount.
 *
 * CLASSIFICATION IS EXACT-MATCH OR DECLINE. Nothing here is inferred from
 * heuristics or magnitudes:
 *   - the tip is the transfer whose destination equals the PERSISTED recipient
 *     AND whose lamports equal the PERSISTED amount, and whose recipient is
 *     also on Jupiter's published allowlist (`JUPITER_TIP_RECEIVER_ADDRESSES`
 *     — imported from the ONE place that owns it, the same constant the
 *     pre-sign guard checks against);
 *   - the wrap is the transfer into the wallet's OWN derived WSOL account,
 *     which is the economic INPUT debit and is therefore never netted away;
 *   - ANY other wallet-sourced transfer declines the whole decode.
 *
 * SIGN DISCIPLINE, NOT MAGNITUDES. A native input must come out NEGATIVE and
 * equal to the profile's approved amount; an output must come out POSITIVE. A
 * wrong sign is a decode failure, never something to flip with an absolute
 * value: the executed columns are read as settled truth by both the agent and
 * the user, and 044's doctrine is that an unsure decoder DECLINES and leaves
 * the row `pending` rather than confirming an inaccurate amount.
 *
 * BIGINT ONLY. Every amount is bigint/string maths — u64 token amounts and
 * lamport totals exceed `Number.MAX_SAFE_INTEGER`.
 */

import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { deriveAssociatedTokenAccount } from "@tools/solana-ecosystem/shared/solana-token-program.js";
import { JUPITER_TIP_RECEIVER_ADDRESSES } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import type { JupiterFeeSwapSettlementProfile } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";

import {
  decodeTokenBalanceDelta,
  decodeWalletLamportDeltaNetOfFee,
  sumPersistentCreationRentLamports,
  type DecodedSolanaSettlement,
  type ParsedSolanaTransaction,
  type SolanaNativeTransfer,
} from "./solana-settlement-decoders.js";

/** WSOL is always managed by the classic SPL Token program (never Token-2022), so the wrap account address is a pure, network-free derivation. */
const WSOL_MINT_PUBKEY = new PublicKey(SOL_MINT);

export interface JupiterFeeSwapSettlementInput {
  readonly parsedTransaction: ParsedSolanaTransaction;
  readonly walletAddress: string;
  readonly profile: JupiterFeeSwapSettlementProfile;
}

/**
 * Decode both legs of a fee-bearing Jupiter swap, or `null` when ANY part of
 * the picture is unproven. `null` is a normal, safe outcome: the sweep leaves
 * the row `pending` and re-checks it forever.
 */
export function decodeJupiterFeeSwapSettlement(
  input: JupiterFeeSwapSettlementInput,
): DecodedSolanaSettlement | null {
  const { parsedTransaction: tx, walletAddress, profile } = input;

  const classified = classifyWalletTransfers(tx, walletAddress, profile);
  if (classified === null) return null;

  const inputDelta = decodeLeg(tx, walletAddress, profile, classified, profile.inputMint);
  if (inputDelta === null || inputDelta >= 0n) return null;
  const outputDelta = decodeLeg(tx, walletAddress, profile, classified, profile.outputMint);
  if (outputDelta === null || outputDelta <= 0n) return null;

  // The native input is a COMPUTED residual (wallet lamport delta minus fee,
  // tip and surviving rent), so it is cross-checked against the amount Vex
  // approved; the SPL path needs no such check because the token-balance delta
  // IS the directly observed movement.
  if (isNativeLeg(profile, profile.inputMint) && -inputDelta !== BigInt(profile.inputAmountRaw)) return null;

  return {
    executedAmountInRaw: (-inputDelta).toString(),
    executedAmountOutRaw: outputDelta.toString(),
  };
}

/** A leg is settled in native lamports only when it is the SOL sentinel AND `/build` was asked to wrap/unwrap it inside this transaction; otherwise it is an ordinary SPL token-account movement (including a caller-managed WSOL balance). */
function isNativeLeg(profile: JupiterFeeSwapSettlementProfile, mint: string): boolean {
  return mint === SOL_MINT && profile.wrapAndUnwrapSol;
}

function decodeLeg(
  tx: ParsedSolanaTransaction,
  wallet: string,
  profile: JupiterFeeSwapSettlementProfile,
  classified: ClassifiedWalletTransfers,
  mint: string,
): bigint | null {
  if (!isNativeLeg(profile, mint)) return decodeTokenBalanceDelta(tx, wallet, mint);

  const deltaNetOfFee = decodeWalletLamportDeltaNetOfFee(tx, wallet);
  if (deltaNetOfFee === null) return null;
  const rentAdjustment = sumPersistentCreationRentLamports(tx, wallet);
  if (rentAdjustment === null) return null;

  // Native swap economics = what the wallet's lamports actually did, minus the
  // three things that are NOT swap economics: the network fee (already added
  // back above), the exact validated landing tip, and rent for accounts that
  // survived the transaction. The wrap transfer is deliberately absent from
  // this list — it IS the input debit.
  return deltaNetOfFee + classified.tipLamports + rentAdjustment;
}

interface ClassifiedWalletTransfers {
  /** Lamports to add back because they paid for landing, not for the swap. */
  readonly tipLamports: bigint;
}

/**
 * Account for EVERY wallet-sourced `system` transfer in the transaction.
 * `null` (decline) when one of them is neither the persisted tip nor funding
 * of the wallet's own WSOL wrap account — an unexplained payment out of the
 * signer's account means this decoder does not understand this transaction,
 * and understanding it is the precondition for reporting executed amounts.
 */
function classifyWalletTransfers(
  tx: ParsedSolanaTransaction,
  wallet: string,
  profile: JupiterFeeSwapSettlementProfile,
): ClassifiedWalletTransfers | null {
  const evidence = tx.nativeInstructionEvidence;
  if (evidence === null) return null;

  const wrapAccount = resolveWrapAccount(wallet, profile);
  if (wrapAccount.kind === "unresolvable") return null;

  let tipLamports = 0n;
  let tipSeen = false;
  for (const transfer of evidence.transfers) {
    if (transfer.source !== wallet) continue;
    if (!tipSeen && matchesPersistedTip(transfer, profile)) {
      tipLamports = BigInt(transfer.lamports);
      tipSeen = true;
      continue;
    }
    if (wrapAccount.kind === "account" && transfer.destination === wrapAccount.address) continue; // the input debit
    return null;
  }

  // A profile that names a tip must find it: a transaction missing the tip Vex
  // approved is not the transaction this profile describes.
  if (profile.tipLamports > 0 && !tipSeen) return null;
  return { tipLamports };
}

/** Exact match on BOTH persisted facts, plus independent confirmation that the recipient is one of Jupiter's published tip receivers — a persisted recipient is evidence, not authority. */
function matchesPersistedTip(
  transfer: SolanaNativeTransfer,
  profile: JupiterFeeSwapSettlementProfile,
): boolean {
  if (profile.tipRecipient === null || profile.tipLamports === 0) return false;
  if (transfer.destination !== profile.tipRecipient) return false;
  if (transfer.lamports !== profile.tipLamports) return false;
  return JUPITER_TIP_RECEIVER_ADDRESSES.includes(profile.tipRecipient);
}

type WrapAccountResolution =
  /** This swap wraps nothing, so NO transfer may be excused as wrap funding. */
  | { readonly kind: "none" }
  | { readonly kind: "account"; readonly address: string }
  /** The wallet address is not a parseable public key — decline; never proceed with an unknown wrap account. */
  | { readonly kind: "unresolvable" };

/**
 * The wallet's own derived WSOL associated token account — the destination
 * `/build` funds when it wraps native SOL (verified against a recorded `/build`
 * response: an ATA `createIdempotent`, a `system` transfer of exactly the input
 * amount into that ATA, `syncNative`, then `closeAccount` in cleanup).
 */
function resolveWrapAccount(
  wallet: string,
  profile: JupiterFeeSwapSettlementProfile,
): WrapAccountResolution {
  const touchesNativeSol = profile.inputMint === SOL_MINT || profile.outputMint === SOL_MINT;
  if (!profile.wrapAndUnwrapSol || !touchesNativeSol) return { kind: "none" };
  try {
    const address = deriveAssociatedTokenAccount(new PublicKey(wallet), WSOL_MINT_PUBKEY, TOKEN_PROGRAM_ID).toBase58();
    return { kind: "account", address };
  } catch {
    return { kind: "unresolvable" };
  }
}
