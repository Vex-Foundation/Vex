/**
 * SDK-bump regression — the error-class hierarchy the normalizer depends on.
 *
 * WHY this suite exists. `normalizeOpenRouterError` branches on
 * `err instanceof OpenRouterError` to decide whether `statusCode` is
 * AUTHORITATIVE, and `src/lib/openrouter-client.ts` re-exports six error
 * classes as RUNTIME values so vex-app can do its own `instanceof` checks.
 *
 * The SDK is Speakeasy-generated and its release notes are OpenAPI-spec diffs
 * only — they structurally cannot report a TypeScript-side error-class rename
 * or re-parenting. If the hierarchy ever changed, nothing would fail loudly:
 * the normalizer would quietly fall through to its non-`OpenRouterError` path,
 * status codes would stop being authoritative, and the mission auto-retry
 * classifier would stop seeing `statusCode` — a silent production regression
 * with a green suite.
 *
 * These assertions make that failure mode loud, on a REAL subclass instance
 * built through the real constructor (not a shape-alike object).
 */

import { describe, it, expect } from "vitest";

import {
  ConnectionError,
  InvalidRequestError,
  OpenRouterError,
  RequestAbortedError,
  RequestTimeoutError,
  UnexpectedClientError,
} from "../../../lib/openrouter-client.js";
import { BadRequestResponseError } from "@openrouter/sdk/models/errors/badrequestresponseerror.js";
import { TooManyRequestsResponseError } from "@openrouter/sdk/models/errors/toomanyrequestsresponseerror.js";
import { normalizeOpenRouterError } from "@vex-agent/inference/openrouter/errors.js";

/** Build the `httpMeta` a real response-error constructor requires. */
function httpMeta(status: number, body: string) {
  return {
    response: new Response(body, { status }),
    request: new Request("https://openrouter.ai/api/v1/chat/completions"),
    body,
  };
}

describe("OpenRouter error hierarchy (SDK 1.1.13)", () => {
  it("keeps the six facade-exported classes as runtime constructors", () => {
    for (const cls of [
      OpenRouterError,
      ConnectionError,
      InvalidRequestError,
      RequestAbortedError,
      RequestTimeoutError,
      UnexpectedClientError,
    ]) {
      expect(typeof cls).toBe("function");
    }
  });

  it("keeps response-error subclasses extending OpenRouterError", () => {
    const rateLimited = new TooManyRequestsResponseError(
      { error: { code: 429, message: "rate limited" } },
      httpMeta(429, '{"error":{"code":429,"message":"rate limited"}}'),
    );

    expect(rateLimited).toBeInstanceOf(TooManyRequestsResponseError);
    expect(rateLimited).toBeInstanceOf(OpenRouterError);
    expect(rateLimited.statusCode).toBe(429);
  });

  it("normalizes a REAL subclass instance with an authoritative status", () => {
    const badRequest = new BadRequestResponseError(
      { error: { code: 400, message: "bad model" } },
      httpMeta(400, '{"error":{"code":400,"message":"bad model"}}'),
    );

    const normalized = normalizeOpenRouterError(badRequest, "chat completion");

    // The `instanceof` branch fired: the status reached the message AND the
    // lean own-property the mission classifier reads.
    expect(normalized.message).toContain("status=400");
    expect((normalized as Error & { status?: unknown }).status).toBe(400);
  });
});
