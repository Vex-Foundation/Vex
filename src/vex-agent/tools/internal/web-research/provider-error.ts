/**
 * Provider failures, restated in Vex's own words.
 *
 * A Tavily error string is NOT diagnostics — it is untrusted content on the same
 * footing as the page body. Two facts make that concrete. The SDK throws
 * `` `${status} Error: ${JSON.stringify(res.data)}` `` and, whenever the API
 * fills `detail.error`, it throws that provider prose ALONE, with no status and
 * no marker (`node_modules/@tavily/core/dist/index.js:182-190`). And the
 * per-URL `failedResults[].error` of a 200 response describes a fetch of a page
 * the attacker controls, so its text is partly reflected from that page.
 *
 * Forwarded verbatim — which is what `fail(`Fetch failed: ${msg}`)` did — that
 * prose lands in `ToolResult.output`, which IS the model's transcript, and in
 * `logger` payloads. `rules/07`: provider output is data, never instruction.
 * `rules/06`: nothing free-text from a provider reaches a log sink.
 *
 * So EVERY provider failure collapses to one of three Vex-owned codes carrying a
 * STATIC message. The only provider-derived value that survives is a validated
 * HTTP status NUMBER — a bounded class, not text — which is what makes a log
 * line still worth reading.
 *
 * WHAT AN ATTACKER CAN STILL DO: steer which of the three codes it gets, because
 * telling a timeout from a refusal means reading provider text. That is the
 * bounded price of keeping a distinction the agent acts on (retry vs. change
 * source); the worst case is one safe label instead of another safe label, never
 * injected prose. Adding a fourth code, or any interpolation, would reopen the
 * hole this module exists to close.
 */

/** The whole agent-facing vocabulary for a provider failure. */
export type WebResearchErrorCode =
  | "provider_rejected"
  | "provider_timeout"
  | "unreadable_content";

export interface WebResearchFailure {
  readonly code: WebResearchErrorCode;
  /** Vex-authored and STATIC — never interpolates provider text. */
  readonly message: string;
  /** A validated HTTP status when one is recoverable; a number or nothing. */
  readonly httpStatus: number | null;
}

/**
 * Hedged on purpose (`rules/90`): we report what we can prove — the provider
 * refused, timed out, or handed back nothing readable — and offer the cause only
 * as a possibility, because the error text that would settle it is exactly the
 * text we refuse to trust.
 */
const STATIC_MESSAGES: Readonly<Record<WebResearchErrorCode, string>> = {
  provider_rejected:
    "the research provider refused this request. The source may block automated reads, "
    + "or the provider may be rate-limiting. Try a different source.",
  provider_timeout:
    "the research provider did not answer within the request timeout. Retry once, or "
    + "narrow the query.",
  unreadable_content:
    "the research provider returned no readable text for this page. It may be paywalled, "
    + "script-rendered, or not a text document. Use a different source.",
};

/**
 * A failure Vex determined from the response SHAPE alone — no provider error
 * text was involved, so there is nothing to classify.
 */
export const UNREADABLE_CONTENT_FAILURE: WebResearchFailure = Object.freeze({
  code: "unreadable_content",
  message: STATIC_MESSAGES.unreadable_content,
  httpStatus: null,
});

/**
 * Classification reads at most this many characters. The signal always sits at
 * the front (a status prefix, "Request timed out after…"), while the tail can be
 * an arbitrarily long JSON body the provider chose — which is cost we decline to
 * pay, and pattern-matching surface we decline to expose.
 */
const CLASSIFIED_PREFIX_LENGTH = 512;

const TIMEOUT_SIGNAL = /timed out|timeout|econnaborted|etimedout|aborterror/i;

/**
 * Extraction/shape failures. Kept to simple alternations with no nested
 * quantifiers: the input is attacker-chosen, so the matcher must stay linear.
 */
const UNREADABLE_SIGNAL =
  /unreadable|malformed|failed to extract|extraction failed|could not (?:be )?(?:parse|read|extract)|cannot (?:parse|read|extract)|pars(?:e|ing) error|empty content|no (?:usable |readable )?content|unsupported (?:content|file|media) type/i;

const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

/** Everything readable about the failure, bounded — used ONLY to pick a code. */
function classificationSignals(error: unknown): string {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : isRecord(error)
          ? stringField(error, "message")
          : String(error ?? "");
  // `code` carries ECONNABORTED/ETIMEDOUT on an Axios failure; `name` carries
  // AbortError. Both are transport facts the message may not repeat.
  return [text, stringField(error, "code"), stringField(error, "name")]
    .join(" ")
    .slice(0, CLASSIFIED_PREFIX_LENGTH);
}

function validStatus(value: number): number | null {
  return Number.isInteger(value) && value >= MIN_HTTP_STATUS && value <= MAX_HTTP_STATUS
    ? value
    : null;
}

/**
 * Recover an HTTP status as a NUMBER. Structured fields first; failing that, the
 * two anchored forms the provider actually emits — the SDK's own
 * `` `${status} Error: ` `` prefix and Axios's "status code NNN" tail. Reading a
 * number out of provider text is not a text leak: only the validated integer
 * ever leaves this function, and only within 100-599.
 */
function readHttpStatus(error: unknown, signals: string): number | null {
  if (isRecord(error)) {
    const direct = error.status;
    if (typeof direct === "number") {
      const valid = validStatus(direct);
      if (valid !== null) return valid;
    }
    const response = error.response;
    if (isRecord(response) && typeof response.status === "number") {
      const valid = validStatus(response.status);
      if (valid !== null) return valid;
    }
  }

  const leading = /^\s*(\d{3})\b/.exec(signals);
  if (leading?.[1]) {
    const valid = validStatus(Number(leading[1]));
    if (valid !== null) return valid;
  }

  const tagged = /status code (\d{3})\b/i.exec(signals);
  if (tagged?.[1]) return validStatus(Number(tagged[1]));

  return null;
}

/**
 * Classify anything a provider failure can arrive as: a thrown SDK error, an
 * Axios-shaped object, or the `failedResults[].error` string of a 200 response
 * (which is typed `string` but, being provider data, is validated as `unknown`).
 *
 * PRECEDENCE — timeout, then HTTP status, then shape:
 *  - a timeout is a transport fact the agent acts on differently (retry), so it
 *    wins outright;
 *  - a status means the provider refused at the HTTP level, which is a stronger
 *    statement about what happened than any wording inside the body;
 *  - only with neither does the text decide, and the default is the honest
 *    "refused" rather than a claim about the page's content.
 */
export function classifyProviderFailure(error: unknown): WebResearchFailure {
  const signals = classificationSignals(error);
  const httpStatus = readHttpStatus(error, signals);

  const code: WebResearchErrorCode = TIMEOUT_SIGNAL.test(signals)
    ? "provider_timeout"
    : httpStatus !== null
      ? "provider_rejected"
      : UNREADABLE_SIGNAL.test(signals)
        ? "unreadable_content"
        : "provider_rejected";

  return { code, message: STATIC_MESSAGES[code], httpStatus };
}

/**
 * The code the agent branches on, plus the provider's own status WHENEVER one
 * was recovered — `provider_rejected, HTTP 429`.
 *
 * The status was already validated to a bounded integer in 100-599 and was
 * already considered safe enough to log; withholding it from the agent while
 * keeping it in an operator's log file is the split that made a 429 and a 403
 * read identically to the only reader who could act on the difference (W1
 * contract, `renderProtocolFailureOutput`, which uses this same `, HTTP <n>`
 * clause). No prose crosses: only `Number` output.
 */
export function providerFailureReason(failure: WebResearchFailure): string {
  return failure.httpStatus === null ? failure.code : `${failure.code}, HTTP ${failure.httpStatus}`;
}

/** What the agent reads: the reason it can branch on, then the static sentence. */
export function providerFailureMessage(failure: WebResearchFailure): string {
  return `${providerFailureReason(failure)} — ${failure.message}`;
}

/**
 * What the log line carries. The code plus, when we have one, the status class —
 * and deliberately no `error` field, because that field is what leaked.
 */
export function providerFailureLogFields(
  failure: WebResearchFailure,
): { errorCode: WebResearchErrorCode; httpStatus?: number } {
  return failure.httpStatus === null
    ? { errorCode: failure.code }
    : { errorCode: failure.code, httpStatus: failure.httpStatus };
}
