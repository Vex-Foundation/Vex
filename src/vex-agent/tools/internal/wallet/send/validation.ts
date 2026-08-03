/**
 * Wallet send — PRESENCE/EXISTING input checks for prepare + confirm.
 *
 * Parsing + required/walletFamily/chain/positive-amountIn for prepare, and the
 * required walletFamily/intentId for confirm. The model-facing param keys are
 * `walletFamily` and `amountIn` (SPEC §1.1/§1.3); the internal value keeps the
 * name `network` because that is the stored `wallet_intents` column. These are the SAME checks the
 * handlers ran inline pre-split, in the SAME order. Recipient (`to`) is NOT
 * stricter-validated here — chain-specific recipient validation happens later
 * in the executors.
 */

import type { ToolResult } from "../../../types.js";
import { str, missingOrWrongTypeMessage } from "../../types.js";

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
  const network = str(params, "walletFamily") as "eip155" | "solana";
  const to = str(params, "to");
  const amount = str(params, "amountIn");
  const token = str(params, "token") || null;

  // Named ONE AT A TIME, and a wrong type said as a wrong type. `str()` gives
  // "" for both absent and wrong-typed, so the old combined "Missing required:
  // walletFamily, to, amountIn" told a model that sent `amountIn: 1.5` (a number — the
  // shape it holds after arithmetic) that it had sent nothing. On the send
  // path that is a burnt turn on a transfer the user is waiting for.
  const missing =
    !network ? { key: "walletFamily", expected: 'a string ("eip155" or "solana")' }
    : !to ? { key: "to", expected: "a string (the destination address)" }
    : !amount ? { key: "amountIn", expected: "a STRING decimal amount (e.g. \"1.5\"), never a number" }
    : null;
  if (missing !== null) {
    return { ok: false, result: fail(missingOrWrongTypeMessage(params, missing.key, missing.expected)) };
  }

  if (network !== "eip155" && network !== "solana") {
    return { ok: false, result: fail("walletFamily must be eip155 or solana") };
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
    return { ok: false, result: fail(`Invalid amountIn: ${amount}`) };
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
  const network = str(params, "walletFamily") as "eip155" | "solana";
  const intentId = str(params, "intentId");

  const missing =
    !network ? { key: "walletFamily", expected: 'a string ("eip155" or "solana")' }
    : !intentId ? { key: "intentId", expected: "a string (the id wallet_send_prepare returned)" }
    : null;
  if (missing !== null) {
    return {
      ok: false,
      result: fail(missingOrWrongTypeMessage(params, missing.key, missing.expected)),
    };
  }

  return { ok: true, values: { network, intentId } };
}
