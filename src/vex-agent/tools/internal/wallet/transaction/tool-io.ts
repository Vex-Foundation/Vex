/**
 * Param reading and refusal rendering for the generic signing prepare tools.
 *
 * A refusal is a DOMAIN OUTCOME, not an infrastructure failure, so it becomes a
 * `ToolResult` whose `output` is the refusal sentence and whose `data` carries
 * the structural details the caller can act on: the labelled fee estimates, the
 * offending field name, the decoded revert reason. The model reads the
 * sentence; a program reads the details; neither has to parse the other's half.
 *
 * The `refusalCode` is exported alongside so a caller can branch on WHY without
 * string-matching the prose, which is what makes the copy safe to improve.
 */

import type { ToolResult } from "../../../types.js";

import { accept, refuse, type TransactionOutcome, type TransactionRefusal } from "./refusal.js";

export function refusalToResult(refusal: TransactionRefusal): ToolResult {
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
 * A required string param, or an optional one with a default. A JSON number is
 * refused as a wrong TYPE rather than coerced: on this path a number is how an
 * amount arrives after arithmetic, and coercing it would print a float.
 */
export function requireString(
  params: Record<string, unknown>,
  key: string,
  fallback?: string,
): TransactionOutcome<string> {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    if (fallback !== undefined) return accept(fallback);
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

/** 0x-prefixed, even-length hex. `0x` itself is legal and means "no calldata". */
export function requireHexData(
  params: Record<string, unknown>,
  key: string,
): TransactionOutcome<string> {
  const value = requireString(params, key, "0x");
  if (!value.ok) return value;
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value.value)) {
    return refuse(
      "invalid_input",
      `\`${key}\` must be 0x-prefixed hex with an even number of digits. Pass \`0x\` for a plain `
      + "native transfer.",
      { field: key },
    );
  }
  return accept(value.value);
}
