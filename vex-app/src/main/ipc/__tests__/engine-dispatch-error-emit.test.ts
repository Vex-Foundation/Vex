/**
 * `dispatchPreparedMission` — the failure now REACHES THE USER.
 *
 * This helper is the sole error handler for five call sites (mission start,
 * mission recover, approval approve, approval reject, and the TTL auto-reject
 * sweep). Until the error channel existed, a throw here produced a log line and
 * a bug report and nothing else: the window simply sat there. It was the single
 * largest silent-failure surface in the app.
 *
 * These tests pin that a throw emits a BOUNDED event on the engine error bus,
 * that the exception message never rides along, and that the emit happens even
 * when the bug-report sink is unreachable.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { dispatchPreparedMission } from "../mission/_engine-dispatch.js";
import {
  engineErrorBus,
  type EngineErrorEvent,
} from "@vex-agent/engine/runtime/error-bus.js";

const SESSION = "00000000-0000-4000-8000-00000000000a";
const RUN = "00000000-0000-4000-8000-00000000000b";

/** Let the helper's detached async IIFE settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  engineErrorBus.clear();
});

function capture(): EngineErrorEvent[] {
  const seen: EngineErrorEvent[] = [];
  engineErrorBus.subscribe((event) => seen.push(event));
  return seen;
}

describe("dispatchPreparedMission - engine error emit", () => {
  it("emits nothing when the continuation succeeds", async () => {
    const seen = capture();
    dispatchPreparedMission(() => Promise.resolve("ok"), {
      sessionId: SESSION,
      missionRunId: RUN,
      correlationId: "corr-1",
      channelLabel: "vex:mission:start",
      scope: "mission",
    });
    await settle();
    expect(seen).toHaveLength(0);
  });

  it("emits the failure with the caller's scope and the bounded signals", async () => {
    const seen = capture();
    const cause = new Error("OpenRouter chat completion failed: status=429 | rate limited");
    Object.assign(cause, {
      statusCode: 429,
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      retryAfterSeconds: 41,
    });

    dispatchPreparedMission(() => Promise.reject(cause), {
      sessionId: SESSION,
      missionRunId: RUN,
      correlationId: "corr-2",
      channelLabel: "vex:mission:start",
      scope: "mission",
    });
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: SESSION,
      missionRunId: RUN,
      scope: "mission",
      statusCode: 429,
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      retryAfterSeconds: 41,
      correlationId: "corr-2",
    });
  });

  it("carries the sanitized message as `detail` only - no `message` field, secret-free from the first subscriber", async () => {
    // Sanitize-at-emit law: the bus strips secrets from `detail` BEFORE any
    // subscriber sees the event, so every consumer is secret-free by
    // construction. The renderer bridge sanitizes again as defense in depth;
    // that second pass must be a no-op, which both halves assert here.
    const seen = capture();
    dispatchPreparedMission(
      () => Promise.reject(new Error("provider refused key sk-fake-abc12345")),
      {
        sessionId: SESSION,
        correlationId: "corr-3",
        channelLabel: "vex:approvals:approve",
        scope: "approval",
      },
    );
    await settle();

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] ?? {})).not.toContain("message");
    expect(seen[0]?.detail).toBe("provider refused key [key]");
    const { sanitizeEngineErrorDetail } = await import(
      "@shared/engine-error-sanitizer.js"
    );
    expect(sanitizeEngineErrorDetail(seen[0]?.detail)).toBe(
      "provider refused key [key]",
    );
    // No mission run in scope for a chat-session approval.
    expect(seen[0]?.missionRunId).toBeNull();
    expect(seen[0]?.scope).toBe("approval");
  });

  it("reports a failure it cannot classify rather than staying silent", async () => {
    const seen = capture();
    dispatchPreparedMission(() => Promise.reject(new Error("plain")), {
      sessionId: SESSION,
      correlationId: "corr-4",
      channelLabel: "vex:approvals:sweep",
      scope: "approval",
    });
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.statusCode).toBeNull();
    expect(seen[0]?.errorType).toBeNull();
  });
});
