/**
 * Param reading and refusal rendering for the wrap tools.
 *
 * Same contract as the transaction lane's `tool-io.ts`: a refusal is a DOMAIN
 * OUTCOME, so it becomes a `ToolResult` whose `output` is the sentence the model
 * reads and whose `data` carries the structural details a program acts on, with
 * `refusalCode` exported alongside so a caller can branch on WHY without
 * string-matching the prose.
 */

import type { ToolResult } from "../../../types.js";
import type { TransactionOutcome } from "../transaction/refusal.js";

import { accept, refuse, type WrapOutcome, type WrapRefusal, type WrapRefusalCode } from "./refusal.js";

export function wrapRefusalToResult(refusal: WrapRefusal): ToolResult {
  return {
    success: false,
    output: refusal.message,
    data: {
      refusalCode: refusal.code,
      ...(refusal.details === undefined ? {} : { refusalDetails: refusal.details }),
    },
  };
}

/**
 * Carry a refusal from a REUSED transaction-lane primitive into this lane's
 * vocabulary.
 *
 * The fee-bounds parser and the forbidden-field guard are reused verbatim
 * (owner decision: one owner for the gas-cap contract), and they answer in the
 * transaction lane's refusal type. Only four of that union's codes are
 * reachable from those two functions, and all four exist here by the same name,
 * so this is a rename and not a reclassification. An unreachable code would be
 * a change in those primitives rather than a case to invent a meaning for, so it
 * lands on `invalid_input` with its own message intact rather than being
 * silently relabelled as something more specific.
 */
export function fromTransactionRefusal<T>(outcome: TransactionOutcome<T>): WrapOutcome<T> {
  if (outcome.ok) return accept(outcome.value);
  const carried: WrapRefusalCode =
    outcome.refusal.code === "missing_fee_bounds"
      || outcome.refusal.code === "forbidden_field"
      || outcome.refusal.code === "simulation_failed"
      ? outcome.refusal.code
      : "invalid_input";
  return refuse(carried, outcome.refusal.message, outcome.refusal.details);
}

/**
 * A required string param. A JSON number is refused as a wrong TYPE rather than
 * coerced: on this path a number is how an amount arrives after arithmetic, and
 * coercing it would print a float.
 */
export function requireWrapString(
  params: Record<string, unknown>,
  key: string,
): WrapOutcome<string> {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    return refuse("invalid_input", `Missing required: \`${key}\` (a string).`, { field: key });
  }
  if (typeof raw !== "string") {
    return refuse(
      "invalid_input",
      `\`${key}\` must be a STRING; a JSON ${typeof raw} was sent. Amounts and identifiers travel as `
      + "strings on this path so nothing is rounded on the way in.",
      { field: key },
    );
  }
  return accept(raw);
}

/** A positive integer in base units. Zero is refused: it is not a conversion. */
export function requireWrapAmountRaw(
  params: Record<string, unknown>,
  key: string,
): WrapOutcome<string> {
  const value = requireWrapString(params, key);
  if (!value.ok) return value;
  if (!/^[0-9]+$/.test(value.value)) {
    return refuse(
      "invalid_input",
      `\`${key}\` must be an amount in the token's smallest base units, written as decimal digits `
      + "only. It is not a decimal fraction and it carries no unit suffix.",
      { field: key },
    );
  }
  if (/^0+$/.test(value.value)) {
    return refuse(
      "invalid_input",
      `\`${key}\` must be greater than zero. A conversion of nothing has no effect to approve.`,
      { field: key },
    );
  }
  // Leading zeros are stripped so the stored amount, the digest preimage and
  // the `^[1-9][0-9]*$` column CHECK all see one spelling of one quantity.
  return accept(value.value.replace(/^0+/, ""));
}
