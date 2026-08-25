/**
 * The Vex Studio REFUSAL BODY - one owner for the sentence an external agent
 * reads and for the settlement row that proves it.
 *
 * Two callers need exactly the same pair of facts and must not drift on them:
 * the approved-dispatch path, which refuses before or instead of dispatching,
 * and the abandoned-dispatch reconciler. Both write a terminal row AND answer a
 * blocked MCP call, so both need the same body: the human sentence, its
 * serialized form, its byte size, and its hash.
 *
 * The sentence always states three things, in this order: what did not happen,
 * that nothing was executed and no funds moved, and what to do next. That last
 * clause is the actionable part and it is why these are not one-word errors.
 */

import type { ToolResult } from "@vex-agent/tools/types.js";

import { shortSha256 } from "../helpers.js";
import { encodeStudioSettlement } from "./settlement-codec.js";

/** Everything a refusal write and its caller's answer need, computed once. */
export interface StudioRefusalSettlement {
  readonly output: string;
  readonly settlementJson: string;
  readonly settlementBytes: number;
  readonly resultHash: string;
}

/**
 * The agent- and user-facing refusal of an APPROVED action that did not run.
 * `cause` completes "Approved action refused: ...".
 */
export function studioRefusalText(cause: string): string {
  return (
    `Approved action refused: ${cause}. Nothing was executed and no funds moved. `
    + "Request the action again if you still want it."
  );
}

/**
 * The whole refusal, as a stored `ToolResult` and as the strings the CAS needs.
 * `success: false` because the action did not happen; the row it is written to
 * is terminal, so nothing can later contradict it.
 */
export function buildStudioRefusalSettlement(
  cause: string,
): StudioRefusalSettlement {
  const result: ToolResult = { success: false, output: studioRefusalText(cause) };
  const encoded = encodeStudioSettlement(result);
  return {
    output: result.output,
    settlementJson: encoded.json,
    settlementBytes: encoded.bytes,
    resultHash: shortSha256(encoded.json),
  };
}
