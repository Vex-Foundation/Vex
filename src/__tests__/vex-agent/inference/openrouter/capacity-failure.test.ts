/**
 * Capacity classification — which failures retry, and which may switch endpoint.
 *
 * Both directions are asserted, because the expensive mistake here is
 * asymmetric: a false NEGATIVE costs a retry the user would have liked, while a
 * false POSITIVE puts a 400 or a `context_length_exceeded` through a retry loop
 * and an endpoint rotation that can never succeed, burning money and latency on
 * every endpoint of the model.
 *
 * The 429 cases are built from the REAL recorded shape
 * (`agents_dm/runtime-harness/fixtures/openrouter-429-shape.json`, probe
 * `provider-429-layer`, 2026-07-29): `TooManyRequestsResponseError`, status 429,
 * `error.metadata.limit_source = "upstream_provider_shared_pool"`,
 * `provider_error_code = "engine_overloaded"`, NO `errorType`, and NO
 * `Retry-After` header of either spelling. They are driven through the REAL
 * `normalizeOpenRouterError` rather than hand-attached own-properties, so the
 * test covers the whole path the runtime actually walks — extraction included.
 */

import { describe, it, expect } from "vitest";

import { normalizeOpenRouterError } from "@vex-agent/inference/openrouter/errors.js";
import { classifyCapacityFailure } from "@vex-agent/inference/openrouter/endpoint-failover/capacity-failure.js";

interface ThrowShape {
  readonly name: string;
  readonly statusCode?: number;
  readonly metadata?: Record<string, unknown>;
  readonly headers?: Headers;
}

/** Build an SDK-shaped throw the way the live 429 actually arrived. */
function sdkError(shape: ThrowShape): Error {
  const err = new Error("Provider returned error");
  err.name = shape.name;
  Object.assign(err, {
    statusCode: shape.statusCode,
    error: {
      code: shape.statusCode ?? null,
      message: "Provider returned error",
      metadata: shape.metadata ?? {},
    },
    ...(shape.headers !== undefined ? { headers: shape.headers } : {}),
  });
  return err;
}

function classifyThrown(shape: ThrowShape) {
  return classifyCapacityFailure(normalizeOpenRouterError(sdkError(shape), "chat completion"));
}

/** The live-recorded 429, verbatim in the fields that matter. */
const LIVE_429: ThrowShape = {
  name: "TooManyRequestsResponseError",
  statusCode: 429,
  metadata: {
    raw: "{}",
    provider_name: "DeepInfra",
    is_byok: false,
    provider_error_code: "engine_overloaded",
    limit_source: "upstream_provider_shared_pool",
    remedy_hint: "x".repeat(192),
  },
};

describe("classifyCapacityFailure — capacity failures retry and may switch", () => {
  it.each([
    ["live shared-pool 429", LIVE_429, "rate_limited_shared_pool"],
    [
      "429 with no metadata at all (pre-probe shape)",
      { name: "TooManyRequestsResponseError", statusCode: 429 },
      "rate_limited_shared_pool",
    ],
    [
      "provider overloaded by SDK class",
      { name: "ProviderOverloadedResponseError" },
      "provider_overloaded",
    ],
    ["503 service unavailable", { name: "ServiceUnavailableResponseError", statusCode: 503 }, "provider_overloaded"],
    ["502 bad gateway", { name: "BadGatewayResponseError", statusCode: 502 }, "provider_unavailable"],
    ["500 internal", { name: "InternalServerResponseError", statusCode: 500 }, "upstream_server_error"],
    ["504 edge timeout", { name: "EdgeNetworkTimeoutResponseError", statusCode: 504 }, "upstream_server_error"],
  ] as const)("%s ⇒ %s, switchable", (_label, shape, expectedClass) => {
    const failure = classifyThrown(shape);
    expect(failure).not.toBeNull();
    expect(failure?.reasonClass).toBe(expectedClass);
    expect(failure?.switchable).toBe(true);
  });

  it("carries no retry hint when the provider sent no Retry-After — the LIVE case", () => {
    // The probe recorded neither `retry-after` nor `retry-after-ms` on a real
    // 429, so the null path is the common one and the backoff must not depend
    // on the header existing.
    expect(classifyThrown(LIVE_429)?.retryAfterSeconds).toBeNull();
  });

  it("carries the provider's retry hint when one IS sent", () => {
    const failure = classifyThrown({
      ...LIVE_429,
      headers: new Headers({ "retry-after": "7" }),
    });
    expect(failure?.retryAfterSeconds).toBe(7);
  });
});

describe("classifyCapacityFailure — an account-level 429 retries but never switches", () => {
  it.each([
    "account_daily_quota",
    "api_key_rate_limit",
    "organization_limit",
    "user_credits",
  ])("limit_source=%s ⇒ rate_limited_account, NOT switchable", (limitSource) => {
    // Switching cannot escape a limit applied to US; rotating would burn one
    // attempt per endpoint of the model on every single turn.
    const failure = classifyThrown({
      ...LIVE_429,
      metadata: { ...LIVE_429.metadata, limit_source: limitSource },
    });
    expect(failure?.reasonClass).toBe("rate_limited_account");
    expect(failure?.switchable).toBe(false);
  });
});

describe("classifyCapacityFailure — non-capacity failures must NOT retry at all", () => {
  it.each([
    ["400 bad request", { name: "BadRequestResponseError", statusCode: 400 }],
    ["401 unauthorized", { name: "UnauthorizedResponseError", statusCode: 401 }],
    ["402 payment required", { name: "PaymentRequiredResponseError", statusCode: 402 }],
    ["403 forbidden", { name: "ForbiddenResponseError", statusCode: 403 }],
    ["404 not found", { name: "NotFoundResponseError", statusCode: 404 }],
    ["413 payload too large", { name: "PayloadTooLargeResponseError", statusCode: 413 }],
    ["422 unprocessable", { name: "UnprocessableEntityResponseError", statusCode: 422 }],
    [
      "context_length_exceeded (a 400 in provider clothing)",
      {
        name: "BadRequestResponseError",
        statusCode: 400,
        metadata: { provider_error_code: "context_length_exceeded" },
      },
    ],
    [
      "content policy refusal",
      {
        name: "BadRequestResponseError",
        statusCode: 400,
        metadata: { provider_error_code: "content_policy_violation" },
      },
    ],
    ["transport failure (status-less)", { name: "ConnectionError" }],
    ["unreadable response", { name: "SDKValidationError" }],
  ] as const)("%s ⇒ null (propagates on attempt one)", (_label, shape) => {
    expect(classifyThrown(shape)).toBeNull();
  });
});
