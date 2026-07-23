/**
 * Shared Solana validation and amount helpers for the new solana-ecosystem shelf.
 */

import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadConfig } from "../../../config/store.js";
import { VexError, ErrorCodes } from "../../../errors.js";

/** SOL mint decimals / lamports-per-SOL exponent. */
export const SOL_DECIMALS = 9;

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
 * Expand `mantissa * 10^exp` into a plain decimal string without IEEE-754.
 * `intPart` / `fracPart` are the digits on either side of the mantissa decimal.
 */
function expandScientific(intPart: string, fracPart: string, exp: number): string {
  const digits = `${intPart}${fracPart}`;
  if (digits.length === 0 || /^0+$/.test(digits)) return "0";
  const point = intPart.length + exp;
  if (point <= 0) {
    return `0.${"0".repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${digits}${"0".repeat(point - digits.length)}`;
  }
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Convert a non-negative decimal amount string into atomic base units.
 *
 * No float intermediate: the amount is treated as a decimal string (optionally
 * scientific notation) and scaled by `10 ** decimals` with integer arithmetic.
 * Fractional digits beyond `decimals` are rejected when any excess digit is
 * non-zero — the amount is not silently truncated.
 */
export function parseDecimalToAtomic(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid token decimals: ${decimals}`,
      "Decimals must be an integer between 0 and 255.",
    );
  }

  let s = value.trim();
  if (s.length === 0) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      "Amount cannot be empty.",
      "Provide a positive decimal amount.",
    );
  }
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Amount must be non-negative: ${value}`,
      "Provide a positive decimal amount.",
    );
  }

  const sci = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (sci) {
    const exp = Number(sci[3]);
    if (!Number.isSafeInteger(exp) || exp < -256 || exp > 256) {
      throw new VexError(
        ErrorCodes.INVALID_AMOUNT,
        `Invalid amount: ${value}`,
        "Scientific exponent is out of range.",
      );
    }
    s = expandScientific(sci[1]!, sci[2] ?? "", exp);
  }

  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid amount: ${value}`,
      "Amount must be a decimal number (e.g. 1.5) or scientific notation.",
    );
  }

  const [wholePart, fracPart = ""] = s.split(".");
  if (fracPart.length > decimals) {
    const excess = fracPart.slice(decimals);
    if (/[1-9]/.test(excess)) {
      throw new VexError(
        ErrorCodes.INVALID_AMOUNT,
        `Amount has more than ${decimals} decimal places: ${value}`,
        "Use fewer fractional digits, or an amount of at least one base unit.",
      );
    }
  }

  const frac = fracPart.slice(0, decimals).padEnd(decimals, "0");
  const digits = `${wholePart}${frac}`.replace(/^0+/, "") || "0";
  return BigInt(digits);
}

/**
 * Like `parseDecimalToAtomic`, but rejects amounts that convert to **zero**
 * base units. Use on fund-moving paths so a positive-looking string cannot
 * become a zero-size transfer.
 */
export function parsePositiveDecimalToAtomic(
  value: string,
  decimals: number,
): bigint {
  const atomic = parseDecimalToAtomic(value, decimals);
  if (atomic === 0n) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Amount is too small to transfer: ${value}`,
      "Amount must be at least one base unit on-chain.",
    );
  }
  return atomic;
}

export function uiToTokenAmount(uiAmount: number, decimals: number): bigint {
  if (!Number.isFinite(uiAmount) || uiAmount <= 0) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid token amount: ${uiAmount}`,
      "Amount must be a positive finite number.",
    );
  }

  // Number callers (e.g. Jupiter quote sizing) still enter as float — route
  // through the string parser so conversion and zero-atomic rejection share
  // one implementation. `toFixed` is only used to re-materialise a decimal
  // string from an already-validated positive finite number.
  return parsePositiveDecimalToAtomic(uiAmount.toFixed(decimals), decimals);
}

export function looksLikeSolanaAddress(value: string): boolean {
  return value.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

export function parseSolAmount(value: string): { lamports: bigint; ui: number } {
  const lamports = parseDecimalToAtomic(value, SOL_DECIMALS);
  // Soft upper bound retained from the prior Number path (1e9 SOL).
  if (lamports > BigInt(1_000_000_000) * BigInt(LAMPORTS_PER_SOL)) {
    throw new VexError(
      ErrorCodes.SOLANA_INSUFFICIENT_BALANCE,
      `SOL amount too large: ${value}`,
    );
  }
  const ui = Number(lamports) / LAMPORTS_PER_SOL;
  return { lamports, ui };
}

export function parseSplAmount(value: string, decimals: number): { atomic: bigint; ui: number } {
  const atomic = parseDecimalToAtomic(value, decimals);
  const ui = tokenAmountToUi(atomic, decimals);
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
