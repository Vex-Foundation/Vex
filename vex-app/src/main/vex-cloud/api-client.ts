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
 * | `GET /v1/account` | bearer | balances in wei with a micro-USD estimate, wallets, rate, deposit address, limits | 401 when the session is gone |
 * | `GET /v1/account/activity`, `/usage`, `GET /v1/deposits` | bearer | a page `{items, next_cursor}` | 400 `invalid_cursor` |
 * | `GET /v1/models` | none | `{data: [{id, pricing: {prompt, completion, internal_reasoning?}, ...}]}`, USD per token, markup included | 503 `registry_unavailable` |
 * | `POST /v1/deposits/notify` | bearer | 202 `{accepted: true}` (a hint; the watcher verifies) | 400 `invalid_tx_hash`, 429 |
 * | `POST /v1/withdrawals` | bearer + `Idempotency-Key` | 202 `{withdrawal}` | 400 `below_minimum`, 403 `destination_not_linked` / `account_paused`, 409 `insufficient_withdrawable` / `idempotency_key_reused`, 429 `daily_limit_exceeded` (`remaining_wei`), 503 `rate_unavailable` |
 * | `GET /v1/withdrawals/:id` | bearer | `{withdrawal}` | 404 |
 * | `POST /v1/cashback/claim` | bearer + `Idempotency-Key` | `{claimed_wei}` | 400 `unsupported_destination` |
 *
 * Every body is parsed strictly by the backend: 400 `forbidden_field` and
 * `invalid_field` (with `metadata.field`), `invalid_idempotency_key`,
 * `invalid_limit`; 404 `withdrawal_not_found`; 429 `rate_limited` on the
 * notify hint; 503 `deposits_unavailable` / `withdrawals_unavailable` when
 * the backend has no deposit address configured
 * (`VexVirtualsCompute/src/http/custody-routes.ts`).
 *
 * The phase 2 wire is plan section 15.2 (`VexVirtualsCompute/docs/plan/vex-cloud-v1.md`).
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
 * change must not sign the user out) but strictly on every field read. The
 * phase 2 additions a backend may not send yet (`withdrawable_wei`, the daily
 * limit) are optional and surface as `null` ("Not available"), never as a
 * guessed figure.
 *
 * BODIES ARE BOUNDED WHILE READ: the stream is cancelled the moment it passes
 * {@link MAX_RESPONSE_BYTES}, so an oversized answer never sits whole in
 * memory. A POST that moves funds carries an `Idempotency-Key` header minted
 * by its caller; this client never invents or repeats one on its own.
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
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const cursor = z.string().min(1).max(512);

export const accountResponseSchema = z.object({
  account_id: z.string().uuid(),
  status: z.object({ paused: z.boolean(), drain_mode: z.boolean() }),
  wallets: z.array(z.object({ address: evmAddress, linked_at: isoTimestamp })).max(32),
  deposit_address: evmAddress.nullable(),
  balances: z.object({
    available: amountSchema,
    provisional: amountSchema,
    reserved: amountSchema,
    pending_withdrawal: amountSchema,
    claimable: amountSchema,
    /** Cashback earned on provisional spend, released at deposit finality; not claimable yet. */
    cashback_pending: amountSchema.optional(),
  }),
  withdrawable_wei: rawInteger.optional(),
  rate: z.union([
    z.object({
      available: z.literal(true),
      source: z.string().regex(/^[a-z0-9_]{1,32}$/),
      vex_wei_per_micro_usd: z.string().regex(/^[0-9]{1,60}(\.[0-9]{1,18})?$/),
      observed_at: isoTimestamp,
      age_seconds: z.number().int().nonnegative(),
      valid_until: isoTimestamp,
    }),
    z.object({ available: z.literal(false), reason: reasonToken }),
  ]),
  limits: z.object({
    min_deposit_micro_usd: rawInteger,
    min_withdraw_micro_usd: rawInteger,
    provisional_cap_micro_usd: rawInteger,
    withdraw_daily_limit_micro_usd: rawInteger.optional(),
    withdraw_daily_remaining_wei: rawInteger.nullable().optional(),
  }),
});
export type VexCloudAccountResponse = z.infer<typeof accountResponseSchema>;

/** A page request: `cursor` is the previous page's opaque `next_cursor`, round-tripped unparsed. */
export interface PageQuery {
  readonly cursor: string | null;
  readonly limit?: number;
}

function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item).max(100), next_cursor: cursor.nullable() });
}

export const activityPageSchema = pageSchema(
  z.object({
    id: z.string().min(1).max(128),
    kind: z.enum(["deposit", "withdrawal", "cashback_claim", "admin_credit"]),
    amount_wei: rawInteger,
    status: reasonToken,
    tx_hash: txHash.nullable(),
    created_at: isoTimestamp,
  }),
);
export type ActivityPage = z.infer<typeof activityPageSchema>;

export const usagePageSchema = pageSchema(
  z.object({
    request_id: z.string().min(1).max(128),
    model: z.string().min(1).max(200),
    effort: z.string().max(32).nullable(),
    status: reasonToken,
    upstream_cost_micro_usd: rawInteger.nullable(),
    charged_wei: rawInteger.nullable(),
    clamp_reason: reasonToken.nullable(),
    created_at: isoTimestamp,
  }),
);
export type UsagePage = z.infer<typeof usagePageSchema>;

export const depositsPageSchema = pageSchema(
  z.object({
    id: z.string().min(1).max(128),
    tx_hash: txHash,
    log_index: z.number().int().nonnegative(),
    from: evmAddress,
    amount_wei: rawInteger,
    status: z.enum(["pending", "provisional", "credited", "reverted"]),
    spendable_now_wei: rawInteger,
    observed_at: isoTimestamp,
    finalized_at: isoTimestamp.nullable(),
  }),
);
export type DepositsPage = z.infer<typeof depositsPageSchema>;

/**
 * A USD-per-token price as the gateway publishes it (`registry.ts`
 * `publishedPrice`: at most 12 decimals, markup included). Kept as text and
 * converted exactly; never a float.
 */
const usdPerTokenText = z.string().regex(/^[0-9]{1,12}(\.[0-9]{1,12})?$/);

/** `GET /v1/models`: only the fields the status read uses are parsed; the rest of each row is ignored. */
export const modelsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        pricing: z.object({
          prompt: usdPerTokenText,
          completion: usdPerTokenText,
          internal_reasoning: usdPerTokenText.optional(),
        }),
      }),
    )
    .max(500),
});
export type ModelsResponse = z.infer<typeof modelsResponseSchema>;

export const withdrawalResponseSchema = z.object({
  withdrawal: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    status: z.enum([
      "requested",
      "debited",
      "signed",
      "broadcast",
      "included_success",
      "included_reverted",
      "completed",
      "refunded",
      "failed",
      "unknown",
      "dropped",
    ]),
    amount_wei: rawInteger,
    destination: evmAddress,
    tx_hash: txHash.nullable(),
    created_at: isoTimestamp,
    updated_at: isoTimestamp,
  }),
});
export type WithdrawalResponse = z.infer<typeof withdrawalResponseSchema>;

const claimResponseSchema = z.object({ claimed_wei: rawInteger });
const notifyResponseSchema = z.object({ accepted: z.literal(true) });

/** `Idempotency-Key` per plan 15.2. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface SignedSiweItem {
  readonly address: string;
  readonly message: string;
  readonly signature: string;
}

export type VexCloudCallFailure =
  /** 401: the bearer is missing, invalid or expired (or the signatures were refused). */
  | { readonly kind: "unauthorized"; readonly reason: string | null; readonly address: string | null }
  /**
   * A definitive refusal other than 401 (400, 403, 404, 409, and a 429 that
   * names a money reason such as `daily_limit_exceeded`), with the backend's
   * reason. `remainingWei` is the daily allowance left when the backend says.
   */
  | {
      readonly kind: "rejected";
      readonly status: number;
      readonly reason: string | null;
      readonly address: string | null;
      readonly remainingWei?: string;
      readonly field?: string;
    }
  /** Network, deadline, rate limit or a server error: retry later. `reason` when the backend named one (`rate_unavailable`). */
  | { readonly kind: "unavailable"; readonly status: number | null; readonly reason?: string }
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
  listActivity(bearer: string, page: PageQuery, signal: AbortSignal): Promise<VexCloudCall<ActivityPage>>;
  listUsage(bearer: string, page: PageQuery, signal: AbortSignal): Promise<VexCloudCall<UsagePage>>;
  listDeposits(bearer: string, page: PageQuery, signal: AbortSignal): Promise<VexCloudCall<DepositsPage>>;
  /** The gateway's published model list with its marked-up prices (no bearer needed; sent when held). */
  listModels(bearer: string | null, signal: AbortSignal): Promise<VexCloudCall<ModelsResponse>>;
  /** A hint to scan this receipt now; attribution still comes only from the watcher's own log read. */
  notifyDeposit(bearer: string, txHash: string, signal: AbortSignal): Promise<VexCloudCall<{ readonly accepted: true }>>;
  createWithdrawal(
    bearer: string,
    idempotencyKey: string,
    body: { readonly amountWei: string; readonly destination: string },
    signal: AbortSignal,
  ): Promise<VexCloudCall<WithdrawalResponse>>;
  readWithdrawal(bearer: string, withdrawalId: string, signal: AbortSignal): Promise<VexCloudCall<WithdrawalResponse>>;
  claimCashbackToBalance(
    bearer: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<VexCloudCall<{ readonly claimedWei: string }>>;
}

const errorBodySchema = z.object({
  error: z.object({
    metadata: z
      .object({
        reason: reasonToken.optional(),
        address: evmAddress.optional(),
        remaining_wei: rawInteger.optional(),
        /** The caller field a 400 `forbidden_field` / `invalid_field` names. */
        field: z.string().regex(/^[A-Za-z0-9_.]{1,64}$/).optional(),
      })
      .optional(),
  }),
});

/**
 * 429 reasons that are a DEFINITIVE money refusal rather than a throttle:
 * retrying the same request later does not help, a smaller amount does.
 */
const DEFINITIVE_429_REASONS: ReadonlySet<string> = new Set(["daily_limit_exceeded"]);

function failureFromStatus(status: number, bodyText: string): VexCloudCallFailure {
  let reason: string | null = null;
  let address: string | null = null;
  let remainingWei: string | null = null;
  let field: string | null = null;
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(bodyText));
    if (parsed.success) {
      reason = parsed.data.error.metadata?.reason ?? null;
      address = parsed.data.error.metadata?.address ?? null;
      remainingWei = parsed.data.error.metadata?.remaining_wei ?? null;
      field = parsed.data.error.metadata?.field ?? null;
    }
  } catch {
    // A non-JSON error body still has a status; the reason stays unknown.
  }
  if (status === 401) return { kind: "unauthorized", reason, address };
  if (status === 429 && reason !== null && DEFINITIVE_429_REASONS.has(reason)) {
    return { kind: "rejected", status, reason, address, ...(remainingWei !== null && { remainingWei }) };
  }
  if (status === 429 || status >= 500) return { kind: "unavailable", status, ...(reason !== null && { reason }) };
  return {
    kind: "rejected",
    status,
    reason,
    address,
    ...(remainingWei !== null && { remainingWei }),
    ...(field !== null && { field }),
  };
}

/** The response body as text, refused past `limit` bytes while it is still being read. */
async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function pageQueryString(page: PageQuery): string {
  const params = new URLSearchParams();
  if (page.limit !== undefined) params.set("limit", String(page.limit));
  if (page.cursor !== null) params.set("cursor", page.cursor);
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
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
    init: {
      readonly method: "GET" | "POST";
      readonly body?: unknown;
      readonly bearer: string | null;
      readonly idempotencyKey?: string;
    },
    signal: AbortSignal,
    parse: (json: unknown) => T | null,
  ): Promise<VexCloudCall<T>> {
    if (signal.aborted) return { ok: false, failure: { kind: "cancelled" } };
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.bearer !== null) headers.authorization = `Bearer ${init.bearer}`;
    if (init.idempotencyKey !== undefined) {
      // A malformed key is a caller bug; refusing here keeps it off the wire.
      if (!IDEMPOTENCY_KEY_PATTERN.test(init.idempotencyKey)) throw new RangeError("invalid idempotency key");
      headers["idempotency-key"] = init.idempotencyKey;
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    let text: string | null;
    try {
      response = await doFetch(`${origin()}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: bounded,
        redirect: "error",
      });
      text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    } catch {
      if (signal.aborted) return { ok: false, failure: { kind: "cancelled" } };
      log.info(`[vex-cloud] call=${operation} outcome=unreachable`);
      return { ok: false, failure: { kind: "unavailable", status: null } };
    }
    if (text === null) {
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
    listActivity(bearer, page, signal) {
      return call("activity", `/v1/account/activity${pageQueryString(page)}`, { method: "GET", bearer }, signal, (json) => {
        const parsed = activityPageSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
      });
    },
    listUsage(bearer, page, signal) {
      return call("usage", `/v1/account/usage${pageQueryString(page)}`, { method: "GET", bearer }, signal, (json) => {
        const parsed = usagePageSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
      });
    },
    listDeposits(bearer, page, signal) {
      return call("deposits", `/v1/deposits${pageQueryString(page)}`, { method: "GET", bearer }, signal, (json) => {
        const parsed = depositsPageSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
      });
    },
    listModels(bearer, signal) {
      return call("models", "/v1/models", { method: "GET", bearer }, signal, (json) => {
        const parsed = modelsResponseSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
      });
    },
    notifyDeposit(bearer, hash, signal) {
      return call("deposit_notify", "/v1/deposits/notify", { method: "POST", body: { tx_hash: hash }, bearer }, signal, (json) => {
        const parsed = notifyResponseSchema.safeParse(json);
        return parsed.success ? { accepted: true as const } : null;
      });
    },
    createWithdrawal(bearer, idempotencyKey, body, signal) {
      return call(
        "withdrawal_create",
        "/v1/withdrawals",
        { method: "POST", body: { amount_wei: body.amountWei, destination: body.destination }, bearer, idempotencyKey },
        signal,
        (json) => {
          const parsed = withdrawalResponseSchema.safeParse(json);
          return parsed.success ? parsed.data : null;
        },
      );
    },
    readWithdrawal(bearer, withdrawalId, signal) {
      return call(
        "withdrawal_read",
        `/v1/withdrawals/${encodeURIComponent(withdrawalId)}`,
        { method: "GET", bearer },
        signal,
        (json) => {
          const parsed = withdrawalResponseSchema.safeParse(json);
          return parsed.success ? parsed.data : null;
        },
      );
    },
    claimCashbackToBalance(bearer, idempotencyKey, signal) {
      return call(
        "cashback_claim",
        "/v1/cashback/claim",
        { method: "POST", body: { to: "balance" }, bearer, idempotencyKey },
        signal,
        (json) => {
          const parsed = claimResponseSchema.safeParse(json);
          return parsed.success ? { claimedWei: parsed.data.claimed_wei } : null;
        },
      );
    },
  };
}
