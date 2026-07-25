/**
 * High-level Jupiter Lend Earn REST service.
 * Preserves full wire responses and adds minimal normalization where upstream docs are inconsistent.
 */

import { Keypair } from "@solana/web3.js";
import { signAndSendVersionedTx } from "../../../shared/solana-transaction.js";
import { type SolanaInstructionWire, type TransferResult } from "../../../shared/types.js";
import { solanaExplorerUrl } from "../../../shared/solana-validation.js";
import {
  jupiterLendEarnDepositInstructions,
  jupiterLendEarnDepositTransaction,
  jupiterLendEarnEarnings,
  jupiterLendEarnMintInstructions,
  jupiterLendEarnMintTransaction,
  jupiterLendEarnPositions,
  jupiterLendEarnRedeemInstructions,
  jupiterLendEarnRedeemTransaction,
  jupiterLendEarnTokens,
  jupiterLendEarnWithdrawInstructions,
  jupiterLendEarnWithdrawTransaction,
} from "./client.js";
import type {
  JupiterLendEarnAmountRequest,
  JupiterLendEarnEarningsItem,
  JupiterLendEarnEarningsResponse,
  JupiterLendEarnEarningsResult,
  JupiterLendEarnExecutionResult,
  JupiterLendEarnInstructionResponse,
  JupiterLendEarnInstructionsResult,
  JupiterLendEarnSharesRequest,
  JupiterLendEarnTokensResponse,
  JupiterLendEarnTransactionResponse,
  JupiterLendEarnPositionsResponse,
} from "./types.js";

function toUsersList(users: string | string[]): string[] {
  return Array.isArray(users) ? users : [users];
}

export function normalizeJupiterLendEarnEarnings(
  raw: JupiterLendEarnEarningsResponse,
): JupiterLendEarnEarningsItem[] {
  return Array.isArray(raw) ? raw : [raw];
}

export function normalizeJupiterLendEarnInstructions(
  raw: JupiterLendEarnInstructionResponse,
): SolanaInstructionWire[] {
  return "instructions" in raw ? raw.instructions : [raw];
}

async function executeEarnTransaction(
  signer: Keypair,
  asset: string,
  requestTx: Promise<JupiterLendEarnTransactionResponse>,
): Promise<JupiterLendEarnExecutionResult> {
  const raw = await requestTx;
  // `signAndSendVersionedTx` is idempotency-safe (B-007): `sendRawTransaction`
  // runs at most once. A post-broadcast confirmation-unknown state throws a
  // non-retryable error carrying the signature instead of re-broadcasting.
  const signature = await signAndSendVersionedTx(raw.transaction, [signer]);

  return {
    signature,
    explorerUrl: solanaExplorerUrl(signature),
    asset,
    signer: signer.publicKey.toBase58(),
    raw,
  };
}

export async function getJupiterLendEarnTokens(): Promise<JupiterLendEarnTokensResponse> {
  return jupiterLendEarnTokens();
}

export async function getJupiterLendEarnPositions(
  users: string | string[],
): Promise<JupiterLendEarnPositionsResponse> {
  return jupiterLendEarnPositions({ users: toUsersList(users) });
}

export async function getJupiterLendEarnEarnings(
  user: string,
  positions: string[],
): Promise<JupiterLendEarnEarningsResult> {
  const raw = await jupiterLendEarnEarnings({ user, positions });
  return {
    earnings: normalizeJupiterLendEarnEarnings(raw),
    raw,
  };
}

export async function requestJupiterLendEarnDepositTransaction(
  request: JupiterLendEarnAmountRequest,
): Promise<JupiterLendEarnTransactionResponse> {
  return jupiterLendEarnDepositTransaction(request);
}

export async function requestJupiterLendEarnWithdrawTransaction(
  request: JupiterLendEarnAmountRequest,
): Promise<JupiterLendEarnTransactionResponse> {
  return jupiterLendEarnWithdrawTransaction(request);
}

export async function requestJupiterLendEarnMintTransaction(
  request: JupiterLendEarnSharesRequest,
): Promise<JupiterLendEarnTransactionResponse> {
  return jupiterLendEarnMintTransaction(request);
}

export async function requestJupiterLendEarnRedeemTransaction(
  request: JupiterLendEarnSharesRequest,
): Promise<JupiterLendEarnTransactionResponse> {
  return jupiterLendEarnRedeemTransaction(request);
}

export async function requestJupiterLendEarnDepositInstructions(
  request: JupiterLendEarnAmountRequest,
): Promise<JupiterLendEarnInstructionsResult> {
  const raw = await jupiterLendEarnDepositInstructions(request);
  return { instructions: normalizeJupiterLendEarnInstructions(raw), raw };
}

export async function requestJupiterLendEarnWithdrawInstructions(
  request: JupiterLendEarnAmountRequest,
): Promise<JupiterLendEarnInstructionsResult> {
  const raw = await jupiterLendEarnWithdrawInstructions(request);
  return { instructions: normalizeJupiterLendEarnInstructions(raw), raw };
}

export async function requestJupiterLendEarnMintInstructions(
  request: JupiterLendEarnSharesRequest,
): Promise<JupiterLendEarnInstructionsResult> {
  const raw = await jupiterLendEarnMintInstructions(request);
  return { instructions: normalizeJupiterLendEarnInstructions(raw), raw };
}

export async function requestJupiterLendEarnRedeemInstructions(
  request: JupiterLendEarnSharesRequest,
): Promise<JupiterLendEarnInstructionsResult> {
  const raw = await jupiterLendEarnRedeemInstructions(request);
  return { instructions: normalizeJupiterLendEarnInstructions(raw), raw };
}

export async function executeJupiterLendEarnMint(
  secretKey: Uint8Array,
  asset: string,
  shares: string,
): Promise<JupiterLendEarnExecutionResult> {
  const signer = Keypair.fromSecretKey(secretKey);
  return executeEarnTransaction(
    signer,
    asset,
    jupiterLendEarnMintTransaction({
      asset,
      shares,
      signer: signer.publicKey.toBase58(),
    }),
  );
}

export async function executeJupiterLendEarnRedeem(
  secretKey: Uint8Array,
  asset: string,
  shares: string,
): Promise<JupiterLendEarnExecutionResult> {
  const signer = Keypair.fromSecretKey(secretKey);
  return executeEarnTransaction(
    signer,
    asset,
    jupiterLendEarnRedeemTransaction({
      asset,
      shares,
      signer: signer.publicKey.toBase58(),
    }),
  );
}

export const getLendEarnTokens = getJupiterLendEarnTokens;
export const getLendEarnPositions = getJupiterLendEarnPositions;
export const getLendEarnEarnings = getJupiterLendEarnEarnings;
export const requestLendEarnDepositTransaction = requestJupiterLendEarnDepositTransaction;
export const requestLendEarnWithdrawTransaction = requestJupiterLendEarnWithdrawTransaction;
export const requestLendEarnMintTransaction = requestJupiterLendEarnMintTransaction;
export const requestLendEarnRedeemTransaction = requestJupiterLendEarnRedeemTransaction;
export const executeLendEarnMint = executeJupiterLendEarnMint;
export const executeLendEarnRedeem = executeJupiterLendEarnRedeem;

export type { TransferResult };
