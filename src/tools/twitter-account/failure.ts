/**
 * What a `twitter_account` request failure IS — the whole agent-facing vocabulary.
 *
 * The rule is the web lane's rule (`web-research/provider-error.ts`), applied to
 * the second tool that had the same hole: provider error text is untrusted
 * content, so it selects a Vex-owned code and is then discarded. Nothing the
 * provider wrote reaches `ToolResult.output`.
 *
 * WHY A SIBLING MODULE RATHER THAN SHARING THE WEB ONE:
 *  1. Import direction. The web module lives under `vex-agent/tools/internal/`,
 *     and `src/tools/` is imported BY that layer, never the reverse. Reaching
 *     back up would invert the one-way direction `rules/04` asks for.
 *  2. Different vocabularies. This tool needs `auth_failed` and `rate_limited`
 *     because its credentials expire and it is rate-limited; the web tool needs
 *     `unreadable_content` for page extraction. One merged enum would give each
 *     tool codes that can never occur — a wider contract than either tool's truth.
 *  3. Different inputs. Tavily stringifies its status INTO the message, so that
 *     classifier must pattern-match prose. Rettiwt hands us a real number on a
 *     typed error, so this one reads structure and barely touches text. Sharing
 *     would force the cheaper path through the more dangerous one.
 *
 * WHAT ARRIVES HERE (`node_modules/rettiwt-api/dist/services/internal/ErrorService.js`):
 *  - `TwitterError` for any Axios failure: `status` is a number, `message` is
 *    Axios's template, and `details[]` holds X's own error objects — the richest
 *    prose channel in this tool, and the one a denylist would never have covered.
 *  - `new Error('Unknown error')` for every non-Axios throwable.
 *  - and, because `catch` binds whatever was thrown, anything at all.
 */

import { RETTIWT_API_KEY_ENV } from "./types.js";

/**
 * Two of these codes exist to keep a distinction the agent ACTS on (`rules/90`):
 * `auth_failed` means fix the credentials, `rate_limited` means back off and
 * retry. Collapsing either into `provider_rejected` would tell the agent a
 * recoverable failure was final — the old prose carried that signal, so bounding
 * it away would have been a regression, not a fix.
 */
export type TwitterFailureCode =
  | "auth_failed"
  | "rate_limited"
  | "provider_timeout"
  | "provider_rejected"
  | "unreadable_content"
  | "user_not_found";

export interface TwitterAccountFailure {
  readonly code: TwitterFailureCode;
  /** Vex-authored and STATIC — never interpolates provider text. */
  readonly message: string;
  /** A validated HTTP status when one is recoverable; a number or nothing. */
  readonly httpStatus: number | null;
}

const STATIC_MESSAGES: Readonly<Record<TwitterFailureCode, string>> = {
  auth_failed:
    `Twitter/X rejected the credentials. Check that ${RETTIWT_API_KEY_ENV} is set and still `
    + "valid — a Rettiwt key is captured from a browser session and expires. Retrying will not "
    + "help until it is replaced.",
  rate_limited:
    "Twitter/X is rate-limiting this account. Wait before retrying; the request itself was "
    + "well-formed.",
  provider_timeout:
    "Twitter/X did not answer within the request timeout. Retry once, or ask for fewer rows.",
  provider_rejected:
    "Twitter/X refused this request. The account or post may be protected, suspended, or "
    + "deleted, or the credentials may no longer be accepted for it.",
  unreadable_content:
    "Twitter/X returned a response this tool could not read. Retry once; if it repeats, the "
    + "upstream response shape has changed.",
  user_not_found:
    "No Twitter/X account matches the requested handle or id. Check the spelling — the account "
    + "may also be suspended or renamed.",
};

/**
 * A failure VEX raised about its own request — a missing key, an unusable
 * response shape, a handle that does not resolve. Carrying the code on a typed
 * error is what lets the classifier tell our own failures from the provider's
 * without trusting any message text: everything else is bounded by default.
 */
export class TwitterAccountRequestError extends Error {
  readonly failureCode: TwitterFailureCode;

  constructor(failureCode: TwitterFailureCode) {
    super(STATIC_MESSAGES[failureCode]);
    this.name = "TwitterAccountRequestError";
    this.failureCode = failureCode;
  }
}

/**
 * Classification reads at most this many characters — the signal is at the front
 * of an Axios message, while the tail can be arbitrarily long provider content.
 */
const CLASSIFIED_PREFIX_LENGTH = 512;

const TIMEOUT_SIGNAL = /timeout|timed out|econnaborted|etimedout|aborterror/i;

const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function validStatus(value: number): number | null {
  return Number.isInteger(value) && value >= MIN_HTTP_STATUS && value <= MAX_HTTP_STATUS
    ? value
    : null;
}

/** Only enough text to pick a code — never enough to quote. */
function classificationSignals(error: unknown): string {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : isRecord(error)
          ? stringField(error, "message")
          : String(error ?? "");
  // `code` carries ECONNABORTED/ETIMEDOUT on a transport failure — a fact the
  // message does not always repeat.
  return [text, stringField(error, "code")].join(" ").slice(0, CLASSIFIED_PREFIX_LENGTH);
}

/**
 * Structured first: `TwitterError.status` and `AxiosError.status` are real
 * numbers (axios 1.14 sets `status` from the response), so no parsing is needed
 * for the normal case. The text form is a fallback for an error that names its
 * status only in Axios's own template. Either way a validated integer is the
 * only thing that leaves.
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

  const tagged = /status code (\d{3})\b/i.exec(signals);
  return tagged?.[1] ? validStatus(Number(tagged[1])) : null;
}

function failureOf(code: TwitterFailureCode, httpStatus: number | null): TwitterAccountFailure {
  return { code, message: STATIC_MESSAGES[code], httpStatus };
}

/**
 * Classify anything a failed request can throw.
 *
 * PRECEDENCE:
 *  1. Our own typed error — the code is already known, and its message is ours.
 *  2. Timeout, ahead of any status. `TwitterError` stamps `status = error.status
 *     ?? 500`, so a transport failure ARRIVES looking like a server error; the
 *     timeout signal is the only thing that tells them apart.
 *  3. The status class: 401 means the credentials were rejected, 429 means back
 *     off. 403 deliberately stays `provider_rejected` — X returns it both for a
 *     protected or suspended resource and for credentials it no longer accepts,
 *     and telling the agent to replace a working key would be a claim the
 *     evidence does not support (`rules/90`).
 *  4. Anything else is an honest refusal rather than a guess about the cause.
 */
export function classifyTwitterFailure(error: unknown): TwitterAccountFailure {
  if (error instanceof TwitterAccountRequestError) {
    return failureOf(error.failureCode, null);
  }

  const signals = classificationSignals(error);
  const httpStatus = readHttpStatus(error, signals);

  if (TIMEOUT_SIGNAL.test(signals)) return failureOf("provider_timeout", httpStatus);
  if (httpStatus === HTTP_UNAUTHORIZED) return failureOf("auth_failed", httpStatus);
  if (httpStatus === HTTP_TOO_MANY_REQUESTS) return failureOf("rate_limited", httpStatus);
  return failureOf("provider_rejected", httpStatus);
}

/**
 * The code the agent branches on, plus X's own status WHENEVER one was
 * recovered — `provider_rejected, HTTP 404`.
 *
 * The status is already a bounded integer in 100-599 (`validStatus`), so this
 * carries no provider prose. It is the difference between a 403 the agent
 * should stop retrying and a 503 it may retry once — a distinction the code
 * alone flattens, since `provider_rejected` covers both. Same `, HTTP <n>`
 * clause as the protocol lane's W1 rendering (`renderProtocolFailureOutput`).
 */
export function twitterFailureReason(failure: TwitterAccountFailure): string {
  return failure.httpStatus === null ? failure.code : `${failure.code}, HTTP ${failure.httpStatus}`;
}

/** What the agent reads: the reason it can branch on, then the static sentence. */
export function twitterFailureMessage(failure: TwitterAccountFailure): string {
  return `${twitterFailureReason(failure)} — ${failure.message}`;
}
