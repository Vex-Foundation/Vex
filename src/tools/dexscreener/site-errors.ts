/**
 * Error codes for the DexScreener SITE surface (transport seam and codecs).
 *
 * These are deliberately separate from `ErrorCodes.DEXSCREENER_*` in
 * `src/errors.ts`, which the still-live public-API tools own. The site surface
 * lands in stages; folding these into the central table is an S5 concern, when
 * the old tools and their codes are removed. `VexError.code` is a plain
 * string, so nothing forces the two tables to merge before then.
 *
 * The distinction that matters to the agent: "the site transport is not
 * mounted in this process" is NOT a provider outage. It means the caller is
 * running headless (CLI, tests, CI) where only `api.dexscreener.com` is
 * reachable, and the remedy is to run inside the desktop app or to use a tool
 * that can degrade to the public API.
 */

import { VexError } from "../../errors.js";

export const DexScreenerSiteErrorCodes = {
  /** The registered transport cannot reach the site (headless context). */
  SITE_TRANSPORT_UNAVAILABLE: "DEXSCREENER_SITE_TRANSPORT_UNAVAILABLE",
  /** The requested URL is outside what this transport is allowed to fetch. */
  TRANSPORT_HOST_NOT_ALLOWED: "DEXSCREENER_TRANSPORT_HOST_NOT_ALLOWED",
  /** A second transport tried to claim the single-owner registry slot. */
  TRANSPORT_ALREADY_REGISTERED: "DEXSCREENER_TRANSPORT_ALREADY_REGISTERED",
  /** The request was aborted by the caller's signal. */
  TRANSPORT_CANCELLED: "DEXSCREENER_TRANSPORT_CANCELLED",
  /** The request exceeded the caller-supplied deadline. */
  TRANSPORT_TIMEOUT: "DEXSCREENER_TRANSPORT_TIMEOUT",
  /** The request never produced a response (network or bridge failure). */
  TRANSPORT_FAILED: "DEXSCREENER_TRANSPORT_FAILED",
  /**
   * The provider refused the WebSocket UPGRADE itself, with HTTP 422 and a
   * zero-byte body.
   *
   * This is a CALLER-GRAMMAR refusal and it is permanent. Measured triggers:
   * an out-of-vocabulary `rankBy[key]`, the right key in the wrong case, an
   * unknown `rankBy[order]`, an unknown timeframe, a non-numeric `page`, and a
   * non-numeric filter value. The provider supplies no machine-readable reason
   * (the body is empty and there is no header), so the reason is ours to state.
   *
   * It is separated from `TRANSPORT_FAILED` because the remedies are opposites:
   * a transport failure is worth retrying and says nothing about the request,
   * while this one will fail identically forever until the request is spelled
   * differently. Measured discrimination (S8, io.dexscreener.com): with upgrade
   * headers, a good grammar reaches the backend and a refused grammar returns
   * 422 at the edge with a zero-byte body; without upgrade headers BOTH return
   * 404, so only the upgrade response can tell them apart.
   */
  WS_UPGRADE_REFUSED: "DEXSCREENER_WS_UPGRADE_REFUSED",
  /** A response body exceeded the caller-supplied byte cap. */
  RESPONSE_OVER_CAP: "DEXSCREENER_RESPONSE_OVER_CAP",
  /** A message name that no caller is allowed to decode was requested. */
  DECODE_MESSAGE_NOT_ALLOWED: "DEXSCREENER_DECODE_MESSAGE_NOT_ALLOWED",
  /** The bytes did not decode against the declared schema. */
  DECODE_FAILED: "DEXSCREENER_DECODE_FAILED",

  /* --- screening surface (S2a) --------------------------------------- */

  /**
   * A screener filter name that must not reach the wire. The provider fails
   * OPEN on unknown filter names (silently dropped) and on a measured family
   * it accepts and ignores, so refusing by name here is the only way an agent
   * learns that the screen it asked for did not happen.
   */
  SCREEN_FILTER_NOT_SUPPORTED: "DEXSCREENER_SCREEN_FILTER_NOT_SUPPORTED",
  /** A rankBy key this build does not expose. An invalid key makes the WS upgrade fail with 422. */
  SCREEN_RANK_KEY_NOT_SUPPORTED: "DEXSCREENER_SCREEN_RANK_KEY_NOT_SUPPORTED",
  /** A threshold value that cannot be rendered on the wire (non-finite, or exponent form). */
  SCREEN_FILTER_VALUE_INVALID: "DEXSCREENER_SCREEN_FILTER_VALUE_INVALID",
  /** The screener channel never sent a result frame within the frames collected. */
  SCREEN_NO_RESULT_FRAME: "DEXSCREENER_SCREEN_NO_RESULT_FRAME",
  /** A provider catalog response did not satisfy the fields we depend on. */
  CATALOG_INVALID: "DEXSCREENER_CATALOG_INVALID",
  /** A chain slug that the catalog does not contain. Carries candidates, never zero rows. */
  CHAIN_SLUG_UNKNOWN: "DEXSCREENER_CHAIN_SLUG_UNKNOWN",
  /** A provider row could not be projected because a field we depend on was absent or the wrong shape. */
  ROW_SHAPE_UNEXPECTED: "DEXSCREENER_ROW_SHAPE_UNEXPECTED",

  /* --- resolve and market context (S3) ------------------------------- */

  /** A command message name that no caller is allowed to serialize. */
  ENCODE_MESSAGE_NOT_ALLOWED: "DEXSCREENER_ENCODE_MESSAGE_NOT_ALLOWED",
  /** A command could not be built from the values given. Our defect, not the provider's. */
  ENCODE_FAILED: "DEXSCREENER_ENCODE_FAILED",
  /**
   * The search endpoint refused the request as spelled: HTTP 4xx with a
   * zero-byte body.
   *
   * Deterministic and permanent. Measured 2026-08-25: a query shorter than two
   * characters, an empty query, and any bracketed parameter name each answer
   * 400 with no body, identically, every time. Separated from
   * SCREEN_NO_RESULT_FRAME because the remedies are opposites: a 5xx says
   * nothing about the request and is worth one retry, this one will be refused
   * the same way until the query itself changes.
   */
  SEARCH_REQUEST_REFUSED: "DEXSCREENER_SEARCH_REQUEST_REFUSED",
  /** The single-pair channel never sent a pair snapshot within the frames collected. */
  PAIR_NO_SNAPSHOT_FRAME: "DEXSCREENER_PAIR_NO_SNAPSHOT_FRAME",
  /**
   * The single-pair channel answered that it indexes no such pool.
   *
   * The provider says this with a 2-byte frame decoding to `{"pair":{}}`: the
   * `pair` oneof arm, present and EMPTY. Measured 2026-08-25 on a well-formed
   * but unindexed ethereum address and on an unknown chain slug alike, arriving
   * at 0.470 s, on the same tick a real snapshot would have arrived, and
   * re-sent forever afterwards.
   *
   * IT IS AN ANSWER, WHICH IS WHY IT IS NOT A RETRY AND NOT A TIMEOUT. Waiting
   * longer or asking again returns the identical empty arm, so the caller
   * raises it on the FIRST attempt. Before this code existed, an unknown pool
   * spent one 20 s attempt, one retry that could not complete by arithmetic,
   * and then reported DEXSCREENER_TRANSPORT_TIMEOUT about 33 s later, which
   * reads to an agent as a provider outage rather than "that pool is not
   * indexed here". Distinct from PAIR_NO_SNAPSHOT_FRAME, which means frames of
   * OTHER kinds arrived and no pair arm ever did: that one is worth one retry
   * and says nothing about whether the pool exists.
   */
  PAIR_UNKNOWN: "DEXSCREENER_PAIR_UNKNOWN",
  /** The v8 batch channel never sent a rows frame within the frames collected. */
  BATCH_NO_RESULT_FRAME: "DEXSCREENER_BATCH_NO_RESULT_FRAME",
  /** A batch call named no identity at all, so there is nothing to resolve. */
  BATCH_NO_INPUTS: "DEXSCREENER_BATCH_NO_INPUTS",
  /** The spotlight endpoint did not answer with a document we can project. */
  SPOTLIGHT_INVALID: "DEXSCREENER_SPOTLIGHT_INVALID",
  /** A pair lookup named neither a pair address nor a token address. */
  PAIR_IDENTITY_MISSING: "DEXSCREENER_PAIR_IDENTITY_MISSING",
  /** A token address resolved to no pair in the provider's bounded search window. */
  PAIR_NOT_RESOLVED: "DEXSCREENER_PAIR_NOT_RESOLVED",

  /* --- agent surface (S2b) ------------------------------------------- */

  /**
   * A `fields` value naming a row field GROUP that does not exist. Refused by
   * name rather than ignored: silently dropping it would ship the default
   * projection while the agent believed it had asked for more.
   */
  SCREEN_FIELD_GROUP_UNKNOWN: "DEXSCREENER_SCREEN_FIELD_GROUP_UNKNOWN",
  /** A shaping parameter (`limit`, `offset`) outside the range the tool accepts. */
  SCREEN_SHAPING_VALUE_INVALID: "DEXSCREENER_SCREEN_SHAPING_VALUE_INVALID",

  /* --- narratives (S3.5) --------------------------------------------- */

  /**
   * The narratives endpoint answered with something that is not a narratives
   * document: a non-200, or bytes the Avro table does not decode.
   *
   * Distinct from `DECODE_FAILED` because the remedy differs: this channel has
   * its own captured fixture and schema table, so the action is to re-capture
   * and update that table rather than to inspect the protobuf descriptors.
   */
  NARRATIVES_INVALID: "DEXSCREENER_NARRATIVES_INVALID",
  // NARRATIVES_CHAIN_NOT_SUPPORTED was removed in S8. It refused any chain
  // whose catalog entry had `metasEnabled: false`, on the reasoning that an
  // empty success would read as "no narrative is moving there". The premise
  // was measured false: `metasEnabled` is a SITE-VISIBILITY label, not a data
  // gate, and narratives aggregate normally on chains the site does not
  // surface (robinhood, ton, polygon). The refusal was therefore denying real
  // data. A chain with no activity now answers "0 of 18 active", which states
  // the quiet case without inventing an absence; the only refusal left is a
  // slug that is not a chain at all.

  /* --- deep dive (S4) ------------------------------------------------ */

  /**
   * The pair-details endpoint answered with something that is not a
   * pair-details document: a non-200, or bytes that are not the JSON shape.
   *
   * Deliberately NOT collapsed into a generic failure: on this channel the
   * difference between "the endpoint did not answer" and "the endpoint said
   * the token is clean" is the whole product, and rule 90 forbids the second
   * reading of the first fact.
   */
  PAIR_DETAILS_INVALID: "DEXSCREENER_PAIR_DETAILS_INVALID",
  /** The provider knows no pair-details document for this identity on this chain. */
  PAIR_DETAILS_UNKNOWN: "DEXSCREENER_PAIR_DETAILS_UNKNOWN",

  /** The bars endpoint answered with something that is not a bars document. */
  BARS_INVALID: "DEXSCREENER_BARS_INVALID",
  /**
   * The bars endpoint failed in a way that a later identical read may not.
   *
   * S10-49. A transient provider 5xx on an idempotent read was classified
   * BARS_INVALID, whose remediation tells the caller to check the AMM id and
   * quote token - fields the manifest states this tool resolves ITSELF, so the
   * advice named nothing the caller could act on. Measured: one 500 followed
   * seconds later by 8 probes all answering 200. A read that may simply
   * succeed on retry is a different outcome from a malformed document and gets
   * its own code, so the caller can tell "try again" from "stop".
   */
  BARS_PROVIDER_TRANSIENT: "DEXSCREENER_BARS_PROVIDER_TRANSIENT",
  /**
   * A candle resolution the chosen transport does not serve.
   *
   * Named rather than silently re-routed: HTTP answers 400 for daily and above
   * and for 5s, and the WebSocket serves them. The tool picks the transport
   * itself, so this code fires only when NEITHER can serve the value.
   */
  BARS_RESOLUTION_UNSUPPORTED: "DEXSCREENER_BARS_RESOLUTION_UNSUPPORTED",
  /** The feed socket never sent a historical-bars frame for this correlation id. */
  BARS_NO_RESULT_FRAME: "DEXSCREENER_BARS_NO_RESULT_FRAME",
  /**
   * The quote token could not be established from the resolved pair.
   *
   * Fails CLOSED: a wrong `q` returns a silently INVERTED series that is
   * byte-identical in shape to a correct one (measured), so a candle series
   * with an unproven quote is refused rather than returned.
   */
  BARS_QUOTE_UNRESOLVED: "DEXSCREENER_BARS_QUOTE_UNRESOLVED",

  /** The trades channel answered with something that is not a transactions document. */
  TRADES_INVALID: "DEXSCREENER_TRADES_INVALID",
  /** The feed socket never sent a historical-transactions frame for this correlation id. */
  TRADES_NO_RESULT_FRAME: "DEXSCREENER_TRADES_NO_RESULT_FRAME",
  /**
   * A continuation cursor this build did not issue, or one bound to a
   * different request than the one replaying it.
   *
   * Refused rather than reinterpreted: the cursor carries the exact
   * `(blockNumber, transactionIndex, eventIndex)` triple, and honouring it
   * against a different pair, orientation or filter would silently answer a
   * question nobody asked.
   */
  TRADES_CURSOR_INVALID: "DEXSCREENER_TRADES_CURSOR_INVALID",

  /** The top-traders endpoint answered with something that is not a leaderboard. */
  TOP_TRADERS_INVALID: "DEXSCREENER_TOP_TRADERS_INVALID",

  /**
   * The pair's AMM id could not be resolved.
   *
   * Every deep-dive channel is keyed by `typeAMM.a` and a wrong value answers
   * HTTP 200 with zero rows (measured). An unresolved AMM id is therefore a
   * refusal, never an empty series that reads as "nothing traded".
   */
  AMM_ID_UNRESOLVED: "DEXSCREENER_AMM_ID_UNRESOLVED",
} as const;

export type DexScreenerSiteErrorCode =
  (typeof DexScreenerSiteErrorCodes)[keyof typeof DexScreenerSiteErrorCodes];

/**
 * A typed site-surface failure.
 *
 * `hint` carries the remedy, not the cause, and is written for the agent: it
 * says what to do next, never "unexpected error". Nothing here is truncated;
 * these messages are assembled from our own bounded facts (names, counts,
 * caps), never from provider payload text.
 */
export function siteError(
  code: DexScreenerSiteErrorCode,
  message: string,
  hint?: string
): VexError {
  return new VexError(code, terminated(message), hint);
}

/**
 * End a refusal message with a full stop, so the hint that follows it starts a
 * new sentence.
 *
 * S10-29/S10-43/S10-48. The presenter concatenates the message and the hint
 * with a single space, and most of the messages on this surface are written as
 * fragments ending in a value or a slug. The result reached agents as run-on
 * text - "did you mean robinhood The screener answers an unknown chain...",
 * "in the catalog The screener answers..." - three separate reports flagged it
 * on three different tools.
 *
 * ONE OWNER RATHER THAN A SWEEP OF FIFTY LITERALS: a per-string sweep fixes
 * today's messages and cannot stop tomorrow's, and a message that already ends
 * in punctuation is left exactly as written. NOTHING IS EVER REMOVED here; the
 * only edit possible is appending one character.
 */
function terminated(message: string): string {
  const last = message.trimEnd().slice(-1);
  if (last === "" || ".!?:;".includes(last)) return message;
  return `${message}.`;
}

const SITE_CODES: ReadonlySet<string> = new Set(
  Object.values(DexScreenerSiteErrorCodes)
);

/**
 * True when `error` is one of THIS module's typed failures.
 *
 * Used at boundaries that re-wrap unknown throwables: our own outcome must pass
 * through with its code and remedy intact instead of being flattened into a
 * generic transport failure.
 */
export function isDexScreenerSiteError(error: unknown): error is VexError {
  return error instanceof VexError && SITE_CODES.has(error.code);
}

/** True when `error` is a site-surface failure carrying `code`. */
export function isSiteError(
  error: unknown,
  code: DexScreenerSiteErrorCode
): error is VexError {
  return error instanceof VexError && error.code === code;
}
