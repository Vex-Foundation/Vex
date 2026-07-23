/**
 * Relay request-id correlation contract (Wave-2 W2, R11).
 *
 * A `/quote/v2` response carries the intent id in up to three places: the
 * authoritative top-level `requestId`, each step's optional `requestId`, and the
 * `requestId` embedded in each status `check.endpoint`. Vex PERSISTS one id and
 * later POLLS one id; if those diverge it could confirm/abort the wrong intent.
 *
 * This is the fail-closed gate the handler (W3b) runs BEFORE intent creation and
 * signing: it asserts that EVERY id the quote's tracking surface carries
 * (step ids, check-endpoint ids, top-level WHEN present — live v2 responses
 * omit the top-level id entirely) agrees, that AT LEAST ONE source asserts an
 * id, AND that a top-level id, when present, is
 * affirmatively CORROBORATED by at least one step/check id (R11: mismatch OR
 * ABSENCE → abort pre-sign). A missing top-level id, ANY divergent step/check id,
 * or a top-level id that NOTHING in the quote's own tracking surface confirms is
 * a typed correlation failure → the handler aborts pre-sign. The corroboration
 * requirement closes the R11 "absence aborts" gap: a quote asserting a requestId
 * top-level that no step and no status-check endpoint agrees with cannot be
 * reliably tracked, so Vex never persists+polls an uncorroborated id.
 *
 * Relay's documented step shape carries no step-level `requestId` (it is optional
 * and typically absent); the intent id lives in each deposit item's status
 * `check.endpoint` (`/intents/status/v3?requestId=…`, the same source the
 * executor's poll-trust parser reads). So absence of a step-level id is NOT
 * itself a failure — the corroboration is expected to come from the check
 * endpoint. Requiring EVERY step to carry a requestId would deterministically
 * reject every real Relay quote; the corroboration rule instead demands that the
 * quote confirm its tracking id at least once, wherever it appears.
 *
 * Pure + typed: no IO, no config import. The caller passes the SAME Relay base
 * URL the client polls so relative `check.endpoint` values resolve identically.
 * This is a CONSISTENCY check (do the ids agree), distinct from the executor's
 * poll-SOURCE trust check (`parseRequestIdFromCheckEndpoint`, which additionally
 * pins host+path) — so a divergent id on ANY host is flagged (stricter =
 * fail-closed), while the executor decides which endpoint it will actually poll.
 */

import type { RelayQuoteResponse } from "./types.js";

export type RelayCorrelationFailureReason =
  | "missing_request_id"
  | "step_request_id_mismatch"
  | "check_endpoint_request_id_mismatch"
  | "request_id_uncorroborated";

export type RelayCorrelationResult =
  | { readonly ok: true; readonly requestId: string }
  | {
      readonly ok: false;
      readonly reason: RelayCorrelationFailureReason;
      /** The offending step id, or null for the missing top-level id. */
      readonly stepId: string | null;
      readonly detail: string;
    };

/**
 * Extract the `requestId` query param from a `check.endpoint` for a CONSISTENCY
 * comparison. Resolves relative endpoints against the Relay base URL. Returns
 * null on a parse failure or an absent/empty param (no id to compare, not a
 * mismatch). Deliberately does NOT pin host/path — that trust decision belongs
 * to the executor's poll-source parser; here a divergent id anywhere is enough
 * to fail closed.
 */
function checkEndpointRequestId(endpoint: string, allowedBaseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint, allowedBaseUrl);
  } catch {
    return null;
  }
  const id = parsed.searchParams.get("requestId");
  return id && id.length > 0 ? id : null;
}

/**
 * Assert the quote's request ids all agree. Success carries the authoritative
 * top-level id (what the handler persists + polls). The FIRST divergence (or the
 * absent top-level id) is returned as a typed failure — the handler aborts
 * pre-sign on it.
 */
export function assertRelayQuoteCorrelation(
  quote: RelayQuoteResponse,
  allowedBaseUrl: string,
): RelayCorrelationResult {
  // LIVE-VERIFIED 2026-07-23 (coordinator POST to api.relay.link/quote/v2,
  // base→robinhood native): the top-level `requestId` is ABSENT on a real v2
  // quote; the canonical id lives on the transaction STEP (`step.requestId`)
  // and inside each `check.endpoint` (`?requestId=…`), agreeing with each
  // other. So the contract is: collect every id the quote's own tracking
  // surface asserts (step ids + check-endpoint ids + top-level WHEN present);
  // they must ALL agree; at least one source must carry an id (else the
  // intent could never be tracked → missing_request_id, R11 absence-aborts).
  const topLevel = quote.requestId?.trim() || null;
  let canonical: string | null = topLevel;

  for (const step of quote.steps) {
    if (step.requestId) {
      if (canonical !== null && step.requestId !== canonical) {
        return {
          ok: false,
          reason: "step_request_id_mismatch",
          stepId: step.id,
          detail: `Relay step "${step.id}" requestId diverges from the quote's other request ids.`,
        };
      }
      canonical = step.requestId;
    }
    for (const item of step.items) {
      const endpoint = item.check?.endpoint;
      if (!endpoint) continue;
      const id = checkEndpointRequestId(endpoint, allowedBaseUrl);
      if (id === null) continue;
      if (canonical !== null && id !== canonical) {
        return {
          ok: false,
          reason: "check_endpoint_request_id_mismatch",
          stepId: step.id,
          detail: `Relay step "${step.id}" status check endpoint carries a requestId that diverges from the quote's other request ids.`,
        };
      }
      canonical = id;
    }
  }

  if (canonical === null) {
    return {
      ok: false,
      reason: "missing_request_id",
      stepId: null,
      detail:
        "Relay v2 quote asserts NO request id anywhere (top-level, step, or status-check "
        + "endpoint) — the intent could never be tracked, so signing is aborted (R11).",
    };
  }

  // A single-source id is acceptable ONLY when it is the step/check surface
  // (the same surface the poller trusts). A top-level id corroborated by no
  // step/check id remains an abort — it is an assertion the tracking surface
  // never confirms.
  if (topLevel !== null && canonical === topLevel) {
    let corroborated = false;
    for (const step of quote.steps) {
      if (step.requestId === topLevel) corroborated = true;
      for (const item of step.items) {
        const endpoint = item.check?.endpoint;
        if (endpoint && checkEndpointRequestId(endpoint, allowedBaseUrl) === topLevel) {
          corroborated = true;
        }
      }
    }
    if (!corroborated) {
      return {
        ok: false,
        reason: "request_id_uncorroborated",
        stepId: null,
        detail:
          "Relay v2 quote's top-level requestId is corroborated by no step or status-check id — "
          + "the intent could not be reliably tracked, so signing is aborted (R11 absence-aborts).",
      };
    }
  }

  return { ok: true, requestId: canonical };
}
