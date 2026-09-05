/**
 * pools.fun error mapping - real causes, agent-friendly (owner decree 2026-08-02).
 *
 * This provider is unusually cooperative about WHY it refused: a bad parameter
 * comes back as HTTP 400 `{"error":"Invalid parameters","details":[{message,
 * path}]}` where the message is the server's own zod text, naming the parameter
 * and listing every allowed value. That text is the single most useful thing the
 * agent can be told, so it is surfaced as `path: message` pairs rather than
 * collapsed into a code.
 *
 * A 400 is NOT one shape. The launch endpoints answer with a bare `{"error": …}`
 * and no `details[]` at all, sometimes beside a machine `"code"`. Reading
 * `details[]` alone turned both of those into "the launchpad rejected a
 * parameter but named no detail" - see `invalidRequestError` for the order the
 * three shapes are read in and why a money path cannot afford the generic text.
 *
 * EVERY PROVIDER-ORIGIN STRING IS SCRUBBED, NOT MERELY CAPPED. An earlier
 * version of this module trusted the shapes it had measured: the zod `message`
 * fields were length-capped but never scrubbed, and the top-level `error` string
 * reached `VexError.hint` with neither. A hostile or merely broken upstream that
 * echoed a request header into that field would have put a bearer token in front
 * of the agent (Codex reproduced exactly that, 594 characters with a token
 * canary intact). "We have seen what this field contains" is not a security
 * property. Everything lifted out of a response body now goes through
 * `scrubProviderText`, the SAME pipeline the thrown-error lane uses - secret
 * shapes redacted, URLs collapsed, auth fragments stripped, HTML documents and
 * nested bodies removed, control characters flattened, then capped - and the
 * caps stay so that one rejection cannot become a wall of text.
 *
 * The other two measured failures are named, not generic:
 * - HTTP 502 `{"error":"Upstream error resolving token pool"}` on the candles
 *   route means pools.fun has no pool indexed for that address. That is a
 *   diagnosable cause with a remedy (check the address, or the token is not a
 *   pools.fun token), so it maps to POOLS_NOT_FOUND rather than a server fault.
 * - HTTP 404 `text/html` `Cannot GET /...` means the ROUTE is wrong, i.e. the
 *   provider moved. A bounded single-line snippet is kept as the drift signal.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { isRecord } from "../../utils/validation-helpers.js";
import { scrubProviderText } from "../../utils/error-summary.js";

/** Max provider detail pairs surfaced from one 400 body. */
const MAX_DETAILS = 3;

/** Max total length of the joined detail text. */
const MAX_DETAIL_LEN = 200;

/** Max length of the bounded snippet kept from a non-JSON error body. */
const MAX_SNIPPET_LEN = 100;

/** Max length of one scrubbed `path` segment inside a validation detail. */
const MAX_PATH_LEN = 40;

/** The 502 body that means "no pool indexed for this token", verbatim from the wire. */
const UPSTREAM_POOL_ERROR = "Upstream error resolving token pool";

/**
 * The 400 body that means the launchpad could not resolve an X handle, verbatim
 * from the wire. It carries neither `details[]` nor a machine `code`, so the
 * measured string is the only thing there is to recognise it by - the same way
 * `UPSTREAM_POOL_ERROR` is recognised. An unrecognised variant still surfaces
 * the provider's own scrubbed text, so a reworded upstream degrades to "less
 * specific", never to "silent".
 */
const X_RECIPIENT_UNRESOLVED = "Could not resolve the x fee recipient. Check it and try again.";

/**
 * Machine `code` values the launchpad puts beside its 400 `error` string, mapped
 * to what the agent should DO about them. The code is the provider's stable
 * name for the failure and is matched exactly; the remedy is ours, so it is
 * never provider-written text and never needs scrubbing.
 */
const REMEDIABLE_CODES: Readonly<Record<string, string>> = {
  INSUFFICIENT_DEV_BUY_BALANCE:
    "The wallet does not hold enough of the paired asset to fund the prebuy: fund the wallet, or lower the prebuy amount.",
};

/**
 * The ONE way a provider-origin string leaves this module.
 *
 * Every call site here handles untrusted text from an HTTP body, so there is
 * deliberately no second path: scrub first, cap second, and a string that
 * scrubs away to nothing is reported as nothing rather than as an empty quote.
 */
function safeProviderText(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined;
  return scrubProviderText(text, maxLength);
}

/**
 * Render the provider's zod `details` as bounded `path: message` pairs.
 *
 * The path arrives as an array of segments (`["sortBy"]`); anything else on the
 * wire is ignored rather than stringified, because a detail whose shape we do
 * not recognise cannot be quoted as if we understood it.
 */
function formatDetails(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  const pairs: string[] = [];
  for (const detail of raw.slice(0, MAX_DETAILS)) {
    if (!isRecord(detail)) continue;
    // Both halves are provider-written and both are scrubbed: a `path` segment
    // is as untrusted as the `message` beside it, and a per-detail cap keeps one
    // verbose entry from consuming the whole budget before the others are seen.
    const message = typeof detail.message === "string"
      ? safeProviderText(detail.message, MAX_DETAIL_LEN)
      : undefined;
    if (message === undefined) continue;
    const rawPath = Array.isArray(detail.path)
      ? detail.path.filter((seg): seg is string | number => typeof seg === "string" || typeof seg === "number").join(".")
      : "";
    const path = safeProviderText(rawPath, MAX_PATH_LEN);
    pairs.push(path ? `${path}: ${message}` : message);
  }
  if (pairs.length === 0) return undefined;
  const joined = pairs.join("; ");
  return joined.length > MAX_DETAIL_LEN ? `${joined.slice(0, MAX_DETAIL_LEN)}…` : joined;
}

/**
 * Pull the useful line out of the provider's HTML error page.
 *
 * Measured: a 404 answers with a full HTML document whose only informative byte
 * is the `<pre>Cannot GET /search</pre>` element - the route that no longer
 * exists, which IS the drift signal. A plain leading-100-characters snippet
 * spends its whole budget on the doctype and the head and truncates before
 * reaching it, so the `<pre>` is preferred when there is one.
 */
function extractHtmlErrorLine(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const pre = /<pre>([\s\S]*?)<\/pre>/i.exec(body);
  // Bounded either way: the `<pre>` contents are provider-written text, and the
  // whole-document fallback is scrubbed by the same call (the shared pipeline
  // removes an HTML document outright rather than quoting markup at the agent).
  return safeProviderText(pre ? pre[1] : body, MAX_SNIPPET_LEN);
}

/** Parse a JSON error body without throwing; a non-JSON body is simply absent. */
function parseErrorBody(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Map the launchpad's HTTP 400.
 *
 * There are THREE measured shapes behind this one status, and reading only the
 * first is what this function exists to stop. `/discover` rejects a parameter
 * with `{error:"Invalid parameters", details:[{message, path}]}`; the launch
 * endpoints reject with a bare `{error}` - sometimes carrying a machine `code`
 * (`INSUFFICIENT_DEV_BUY_BALANCE`), sometimes not (the X-recipient refusal).
 * An earlier version read `details[]` alone, so both launch shapes reached the
 * agent as "the launchpad rejected a parameter but named no detail" - a
 * diagnosable failure on a MONEY path rendered as a generic one, which is
 * exactly what makes an agent retry blind (rule 04).
 *
 * Order of preference: the machine `code`, because it is stable and carries a
 * remedy we author; then the zod `details[]`, because they name the parameter
 * and list its accepted values; then the provider's own `error` string. Every
 * provider-written fragment still goes through `safeProviderText`.
 */
function invalidRequestError(
  status: number,
  parsed: Record<string, unknown> | null,
  providerError: string | null,
): VexError {
  const message = `pools.fun rejected the request (HTTP ${status})`;
  const code = typeof parsed?.code === "string" ? parsed.code : null;

  const remedy = code === null ? undefined : REMEDIABLE_CODES[code];
  if (remedy !== undefined) {
    return new VexError(ErrorCodes.POOLS_INVALID_REQUEST, message, remedy);
  }

  if (providerError === X_RECIPIENT_UNRESOLVED) {
    return new VexError(
      ErrorCodes.POOLS_INVALID_REQUEST,
      message,
      "The launchpad does not know that X handle, so it refused to resolve a fee recipient from it: "
        + "check the handle, or give the fee recipient as a wallet address instead.",
    );
  }

  const details = formatDetails(parsed?.details);
  if (details) {
    return new VexError(ErrorCodes.POOLS_INVALID_REQUEST, message, `The launchpad named the problem: ${details}`);
  }

  // No details and no known code: the provider's own sentence is still the most
  // useful thing there is, so it is scrubbed and surfaced rather than discarded.
  // An unknown `code` is named too - it is the provider's stable handle for a
  // failure we have not classified yet, and it is what a bug report needs.
  const text = safeProviderText(providerError ?? undefined, MAX_DETAIL_LEN);
  const named = code === null ? undefined : safeProviderText(code, MAX_PATH_LEN);
  if (text) {
    return new VexError(
      ErrorCodes.POOLS_INVALID_REQUEST,
      message,
      named ? `The launchpad said: ${text} (${named})` : `The launchpad said: ${text}`,
    );
  }
  return new VexError(
    ErrorCodes.POOLS_INVALID_REQUEST,
    message,
    named
      ? `The launchpad rejected the request as ${named} but named no detail.`
      : "The launchpad rejected a parameter but named no detail.",
  );
}

/**
 * Map a non-ok pools.fun HTTP response to a typed error. `body` is the raw
 * response text; only bounded, sanitized fragments of it are ever exposed.
 */
export function mapPoolsFunError(status: number, body?: string): VexError {
  const parsed = parseErrorBody(body);
  const providerError = typeof parsed?.error === "string" ? parsed.error : null;

  if (status === 400) {
    return invalidRequestError(status, parsed, providerError);
  }

  if (status === 502 && providerError === UPSTREAM_POOL_ERROR) {
    return new VexError(
      ErrorCodes.POOLS_NOT_FOUND,
      "pools.fun knows no pool for this token address",
      "The launchpad could not resolve a pool for that token: either the address is wrong, or the token "
        + "was not launched on pools.fun (check it with `pools__tokens_search` first).",
    );
  }

  if (status === 404) {
    // TWO DIFFERENT 404s, and telling an agent the wrong one is worse than
    // telling it nothing. A JSON body with an `error` field is the provider
    // answering a question about a RESOURCE - measured 2026-09-04 on
    // `/pools-fun/holder-rewards?token=` for a token that never opted in:
    // `{"error":"Not a fees-to-holders token"}`. An HTML body is Express saying
    // the ROUTE does not exist. Reporting "the endpoint no longer exists" for
    // the first would send a caller to fix a path that is perfectly correct.
    if (providerError !== null) {
      return new VexError(
        ErrorCodes.POOLS_NOT_FOUND,
        `pools.fun has no such resource (HTTP ${status})`,
        `The launchpad said: ${safeProviderText(providerError, MAX_SNIPPET_LEN) ?? providerError}`,
      );
    }
    const snippet = extractHtmlErrorLine(body);
    return new VexError(
      ErrorCodes.POOLS_API_ERROR,
      `pools.fun route not found (HTTP ${status})`,
      snippet
        ? `The endpoint no longer exists at that path - provider detail: ${snippet}`
        : "The endpoint no longer exists at that path.",
    );
  }

  // The `error` field is a provider-written string like any other: it gets the
  // same scrub and the same cap as a raw body. It reached the agent unscrubbed
  // and uncapped once; the fix is that there is no longer a path where it can.
  const snippet = safeProviderText(providerError ?? body, MAX_SNIPPET_LEN);
  return new VexError(
    ErrorCodes.POOLS_API_ERROR,
    `pools.fun API error (HTTP ${status})`,
    snippet ? `Provider detail: ${snippet}` : undefined,
  );
}

/**
 * Normalize a thrown transport error once, at the client boundary. Already-mapped
 * `POOLS_*` errors pass through; the shared `HTTP_TIMEOUT`/`HTTP_REQUEST_FAILED`
 * VexErrors are re-tagged so callers can branch on a `POOLS_*` code.
 */
export function mapTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("POOLS_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    const mapped = new VexError(ErrorCodes.POOLS_TIMEOUT, err.message, err.hint);
    mapped.retryable = true;
    throw mapped;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    const mapped = new VexError(ErrorCodes.POOLS_API_ERROR, err.message, err.hint);
    mapped.retryable = true;
    throw mapped;
  }
  throw err;
}
