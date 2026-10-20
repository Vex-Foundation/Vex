/**
 * The main process's client for the Vex Cloud account and auth endpoints
 * (`/v1/auth/nonce`, `/v1/auth/verify`, `/v1/account`). Inference does not go
 * through here: the engine's OpenRouter-dialect client talks to
 * `/v1/chat/completions` and `/v1/models` itself.
 *
 * CONTRACT (from the backend's code, `VexVirtualsCompute/src/http/app.ts`):
 *
 * | Call | Auth | Success | Failure |
 * |---|---|---|---|
 * | `POST /v1/auth/nonce` | none | nonce, expiry, and the SIWE binding the server expects | 5xx |
 * | `POST /v1/auth/verify` | bearer only for `link` | `{account_id, created, token, expires_at}` or `{account_id, linked}` | 400, 401, 403, 409 with `metadata.reason` (and `address`) |
 * | `GET /v1/account` | bearer | balances in wei with a micro-USD estimate, wallets, rate | 401 when the session is gone |
 *
 * THE BEARER is sent only in the `Authorization` header, never in a URL,
 * never logged, and requests never follow a redirect (a redirect would carry
 * the credential to wherever it pointed). Every call is bounded by its own
 * deadline and by the caller's signal; a caller abort is reported as
 * `cancelled`, distinct from the deadline (`unavailable`).
 *
 * RESPONSES ARE UNTRUSTED. The nonce response is parsed `.strict()`: it feeds
 * the signer, so an unexpected field is refused rather than ignored. The
 * account response is parsed leniently on unknown fields (an additive backend
 * change must not sign the user out) but strictly on every field read.
 */

import { z } from "zod";
import { resolveVexCloudOrigin } from "@vex-lib/vex-cloud-endpoint.js";
import { log } from "../logger/index.js";

/** Per-request deadline. The calls are small JSON exchanges. */
export const VEX_CLOUD_REQUEST_TIMEOUT_MS = 15_000;
/** Bound on any response body this client reads. */
const MAX_RESPONSE_BYTES = 256 * 1024;

const isoTimestamp = z.string().datetime({ offset: true });
const rawInteger = z.string().regex(/^[0-9]{1,78}$/);
const reasonToken = z.string().regex(/^[a-z0-9_]{1,64}$/);

/** The challenge `POST /v1/auth/nonce` returns. Strict: it reaches the signer. */
export const nonceResponseSchema = z
  .object({
    nonce: z.string().regex(/^[A-Za-z0-9]{8,128}$/),
    expires_at: isoTimestamp,
    domain: z.string().min(1).max(255),
    uri: z.string().min(1).max(2048),
    chain_id: z.number().int(),
    version: z.string().max(16),
    statement: z.string().max(512),
    max_validity_seconds: z.number().int().min(1).max(86_400),
  })
  .strict();
export type VexCloudChallenge = z.infer<typeof nonceResponseSchema>;

const sessionIssuedSchema = z
  .object({
    account_id: z.string().uuid(),
    created: z.boolean(),
    /** Opaque bearer; the backend accepts `[A-Za-z0-9_-]{1,200}`. A SECRET. */
    token: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
    expires_at: isoTimestamp,
  })
  .strict();
const linkedSchema = z
  .object({
    account_id: z.string().uuid(),
    linked: z.array(z.string().regex(/^0x[0-9a-f]{40}$/)).max(8),
  })
  .strict();

export type VerifyOutcome =
  | { readonly kind: "session"; readonly accountId: string; readonly created: boolean; readonly token: string; readonly expiresAt: string }
  | { readonly kind: "linked"; readonly accountId: string; readonly linked: readonly string[] };

const amountSchema = z.object({ wei: rawInteger, usd_micro_estimate: rawInteger.nullable() });

export const accountResponseSchema = z.object({
  account_id: z.string().uuid(),
  status: z.object({ paused: z.boolean(), drain_mode: z.boolean() }),
  wallets: z
    .array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), linked_at: isoTimestamp }))
    .max(32),
  balances: z.object({
    available: amountSchema,
    provisional: amountSchema,
    reserved: amountSchema,
    pending_withdrawal: amountSchema,
    claimable: amountSchema,
  }),
  rate: z.union([
    z.object({
      available: z.literal(true),
      source: z.string().regex(/^[a-z0-9_]{1,32}$/),
      observed_at: isoTimestamp,
      age_seconds: z.number().int().nonnegative(),
    }),
    z.object({ available: z.literal(false), reason: reasonToken }),
  ]),
});
export type VexCloudAccountResponse = z.infer<typeof accountResponseSchema>;

export interface SignedSiweItem {
  readonly address: string;
  readonly message: string;
  readonly signature: string;
}

export type VexCloudCallFailure =
  /** 401: the bearer is missing, invalid or expired (or the signatures were refused). */
  | { readonly kind: "unauthorized"; readonly reason: string | null; readonly address: string | null }
  /** A definitive refusal other than 401 (400, 403, 404, 409), with the backend's reason. */
  | { readonly kind: "rejected"; readonly status: number; readonly reason: string | null; readonly address: string | null }
  /** Network, deadline, rate limit or a server error: retry later. */
  | { readonly kind: "unavailable"; readonly status: number | null }
  /** The server answered something this contract does not describe. */
  | { readonly kind: "invalid_response" }
  /** The caller's signal aborted the call. */
  | { readonly kind: "cancelled" };

export type VexCloudCall<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: VexCloudCallFailure };

export interface VexCloudApi {
  issueNonce(signal: AbortSignal): Promise<VexCloudCall<VexCloudChallenge>>;
  verify(
    items: readonly SignedSiweItem[],
    bearer: string | null,
    signal: AbortSignal,
  ): Promise<VexCloudCall<VerifyOutcome>>;
  readAccount(bearer: string, signal: AbortSignal): Promise<VexCloudCall<VexCloudAccountResponse>>;
}

const errorBodySchema = z.object({
  error: z.object({
    metadata: z
      .object({
        reason: reasonToken.optional(),
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      })
      .optional(),
  }),
});

function failureFromStatus(status: number, bodyText: string): VexCloudCallFailure {
  let reason: string | null = null;
  let address: string | null = null;
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(bodyText));
    if (parsed.success) {
      reason = parsed.data.error.metadata?.reason ?? null;
      address = parsed.data.error.metadata?.address ?? null;
    }
  } catch {
    // A non-JSON error body still has a status; the reason stays unknown.
  }
  if (status === 401) return { kind: "unauthorized", reason, address };
  if (status === 429 || status >= 500) return { kind: "unavailable", status };
  return { kind: "rejected", status, reason, address };
}

export interface VexCloudApiOptions {
  /** The origin to call; defaults to the resolved Vex Cloud origin at call time. */
  readonly origin?: () => string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The production client. Each call resolves the origin, so a dev override set before the call applies. */
export function createVexCloudApi(options: VexCloudApiOptions = {}): VexCloudApi {
  const origin = options.origin ?? (() => resolveVexCloudOrigin());
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? VEX_CLOUD_REQUEST_TIMEOUT_MS;

  async function call<T>(
    operation: string,
    path: string,
    init: { readonly method: "GET" | "POST"; readonly body?: unknown; readonly bearer: string | null },
    signal: AbortSignal,
    parse: (json: unknown) => T | null,
  ): Promise<VexCloudCall<T>> {
    if (signal.aborted) return { ok: false, failure: { kind: "cancelled" } };
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.bearer !== null) headers.authorization = `Bearer ${init.bearer}`;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${origin()}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: bounded,
        redirect: "error",
      });
      text = await response.text();
    } catch {
      if (signal.aborted) return { ok: false, failure: { kind: "cancelled" } };
      log.info(`[vex-cloud] call=${operation} outcome=unreachable`);
      return { ok: false, failure: { kind: "unavailable", status: null } };
    }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      log.warn(`[vex-cloud] call=${operation} status=${response.status} outcome=oversized_body`);
      return { ok: false, failure: { kind: "invalid_response" } };
    }
    if (!response.ok) {
      const failure = failureFromStatus(response.status, text);
      log.info(
        `[vex-cloud] call=${operation} status=${response.status} outcome=${failure.kind}`
          + `${"reason" in failure && failure.reason !== null ? ` reason=${failure.reason}` : ""}`,
      );
      return { ok: false, failure };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      log.warn(`[vex-cloud] call=${operation} status=${response.status} outcome=not_json`);
      return { ok: false, failure: { kind: "invalid_response" } };
    }
    const value = parse(json);
    if (value === null) {
      log.warn(`[vex-cloud] call=${operation} status=${response.status} outcome=off_contract`);
      return { ok: false, failure: { kind: "invalid_response" } };
    }
    return { ok: true, value };
  }

  return {
    issueNonce(signal) {
      return call("nonce", "/v1/auth/nonce", { method: "POST", body: {}, bearer: null }, signal, (json) => {
        const parsed = nonceResponseSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
      });
    },
    verify(items, bearer, signal) {
      return call(
        "verify",
        "/v1/auth/verify",
        { method: "POST", body: { signatures: items }, bearer },
        signal,
        (json): VerifyOutcome | null => {
          const session = sessionIssuedSchema.safeParse(json);
          if (session.success) {
            return {
              kind: "session",
              accountId: session.data.account_id,
              created: session.data.created,
              token: session.data.token,
              expiresAt: session.data.expires_at,
            };
          }
          const linked = linkedSchema.safeParse(json);
          if (linked.success) {
            return { kind: "linked", accountId: linked.data.account_id, linked: linked.data.linked };
          }
          return null;
        },
      );
    },
    readAccount(bearer, signal) {
      return call("account", "/v1/account", { method: "GET", bearer }, signal, (json) => {
        const parsed = accountResponseSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
      });
    },
  };
}
