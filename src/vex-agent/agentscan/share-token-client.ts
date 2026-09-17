/**
 * Bind the locally persisted Superboard token to this AgentScan identity.
 * The plaintext crosses TLS once per registration attempt to AgentScan, the
 * party that verifies it and stores only its SHA-256 hash. The local copy stays
 * in this install's database. Retries reuse the same token; never log it or
 * include it in returned details. See share-token.md for the deployed contract.
 *
 * Rotation sends the candidate with `replaces` naming the currently bound
 * key; the server applies the write only when its slot holds nothing, the old
 * hash, or already the new hash (an idempotent retry).
 */

import { fetchWithTimeout, readJson } from "@utils/http.js";
import { readRetryAfterSeconds } from "@utils/http/retry-after.js";
import { ErrorCodes, VexError } from "../../errors.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LEN = 120;

/**
 * Why the request never produced a response. `timeout` is the client's own
 * deadline; `network` is a refused/broken route (errno in the cause chain);
 * `redirect` is the refused 3xx (`redirect: "error"`); `unknown` is anything
 * else. Classified from MEASURED shapes (see `classifyTransport`).
 */
export type ShareTokenTransportReason = "timeout" | "network" | "redirect" | "unknown";

export type RegisterShareTokenOutcome =
  | { readonly kind: "registered" }
  | { readonly kind: "not_ready" }
  | { readonly kind: "auth_lost" }
  | { readonly kind: "stopped"; readonly reason: "consent_revoked" | "quarantined" }
  | { readonly kind: "conflict" }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number | null; readonly detail: string }
  | {
      readonly kind: "http";
      readonly status: number;
      readonly code: string | null;
      readonly retryAfterSeconds: number | null;
      readonly detail: string;
    }
  | { readonly kind: "malformed_response"; readonly detail: string }
  | { readonly kind: "transport"; readonly reason: ShareTokenTransportReason; readonly detail: string };

export function buildShareTokenClient(
  baseUrl: string,
  options?: { readonly timeoutMs?: number },
): {
  register(input: {
    ingestToken: string;
    shareToken: string;
    replaces?: string;
  }): Promise<RegisterShareTokenOutcome>;
} {
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    register: (input) => registerShareToken(baseUrl, input, timeoutMs),
  };
}

async function registerShareToken(
  baseUrl: string,
  input: { ingestToken: string; shareToken: string; replaces?: string },
  timeoutMs: number,
): Promise<RegisterShareTokenOutcome> {
  let response: Response;
  try {
    response = await fetchWithTimeout(joinUrl(baseUrl, "v1/agents/share-token"), {
      method: "POST",
      redirect: "error",
      timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.ingestToken}`,
      },
      body: JSON.stringify(
        input.replaces === undefined
          ? { shareToken: input.shareToken }
          : { shareToken: input.shareToken, replaces: input.replaces },
      ),
    });
  } catch (err) {
    const reason = classifyTransport(err);
    return { kind: "transport", reason, detail: transportDetail(err, reason) };
  }

  const body = await readJson(response).catch(() => null);

  if (response.ok) {
    if (!isRegisteredBody(body)) {
      return { kind: "malformed_response", detail: "malformed share-token response" };
    }
    return { kind: "registered" };
  }

  if (response.status === 401) return { kind: "auth_lost" };
  if (response.status === 403) return { kind: "stopped", reason: "quarantined" };
  if (response.status === 410) return { kind: "stopped", reason: "consent_revoked" };
  if (response.status === 409) return { kind: "conflict" };
  if (response.status === 429) {
    return {
      kind: "rate_limited",
      retryAfterSeconds: readRetryAfterSeconds(response.headers, response.status) ?? null,
      detail: describeError(response.status, body),
    };
  }
  return {
    kind: "http",
    status: response.status,
    code: errorCode(body),
    retryAfterSeconds: readRetryAfterSeconds(response.headers, response.status) ?? null,
    detail: describeError(response.status, body),
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRegisteredBody(body: unknown): boolean {
  return isRecord(body) && body.status === "registered";
}

/**
 * Errno names that prove the request died on the route: DNS, TCP/TLS, and the
 * undici connect/socket failures. A closed port arrives as `connect
 * ECONNREFUSED` at depth 2 of the wrapped chain (measured against a real
 * `node:http` server; see the transport tests).
 */
const NETWORK_CAUSE_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * The undici network error for a redirect met with `redirect: "error"`.
 * Measured (Node 24.15.0, real `node:http` 302): `TypeError: fetch failed`
 * whose cause is `Error: unexpected redirect` with no code. The message IS the
 * signal - undici attaches nothing else - so it is pinned as a literal and the
 * transport tests fail if a Node upgrade renames it.
 */
const REFUSED_REDIRECT_MESSAGE = "unexpected redirect";

/**
 * Depth-bounded walk of the `.cause` chain, EXCLUDING the error itself.
 * Cycle-safe. Self is excluded because the `fetchWithTimeout` wrapper's own
 * code (`HTTP_REQUEST_FAILED`) is not a transport signal - the errno that
 * proves a network fault lives underneath it.
 */
function causeChain(err: unknown): readonly Error[] {
  const chain: Error[] = [];
  const seen = new Set<object>();
  let node: unknown = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; depth < 6 && node instanceof Error; depth += 1) {
    if (seen.has(node)) break;
    seen.add(node);
    chain.push(node);
    node = node.cause;
  }
  return chain;
}

function firstCauseCode(chain: readonly Error[]): string | null {
  for (const node of chain) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
}

function classifyTransport(err: unknown): ShareTokenTransportReason {
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) return "timeout";
  const chain = causeChain(err);
  if (chain.some((node) => node.message === REFUSED_REDIRECT_MESSAGE)) return "redirect";
  const code = firstCauseCode(chain);
  if (code !== null && NETWORK_CAUSE_CODES.has(code)) return "network";
  return "unknown";
}

function transportDetail(err: unknown, reason: ShareTokenTransportReason): string {
  const base = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (reason === "redirect") return sanitize(`${base} (unexpected redirect)`, "request failed");
  const code = err instanceof Error ? firstCauseCode(causeChain(err)) : null;
  if (code !== null) return sanitize(`${base} (${code})`, "request failed");
  return sanitize(base, "request failed");
}

function rawErrorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.code === "string" ? body.error.code : null;
}

/**
 * Provider error codes are a closed snake_case vocabulary in practice, but the
 * body is untrusted input and this code rides the main-process log line and
 * the renderer-visible failure. Only a short single token survives verbatim;
 * anything else (sentences, URLs, token-shaped runs) reads as null, while the
 * sanitized detail still names the status. A bare 43-char token matches the
 * charset, which is why the blob check stands beside it.
 */
const LOG_SAFE_CODE = /^[A-Za-z0-9_.-]{1,80}$/;
const BLOB_RUN = /[A-Za-z0-9_-]{40,}/;

function errorCode(body: unknown): string | null {
  const code = rawErrorCode(body);
  if (code === null) return null;
  if (!LOG_SAFE_CODE.test(code) || BLOB_RUN.test(code)) return null;
  return code;
}

function describeError(status: number, body: unknown): string {
  const code = rawErrorCode(body);
  return sanitize(code === null ? `HTTP ${status}` : `HTTP ${status} ${code}`, `HTTP ${status}`);
}

function sanitize(text: string, fallback: string): string {
  const scrubbed = text
    .replace(/\bhttps?:\/\/\S+/gi, "<url>")
    .replace(/\b0x[0-9a-fA-F]{16,}\b/g, "<hex>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<blob>")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed.length === 0) return "no detail";
  return scrubbed.length > MAX_DETAIL_LEN
    ? `${fallback}; detail omitted (exceeds ${MAX_DETAIL_LEN} characters)`
    : scrubbed;
}
