/**
 * Renderer-facing engine-error event.
 *
 * The engine emits `EngineErrorEvent` on its in-process `engineErrorBus`
 * (`src/vex-agent/engine/runtime/error-bus.ts`) when a turn, mission, wake,
 * compact job or approval resume fails. The main-process `error-bridge` maps
 * that event into THIS shape — adding the user-facing `category` from the one
 * classifier (`shared/engine-error-classification.ts`) — validates it here,
 * and broadcasts it on `EV.engine.error`.
 *
 * BOUNDED CODES, NEVER PROSE. There is no message field, by construction. The
 * repo's pinned doctrine is that provider free text does not cross to the
 * renderer: `memory_jobs.last_error` is excluded from every DTO with a test
 * asserting the omission, and `mission_runs.stop_summary` is a 4096-char
 * provider message that is only length-capped, never redacted. Everything here
 * is an enum, an id, a small integer, or a timestamp — safe to render, safe to
 * log, and impossible to leak a prompt or a key through.
 *
 * `errorType` is the one field carried VERBATIM rather than as a closed enum:
 * `ApiErrorType` is an OPEN enum in the installed SDK, so an unrecognized
 * member is a legal provider response and must survive as data. It is bounded
 * by length + shape instead, and the renderer must never branch on it without
 * a total default — that is what `category` is for.
 */

import { z } from "zod";
import { ENGINE_ERROR_CATEGORIES } from "../engine-error-classification.js";
import { missionRunIdField, sessionIdField } from "./mission/_common.js";

/** Literal kept in sync with the engine `ENGINE_ERROR_EVENT_TYPE`. */
export const ENGINE_ERROR_EVENT_TYPE = "engine.runtime.error" as const;

/** Mirrors the engine `EngineErrorScope` union. */
export const engineErrorScopeSchema = z.enum([
  "turn",
  "mission",
  "wake",
  "compact",
  /**
   * Memory-manager maintenance. ALWAYS arrives with `sessionId: null` —
   * `memory_jobs` has no `session_id` column because consolidation and
   * reconcile are global work over `knowledge_entries`.
   */
  "memory",
  "approval",
]);
export type EngineErrorScope = z.infer<typeof engineErrorScopeSchema>;

/**
 * The user-facing category. A closed enum on purpose — this is the field the
 * renderer switches on for copy, so drift must fail at the boundary.
 */
export const engineErrorCategorySchema = z.enum(ENGINE_ERROR_CATEGORIES);
export type EngineErrorCategory = z.infer<typeof engineErrorCategorySchema>;

/**
 * SDK error class name. CLOSED at the boundary because the vocabulary is our
 * own compile-time dependency: an unknown value means the SDK changed under
 * us, which the bridge should drop rather than forward.
 */
export const engineErrorClassSchema = z.enum([
  "BadRequestResponseError",
  "UnauthorizedResponseError",
  "PaymentRequiredResponseError",
  "ForbiddenResponseError",
  "NotFoundResponseError",
  "RequestTimeoutResponseError",
  "ConflictResponseError",
  "PayloadTooLargeResponseError",
  "UnprocessableEntityResponseError",
  "TooManyRequestsResponseError",
  "InternalServerResponseError",
  "BadGatewayResponseError",
  "ServiceUnavailableResponseError",
  "EdgeNetworkTimeoutResponseError",
  "ProviderOverloadedResponseError",
  "OpenRouterError",
  "OpenRouterDefaultError",
  "ResponseValidationError",
  "SDKValidationError",
  "UnexpectedClientError",
  "InvalidRequestError",
  "RequestAbortedError",
  "RequestTimeoutError",
  "ConnectionError",
]);
export type EngineErrorClass = z.infer<typeof engineErrorClassSchema>;

/**
 * OPEN enum label — carried verbatim, bounded by shape and length. 64 admits a
 * plausible new SDK member (`unsupported_image_format` is the longest at 24)
 * and nothing resembling a message body.
 */
export const engineErrorTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "ApiErrorType labels are lower_snake_case");

/** Errno-shaped transport code — same closed shape as the engine's guard. */
export const engineCauseCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,59}$/);

/**
 * HTTP status bound, shared with the durable `runtimeStateDto.lastError` so
 * the live push event and the persisted evidence cannot disagree about what
 * counts as a valid status.
 */
export const engineStatusCodeSchema = z.number().int().min(100).max(599);

export const engineErrorEventSchema = z
  .object({
    type: z.literal(ENGINE_ERROR_EVENT_TYPE),
    /**
     * Owning session, or `null` for a GLOBAL failure belonging to no
     * conversation (memory maintenance).
     *
     * Nullable, but still a real UUID when present — the looser thing to do
     * would be to widen the field itself, which would let a malformed id
     * through on the session-scoped path where it actually matters. A null is
     * a positive claim of "system-wide", so session-scoped consumers must
     * IGNORE it rather than treat it as a wildcard; rendering a global failure
     * inside one session's banner would tell the user their conversation broke
     * when it did not.
     */
    sessionId: sessionIdField.nullable(),
    /**
     * NOT a UUID — see `mission/_common.ts`. Runs are minted as
     * `run-<epochMillis>-<hex>`, so a `.uuid()` here would have dropped every
     * error event that named the run it came from — the mission failures, i.e.
     * the ones the user most needs to see.
     */
    missionRunId: missionRunIdField.nullable(),
    scope: engineErrorScopeSchema,
    category: engineErrorCategorySchema,
    errorType: engineErrorTypeSchema.nullable(),
    errorClass: engineErrorClassSchema.nullable(),
    /** HTTP status when one exists. Six SDK error shapes carry none. */
    statusCode: engineStatusCodeSchema.nullable(),
    causeCode: engineCauseCodeSchema.nullable(),
    /**
     * Provider retry hint in whole seconds, already bounded to 24h at the
     * inference boundary. Re-bounded here so a compromised main cannot make
     * the UI say "retry in 3 million seconds".
     */
    retryAfterSeconds: z.number().int().min(1).max(86_400).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    correlationId: z.string().nullable(),
  })
  .strict();
export type EngineErrorEvent = z.infer<typeof engineErrorEventSchema>;
