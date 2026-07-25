/**
 * Shared Solana validation and amount helpers for the new solana-ecosystem shelf.
 */

import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadConfig } from "../../../config/store.js";
import { VexError, ErrorCodes } from "../../../errors.js";

export function validateSolanaAddress(addr: string): string {
  try {
    const pubkey = new PublicKey(addr);
    return pubkey.toBase58();
  } catch {
    throw new VexError(
      ErrorCodes.SOLANA_INVALID_ADDRESS,
      `Invalid Solana address: ${addr}`,
      "Provide a valid base58-encoded Solana public key.",
    );
  }
}

export function tokenAmountToUi(rawAmount: string | bigint, decimals: number): number {
  return Number(BigInt(rawAmount)) / 10 ** decimals;
}

/**
 * Format a raw atomic-unit integer as an EXACT decimal string — no float
 * division, so no precision loss for amounts beyond `Number.MAX_SAFE_INTEGER`
 * (money convention: string math only, `parseFloat`/`Number` division
 * forbidden on money). Use for agent-visible exact-decimal disclosures (e.g.
 * a fee amount); use `tokenAmountToUi` only where an approximate UI number is
 * genuinely fine.
 */
export function atomicToExactDecimalString(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

export function uiToTokenAmount(uiAmount: number, decimals: number): bigint {
  if (!Number.isFinite(uiAmount) || uiAmount <= 0) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid token amount: ${uiAmount}`,
      "Amount must be a positive finite number.",
    );
  }

  return BigInt(Math.round(uiAmount * 10 ** decimals));
}

export function looksLikeSolanaAddress(value: string): boolean {
  return value.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

export function parseSolAmount(value: string): { lamports: bigint; ui: number } {
  const ui = Number(value);
  if (Number.isNaN(ui) || ui < 0) {
    throw new VexError(
      ErrorCodes.SOLANA_INSUFFICIENT_BALANCE,
      `Invalid SOL amount: ${value}`,
      "Amount must be a non-negative number.",
    );
  }
  if (ui > 1_000_000_000) {
    throw new VexError(
      ErrorCodes.SOLANA_INSUFFICIENT_BALANCE,
      `SOL amount too large: ${value}`,
    );
  }
  const lamports = BigInt(Math.round(ui * LAMPORTS_PER_SOL));
  return { lamports, ui };
}

export function parseSplAmount(value: string, decimals: number): { atomic: bigint; ui: number } {
  const ui = Number(value);
  if (Number.isNaN(ui) || ui < 0) {
    throw new VexError(
      ErrorCodes.SOLANA_INSUFFICIENT_BALANCE,
      `Invalid token amount: ${value}`,
      "Amount must be a non-negative number.",
    );
  }
  const atomic = BigInt(Math.round(ui * 10 ** decimals));
  return { atomic, ui };
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function shortenSolanaAddress(addr: string, chars = 4): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function solanaExplorerUrl(
  hashOrAddress: string,
  type: "tx" | "address" = "tx",
): string {
  const cfg = loadConfig();
  const base = cfg.solana?.explorerUrl ?? "https://explorer.solana.com";
  const clusterParam = cfg.solana?.cluster && cfg.solana.cluster !== "mainnet-beta"
    ? `?cluster=${cfg.solana.cluster}`
    : "";
  return `${base}/${type}/${hashOrAddress}${clusterParam}`;
}
