/**
 * `error-bridge` — mapping + boundary invariants.
 *
 * The load-bearing properties: the bridge stamps the category from the ONE
 * shared classifier, narrows `errorClass` through the CLOSED boundary enum
 * instead of casting, and carries NO provider prose (there is no message field
 * at any layer, which is what makes the "no raw provider text to the renderer"
 * doctrine structural rather than a review habit).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { toRendererEngineError } from "../error-bridge.js";
import { engineErrorEventSchema } from "@shared/schemas/engine-error.js";
import type { EngineErrorEvent } from "@vex-agent/engine/runtime/error-bus.js";

const SESSION = "00000000-0000-4000-8000-00000000000a";

function engineEvent(over: Partial<EngineErrorEvent> = {}): EngineErrorEvent {
  return {
    type: "engine.runtime.error",
    sessionId: SESSION,
    missionRunId: null,
    scope: "turn",
    errorType: null,
    errorClass: null,
    statusCode: null,
    causeCode: null,
    retryAfterSeconds: null,
    occurredAt: "2026-07-29T10:00:00.000Z",
    correlationId: null,
    ...over,
  };
}

describe("strict-parse survival — the base notification is never sunk", () => {
  // The bridge validates with a STRICT parse, so one out-of-range OPTIONAL
  // used to drop the WHOLE permanent-failure event. The engine's emit funnel
  // now normalizes unusable optionals to null, so anything reaching here
  // satisfies the schema and the truthful base notification survives.
  it("an engine event whose optionals were normalized still parses", () => {
    const mapped = toRendererEngineError(
      engineEvent({ scope: "compact", statusCode: null, retryAfterSeconds: null }),
    );
    const parsed = engineErrorEventSchema.safeParse(mapped);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.statusCode).toBeNull();
      expect(parsed.data.category).toBe("unknown");
      expect(parsed.data.scope).toBe("compact");
    }
  });

  it("proves the schema WOULD have rejected the un-normalized values", () => {
    // Pins why the normalization has to exist: these are the exact shapes the
    // strict parse refuses, i.e. the events that used to vanish.
    for (const bad of [
      { statusCode: 0 },
      { statusCode: 99_999 },
      { retryAfterSeconds: 0 },
      { retryAfterSeconds: 1_000_000 },
      { errorType: "Rate Limit Exceeded" },
      { causeCode: "not an errno" },
    ]) {
      const parsed = engineErrorEventSchema.safeParse({
        ...toRendererEngineError(engineEvent()),
        ...bad,
      });
      expect(parsed.success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("toRendererEngineError", () => {
  it("stamps the category from the provider's own taxonomy", () => {
    const mapped = toRendererEngineError(
      engineEvent({ errorType: "rate_limit_exceeded", retryAfterSeconds: 41 }),
    );
    expect(mapped?.category).toBe("capacity");
    expect(mapped?.retryAfterSeconds).toBe(41);
    expect(engineErrorEventSchema.safeParse(mapped).success).toBe(true);
  });

  it("classifies a status-less transport class from its NAME alone", () => {
    // The six status-less SDK shapes have no other signal; this is why
    // `errorClass` is plumbed at all.
    const mapped = toRendererEngineError(
      engineEvent({ errorClass: "SDKValidationError" }),
    );
    expect(mapped?.category).toBe("unreadable_response");
    expect(mapped?.statusCode).toBeNull();
  });

  it("drops an out-of-dictionary errorClass WITHOUT dropping the event", () => {
    // An SDK upgrade adding a class must not swallow a real failure the user
    // still needs to see — the status branch already answered for it.
    const mapped = toRendererEngineError(
      engineEvent({ errorClass: "BrandNewSdkError", statusCode: 503 }),
    );
    expect(mapped?.errorClass).toBeNull();
    expect(mapped?.category).toBe("capacity");
    expect(engineErrorEventSchema.safeParse(mapped).success).toBe(true);
  });

  it("carries no message field of any kind", () => {
    const mapped = toRendererEngineError(engineEvent({ statusCode: 500 }));
    expect(mapped).not.toBeNull();
    const keys = Object.keys(mapped ?? {});
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("errorMessage");
    expect(keys).not.toContain("stopSummary");
  });

  it("resolves an unmapped failure to `unknown` rather than throwing", () => {
    expect(toRendererEngineError(engineEvent())?.category).toBe("unknown");
  });

  it("keeps an open-enum errorType verbatim as data", () => {
    const mapped = toRendererEngineError(
      engineEvent({ errorType: "some_future_member" }),
    );
    expect(mapped?.errorType).toBe("some_future_member");
    expect(mapped?.category).toBe("unknown");
  });
});
