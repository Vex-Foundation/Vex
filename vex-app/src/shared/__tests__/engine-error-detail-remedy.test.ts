/**
 * The enriched engine-error contract: sanitized `detail` + `remedy`
 * classification (owner decree 2026-08-02). Invariants: old events without the
 * new fields still validate (backward compat), the schema never admits a
 * detail longer than the sanitizer cap, and the remedy vocabulary is derived
 * from the real provider codes, one answer per failure.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyEngineRemedy,
  ENGINE_ERROR_REMEDIES,
} from "../engine-error-classification.js";
import { ENGINE_ERROR_DETAIL_MAX_LENGTH } from "../engine-error-sanitizer.js";
import { engineErrorEventSchema } from "../schemas/engine-error.js";

function legacyEvent(over: Record<string, unknown> = {}) {
  return {
    type: "engine.runtime.error" as const,
    sessionId: randomUUID(),
    missionRunId: null,
    scope: "turn" as const,
    category: "capacity" as const,
    errorType: null,
    errorClass: null,
    statusCode: null,
    causeCode: null,
    retryAfterSeconds: null,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    ...over,
  };
}

describe("engineErrorEventSchema - detail and remedy", () => {
  it("a legacy event without detail/remedy still validates, defaulting both to null", () => {
    const parsed = engineErrorEventSchema.parse(legacyEvent());
    expect(parsed.detail).toBeNull();
    expect(parsed.remedy).toBeNull();
  });

  it("carries a sanitized detail string through unchanged", () => {
    const parsed = engineErrorEventSchema.parse(
      legacyEvent({ detail: "Rate limit exceeded: free-models-per-day" }),
    );
    expect(parsed.detail).toBe("Rate limit exceeded: free-models-per-day");
  });

  it("cap seam: a detail at the sanitizer cap passes, one char past is rejected", () => {
    const atCap = "z".repeat(ENGINE_ERROR_DETAIL_MAX_LENGTH);
    expect(
      engineErrorEventSchema.safeParse(legacyEvent({ detail: atCap })).success,
    ).toBe(true);
    const pastCap = "z".repeat(ENGINE_ERROR_DETAIL_MAX_LENGTH + 1);
    expect(
      engineErrorEventSchema.safeParse(legacyEvent({ detail: pastCap })).success,
    ).toBe(false);
  });

  it("remedy is a closed vocabulary - an invented value is rejected", () => {
    expect(
      engineErrorEventSchema.safeParse(legacyEvent({ remedy: "reboot-universe" }))
        .success,
    ).toBe(false);
    for (const remedy of ENGINE_ERROR_REMEDIES) {
      expect(
        engineErrorEventSchema.safeParse(legacyEvent({ remedy })).success,
      ).toBe(true);
    }
  });
});

describe("classifyEngineRemedy - derived from the real provider codes", () => {
  it("payment_required means top up: insufficient-funds by type, class and status", () => {
    expect(classifyEngineRemedy({ errorType: "payment_required" })).toBe(
      "insufficient-funds",
    );
    expect(
      classifyEngineRemedy({ errorClass: "PaymentRequiredResponseError" }),
    ).toBe("insufficient-funds");
    expect(classifyEngineRemedy({ statusCode: 402 })).toBe("insufficient-funds");
  });

  it("auth and permission failures mean the provider config is wrong", () => {
    expect(classifyEngineRemedy({ errorType: "authentication" })).toBe(
      "config-invalid",
    );
    expect(classifyEngineRemedy({ errorType: "permission_denied" })).toBe(
      "config-invalid",
    );
    expect(classifyEngineRemedy({ statusCode: 401 })).toBe("config-invalid");
    expect(classifyEngineRemedy({ statusCode: 403 })).toBe("config-invalid");
  });

  it("a rate limit is rate-limited, not merely provider-down", () => {
    expect(classifyEngineRemedy({ errorType: "rate_limit_exceeded" })).toBe(
      "rate-limited",
    );
    expect(classifyEngineRemedy({ statusCode: 429 })).toBe("rate-limited");
    expect(
      classifyEngineRemedy({ errorClass: "TooManyRequestsResponseError" }),
    ).toBe("rate-limited");
  });

  it("overload, 5xx and transport failures are provider-down", () => {
    expect(classifyEngineRemedy({ errorType: "provider_overloaded" })).toBe(
      "provider-down",
    );
    expect(classifyEngineRemedy({ statusCode: 503 })).toBe("provider-down");
    expect(classifyEngineRemedy({ errorClass: "ConnectionError" })).toBe(
      "provider-down",
    );
    expect(classifyEngineRemedy({ causeCode: "ECONNRESET" })).toBe(
      "provider-down",
    );
  });

  it("context overflow points at compaction; a bad image points at the attachment", () => {
    expect(classifyEngineRemedy({ errorType: "context_length_exceeded" })).toBe(
      "compact-session",
    );
    expect(classifyEngineRemedy({ errorType: "invalid_image" })).toBe(
      "remove-attachment",
    );
  });

  it("failures with no user-side remedy answer null, never a guess", () => {
    expect(classifyEngineRemedy({ errorType: "invalid_request" })).toBeNull();
    expect(classifyEngineRemedy({ errorType: "refusal" })).toBeNull();
    expect(classifyEngineRemedy({})).toBeNull();
    expect(classifyEngineRemedy({ errorType: "unmapped" })).toBeNull();
  });
});
