/**
 * Shared failure rendering for the Morpho handlers.
 *
 * Produces the tail of the format `agents_dm/tool-audit-2026-08/RULES-DRAFT.md`
 * fixes for every agent-facing tool error:
 *
 *   <toolId> failed [<CODE>/<category>, HTTP <status>]: <sanitized cause> - <remediation>
 *
 * The handler supplies the `<toolId> failed ` prefix; everything from the
 * bracket onwards is built here, from the error the client layer already
 * classified. Three rules hold:
 *
 *  - the STATUS survives (`httpStatus` is read, never re-derived from text);
 *  - the CAUSE is the provider's own words, already sanitized in
 *    `tools/morpho/errors.ts`, never replaced by a guess;
 *  - the REMEDIATION is appended, never substituted for the cause.
 *
 * There is no catch-all branch. A failure that reached here without a VexError
 * still reports what actually arrived rather than a fixed sentence -
 * `generic-error-literal` in the manifest linter exists because a diagnosable
 * failure reported under a vague label makes the agent retry blind.
 */

import { VexError } from "../../../../../errors.js";
import { sanitizeMorphoCause } from "@tools/morpho/errors.js";

/** Coarse class an agent can branch on: is retrying this ever going to work? */
function category(err: VexError): string {
  if (err.code === "MORPHO_BUDGET_EXHAUSTED") return "client_throttle";
  if (err.code === "MORPHO_RATE_LIMITED") return "provider_throttle";
  if (err.code === "MORPHO_TIMEOUT") return "transport";
  if (err.code === "MORPHO_INVALID_RESPONSE") return "contract_drift";
  if (err.code === "MORPHO_MARKET_NOT_FOUND" || err.code === "MORPHO_VAULT_NOT_FOUND") return "not_found";
  if (err.code === "INVALID_ADDRESS") return "bad_request";
  if (err.code === "MORPHO_UNSUPPORTED_CHAIN" || err.code === "AGENT_VALIDATION_ERROR") return "bad_request";
  return err.retryable === true ? "provider_error" : "provider_refusal";
}

/**
 * `[<CODE>/<category>, HTTP <status>]: <cause> - <remediation>`.
 *
 * `HTTP <status>` is omitted rather than faked when nothing answered: an
 * invented status would erase the difference between "Morpho refused" and "we
 * never reached Morpho", which is the distinction rules/90 requires a money-
 * adjacent read to preserve.
 */
export function morphoFailureDetail(err: unknown): string {
  if (err instanceof VexError) {
    const status = err.httpStatus === undefined ? "" : `, HTTP ${err.httpStatus}`;
    const remedy = err.hint === undefined ? "" : ` - ${err.hint}`;
    return `[${err.code}/${category(err)}${status}]: ${sanitizeMorphoCause(err.message)}${remedy}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `[MORPHO_UNCLASSIFIED/transport]: ${sanitizeMorphoCause(message)}`
    + " - the failure did not come from Morpho's API layer; report it verbatim rather than retrying blind.";
}
