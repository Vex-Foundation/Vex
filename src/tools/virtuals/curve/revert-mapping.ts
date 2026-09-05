/**
 * What a BondingV5 revert MEANS, by name.
 *
 * The contract reverts with custom errors carrying no arguments, so the only
 * thing on the wire is a four-byte selector. Without this table an agent is told
 * "execution reverted" for four completely different situations - the price
 * moved, the agent graduated mid-flight, the deadline passed, the amount was
 * zero - and only one of them is worth retrying.
 *
 * The selectors are COMPUTED from the signatures rather than hand-pasted, so a
 * typo cannot silently produce a table that matches nothing. The signatures
 * themselves are transcribed from `BondingV5.sol` (:171-173) and
 * `FRouterV3.sol`'s `require` strings.
 */

import { toFunctionSelector } from "viem";

import type { CurveTradeSide } from "./state.js";

/** The bounded classes this lane distinguishes. Never provider text. */
export type CurveRevertClass =
  | "slippage"
  | "token_status"
  /**
   * BondingV5's `InvalidInput` covers BOTH the expired-deadline check and a
   * zero amount, and the two are the SAME four bytes on the wire. There is
   * therefore no `deadline_expired` class: naming one would claim a
   * distinction the contract does not make, and the sentence below states
   * both possibilities instead.
   */
  | "invalid_input"
  | "allowance_or_balance"
  | "unknown";

export interface CurveRevertVerdict {
  readonly kind: CurveRevertClass;
  /** Agent-facing sentence: what happened, then what to do about it. */
  readonly reason: string;
}

const SELECTORS: Readonly<Record<string, CurveRevertClass>> = {
  [toFunctionSelector("SlippageTooHigh()")]: "slippage",
  [toFunctionSelector("InvalidTokenStatus()")]: "token_status",
  [toFunctionSelector("InvalidInput()")]: "invalid_input",
};

const REASONS: Readonly<Record<CurveRevertClass, string>> = {
  slippage:
    "the curve could not deliver the floor this trade was signed with (BondingV5 reverted with SlippageTooHigh). "
    + "The floor was not lowered and nothing was left half-done. Request a fresh quote; if the curve is moving fast, "
    + "quote a smaller size or a wider slippageBps within Vex's cap.",
  token_status:
    "BondingV5 refused the trade because this token is no longer tradable on the curve (InvalidTokenStatus): it has "
    + "graduated to an AMM pool, its launch was cancelled, or trading is disabled. Nothing was traded. Re-read the "
    + "agent and trade the AMM pool instead if it graduated.",
  invalid_input:
    "BondingV5 rejected an argument of this trade (InvalidInput). That is either the deadline check - the "
    + "transaction was included after the deadline it was signed with - or a zero amount; the contract reverts "
    + "with the same four bytes for both. Nothing moved. Request a fresh quote and execute it promptly.",
  allowance_or_balance:
    "the router could not pull the tokens this trade spends: the allowance or the balance was short at inclusion "
    + "time. Nothing was traded.",
  unknown:
    "the curve transaction reverted and the contract gave no reason Vex can name. Nothing was traded. Request a "
    + "fresh quote before trying again.",
};

/**
 * Classify a revert from its error payload.
 *
 * Both an estimate-time refusal and a mined revert reach here, and both carry
 * the same selector - the DIFFERENCE between them is whether bytes were
 * broadcast, which the caller knows and this function deliberately does not.
 */
export function classifyCurveRevert(err: unknown): CurveRevertVerdict {
  const text = errorText(err);
  for (const [selector, kind] of Object.entries(SELECTORS)) {
    if (text.includes(selector)) return { kind, reason: REASONS[kind] };
  }
  // Name matching is the SECOND pass, not the first: a node that decodes the
  // custom error for us reports the name and no selector, and a node that does
  // not reports the selector and no name.
  if (/SlippageTooHigh/i.test(text)) return { kind: "slippage", reason: REASONS.slippage };
  if (/InvalidTokenStatus/i.test(text)) return { kind: "token_status", reason: REASONS.token_status };
  if (/InvalidInput/i.test(text)) return { kind: "invalid_input", reason: REASONS.invalid_input };
  if (/insufficient allowance|transfer amount exceeds|ERC20:/i.test(text)) {
    return { kind: "allowance_or_balance", reason: REASONS.allowance_or_balance };
  }
  return { kind: "unknown", reason: REASONS.unknown };
}

/**
 * The bounded text a classification may read.
 *
 * Only the fields viem itself populates, and never anything that reaches a log
 * or a durable row: the caller stores the CLASS and this module's own sentence,
 * not the provider's payload.
 */
function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err === null || typeof err !== "object") return "";
  const parts: string[] = [];
  const record = err as Record<string, unknown>;
  for (const key of ["shortMessage", "details", "message", "data", "name"]) {
    const value = record[key];
    if (typeof value === "string") parts.push(value);
  }
  const cause = record.cause;
  if (cause !== undefined && cause !== err) parts.push(errorText(cause));
  return parts.join(" ");
}

/** The trade side, re-exported so a caller does not import two modules for one call. */
export type { CurveTradeSide };
