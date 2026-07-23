/**
 * Wallet send — PRESENCE/EXISTING input checks for prepare + confirm.
 *
 * Parsing + required/network/chain/positive-amount for prepare, and the
 * required network/intentId for confirm. These are the SAME checks the
 * handlers ran inline pre-split, in the SAME order. Recipient (`to`) is NOT
 * stricter-validated here — chain-specific recipient validation happens later
 * in the executors.
 */

import {
  parsePositiveDecimalToAtomic,
  SOL_DECIMALS,
} from "@tools/solana-ecosystem/shared/solana-validation.js";

import type { ToolResult } from "../../../types.js";
import { str } from "../../types.js";

import { fail } from "./results.js";

export interface PreparedSendParams {
  readonly network: "eip155" | "solana";
  readonly to: string;
  readonly amount: string;
  readonly token: string | null;
  readonly chain: string | null;
}

export type PrepareValidation =
  | { readonly ok: true; readonly values: PreparedSendParams }
  | { readonly ok: false; readonly result: ToolResult };

export function validatePrepareParams(
  params: Record<string, unknown>,
): PrepareValidation {
  const network = str(params, "network") as "eip155" | "solana";
  const to = str(params, "to");
  const amount = str(params, "amount");
  const token = str(params, "token") || null;

  if (!network || !to || !amount) {
    return { ok: false, result: fail("Missing required: network, to, amount") };
  }

  if (network !== "eip155" && network !== "solana") {
    return { ok: false, result: fail("network must be eip155 or solana") };
  }

  const chain = str(params, "chain") || null;
  if (network === "eip155" && chain === null) {
    return {
      ok: false,
      result: fail("Missing required: chain for eip155 transfers"),
    };
  }

  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return { ok: false, result: fail(`Invalid amount: ${amount}`) };
  }

  // Solana native/SOL: decimals are known at prepare. Reject amounts that
  // cannot become at least one lamport so we never create an intent that
  // later executes as a zero-size transfer. SPL mints need token metadata
  // for decimals — those are checked at execute with the same converter.
  if (network === "solana") {
    const isNative =
      token === null
      || token === "native"
      || token.toUpperCase() === "SOL";
    if (isNative) {
      try {
        parsePositiveDecimalToAtomic(amount, SOL_DECIMALS);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : `Invalid amount: ${amount}`;
        return { ok: false, result: fail(message) };
      }
    }
  }

  return { ok: true, values: { network, to, amount, token, chain } };
}

export interface ConfirmSendParams {
  readonly network: "eip155" | "solana";
  readonly intentId: string;
}

export type ConfirmValidation =
  | { readonly ok: true; readonly values: ConfirmSendParams }
  | { readonly ok: false; readonly result: ToolResult };

export function validateConfirmParams(
  params: Record<string, unknown>,
): ConfirmValidation {
  const network = str(params, "network") as "eip155" | "solana";
  const intentId = str(params, "intentId");

  if (!network || !intentId) {
    return {
      ok: false,
      result: fail("Missing required: network, intentId"),
    };
  }

  return { ok: true, values: { network, intentId } };
}
