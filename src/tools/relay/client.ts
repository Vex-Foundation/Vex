/**
 * Relay (api.relay.link) HTTP client — KEYLESS cross-chain bridge.
 *
 * GET /chains (cached, TTL 1h), POST /quote/v2, GET /intents/status/v3. Keyless
 * by default — Relay's published rate-limit table is PER API KEY (`/quote`
 * 50 req/min, other endpoints 200/min); no anonymous per-IP limit is documented,
 * so the previous "50 quotes/min/IP" claim here was unverifiable and is removed.
 * Every response is Zod-validated at this boundary (see ./types.ts).
 *
 * ERROR BODIES (W2c): a non-2xx response body is READ, not discarded. Relay
 * publishes a closed `errorCode` vocabulary with an explicit transient/permanent
 * split, and the live 400 carries `{message, errorCode}` — the code is rendered
 * FIRST so it survives the agent-facing length cap, and the HTTP status is
 * preserved onto the error so the shared contract classifies from the status.
 *
 * QUOTE MIGRATION (Wave-2 W2): quotes go to `POST /quote/v2` — v1 `POST /quote`
 * is deprecated. v2 adds a top-level `requestId` and per-side USD under
 * `details{}`; the step/status shapes are unchanged, so this is endpoint-path +
 * response-schema only (no signature change).
 */

import { loadConfig } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import {
  RelayChainsResponseSchema,
  RelayQuoteResponseSchema,
  RelayStatusResponseSchema,
  type RelayChain,
  type RelayQuoteRequest,
  type RelayQuoteResponse,
  type RelayStatusResponse,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const CHAINS_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * OPTIONAL Relay API key. Read PER REQUEST, never at construction: the vault can
 * be unlocked mid-session, and a client built before the unlock must still pick
 * the key up. Absent/blank → the request is byte-identical to the keyless one.
 * The value is never logged, never echoed into an error, and never put in a URL.
 */
function relayApiKey(): string | undefined {
  const key = process.env.RELAY_API_KEY?.trim();
  return key !== undefined && key.length > 0 ? key : undefined;
}

/** Relay integration-attribution identifier, sent as `referrer` on every quote. */
const RELAY_REFERRER = "vex";

/**
 * Canonical Relay intent-status path. Single source of truth: used both to build
 * the status request AND to validate a quote's step `check.endpoint` before we
 * trust the requestId it carries (see relay/execute
 * `parseRequestIdFromCheckEndpoint` and the correlation contract in
 * relay/correlation.ts).
 */
export const RELAY_INTENT_STATUS_PATH = "/intents/status/v3";

/**
 * Relay's documented TRANSIENT error codes (docs.relay.link, "Handling Quote
 * Errors"). Every other published code is fix-the-request, so a retry of an
 * unchanged request reproduces it.
 */
const RELAY_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(["REQUEST_TIMED_OUT", "RPC_HTTP_ERROR"]);

/**
 * The shape a provider `errorCode` must have before we echo it as a CODE:
 * Relay's vocabulary is SCREAMING_SNAKE. Anything else is treated as free text
 * and travels through the message lane, where the shared scrubber bounds it.
 */
const RELAY_ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The error body, or "" when it is absent or already consumed — never a throw. */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

/**
 * Split a Relay error body into its closed `errorCode` and its free-text
 * `message`. A body that is not JSON — Relay's gateway can answer HTML — is
 * carried verbatim as text rather than dropped; the shared scrubber
 * (`summarizeProtocolError`) owns redaction and the length bound, so nothing is
 * cut here.
 */
function splitRelayErrorBody(body: string): { providerCode: string | null; text: string } {
  if (body.length === 0) return { providerCode: null, text: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { providerCode: null, text: body };
  }
  if (typeof parsed !== "object" || parsed === null) return { providerCode: null, text: body };
  const record = parsed as { errorCode?: unknown; message?: unknown };
  const providerCode =
    typeof record.errorCode === "string" && RELAY_ERROR_CODE_SHAPE.test(record.errorCode)
      ? record.errorCode
      : null;
  const text = typeof record.message === "string" ? record.message.trim() : "";
  if (providerCode === null && text.length === 0) return { providerCode: null, text: body };
  return { providerCode, text };
}

/**
 * The one remediation the caller can act on. A 401/403 while a key is present
 * names the key explicitly — Vex works keyless, so the fix is to remove or
 * replace it, never to retry. The key VALUE never appears here.
 */
function relayErrorHint(status: number, keyed: boolean): string | undefined {
  if (keyed && (status === 401 || status === 403)) {
    return "Relay rejected the API key — remove or replace it in Settings; Vex works without one.";
  }
  if (status === 429) return "Relay rate limit — retry shortly.";
  return undefined;
}

/**
 * The agent-facing error for a non-2xx Relay response. `errorCode` leads the
 * message because the agent-facing cap eats the TAIL, and the code is the part
 * that is machine-classifiable.
 */
function relayHttpError(status: number, body: string, keyed: boolean): VexError {
  const { providerCode, text } = splitRelayErrorBody(body);
  const cause = providerCode === null
    ? (text.length > 0 ? text : `Relay request failed (${status})`)
    : (text.length > 0 ? `${providerCode}: ${text}` : providerCode);
  const err = new VexError(
    status === 429 ? ErrorCodes.RELAY_RATE_LIMITED : ErrorCodes.RELAY_API_ERROR,
    cause,
    relayErrorHint(status, keyed),
  );
  err.httpStatus = status;
  if (providerCode !== null) err.externalName = providerCode;
  if (status === 429 || (providerCode !== null && RELAY_RETRYABLE_ERROR_CODES.has(providerCode))) {
    err.retryable = true;
  }
  return err;
}

function mapTransportError(err: unknown): never {
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw new VexError(ErrorCodes.RELAY_TIMEOUT, err.message, err.hint);
  }
  if (err instanceof VexError && err.code.startsWith("RELAY_")) throw err;
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw new VexError(ErrorCodes.RELAY_API_ERROR, err.message, err.hint);
  }
  throw err;
}

export class RelayClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v.length > 0) url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    validate: (raw: unknown) => T,
    options: { method?: "GET" | "POST"; query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    try {
      const apiKey = relayApiKey();
      const headers: Record<string, string> = {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
      };
      const response = await fetchWithTimeout(this.url(path, options.query), {
        method: options.method ?? "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: Object.keys(headers).length === 0 ? undefined : headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (!response.ok) {
        throw relayHttpError(response.status, await readErrorBody(response), apiKey !== undefined);
      }
      return validate(await readJson(response));
    } catch (err) {
      mapTransportError(err);
    }
  }

  async getChains(): Promise<RelayChain[]> {
    const parsed = await this.request("/chains", (raw) => RelayChainsResponseSchema.parse(raw));
    return parsed.chains;
  }

  getQuote(request: RelayQuoteRequest): Promise<RelayQuoteResponse> {
    return this.request("/quote/v2", (raw) => RelayQuoteResponseSchema.parse(raw), {
      method: "POST",
      // `referrer` is Relay's integration-attribution field (their 2026-07-30
      // request): a constant identifier recorded against the quote and the
      // resulting transaction. Attribution only — it is NOT an app fee and
      // never a caller/model input, so it is injected here, transport-side,
      // on EVERY quote rather than trusted to each caller.
      body: { ...request, referrer: RELAY_REFERRER },
    });
  }

  getIntentStatus(requestId: string): Promise<RelayStatusResponse> {
    return this.request(RELAY_INTENT_STATUS_PATH, (raw) => RelayStatusResponseSchema.parse(raw), {
      query: { requestId },
    });
  }
}

// ── Singleton (rebuilt when the configured base URL changes) ──────────────────

let cachedClient: RelayClient | null = null;
let cachedBaseUrl: string | null = null;

export function getRelayClient(): RelayClient {
  const baseUrl = loadConfig().services.relayApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) return cachedClient;
  cachedClient = new RelayClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}

// ── Chains cache (TTL 1h) ─────────────────────────────────────────────────────

let cachedChains: RelayChain[] | null = null;
let chainsCachedAt = 0;

/** Cached Relay chain registry (TTL 1h). Refreshes on expiry. */
export async function getCachedRelayChains(): Promise<RelayChain[]> {
  if (cachedChains && Date.now() - chainsCachedAt < CHAINS_TTL_MS) return cachedChains;
  const chains = await getRelayClient().getChains();
  cachedChains = chains;
  chainsCachedAt = Date.now();
  return chains;
}

/** Test/utility hook — clear the chains cache. */
export function clearRelayChainsCache(): void {
  cachedChains = null;
  chainsCachedAt = 0;
}
