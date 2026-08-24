/**
 * engine-log-bridge tests (error-diagnostics plan D-SINK / §3.5).
 *
 * Uses the REAL engine winston logger (`@utils/logger`) and the REAL
 * redacting wrapper (`main/logger/index.ts`), mocking only the
 * `electron-log/main.js` sink underneath (plus `electron`, which the wrapper
 * imports for `configureLogger` — never called here). Pins:
 *   - level mapping error→error / warn→warn / info→info, debug skipped;
 *   - meta passes through `redactArgs` (secret field → "[REDACTED]");
 *   - `installEngineLogBridge()` is idempotent;
 *   - the forward never re-enters winston (no recursion) even if the sink
 *     misbehaves and logs back through the engine logger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronLogSpies = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
  silly: vi.fn(),
}));

vi.mock("electron-log/main.js", () => ({ default: electronLogSpies }));
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: vi.fn(() => "/tmp/vex-test-user-data") },
}));

const { installEngineLogBridge, __resetEngineLogBridgeForTests } = await import(
  "../engine-log-bridge.js"
);
const { logger: engineLogger } = await import("@utils/logger.js");

const ORIGINAL_LEVEL = engineLogger.level;

beforeEach(() => {
  for (const spy of Object.values(electronLogSpies)) spy.mockReset();
});

afterEach(() => {
  __resetEngineLogBridgeForTests();
  engineLogger.level = ORIGINAL_LEVEL;
});

describe("installEngineLogBridge", () => {
  it("forwards error→log.error as `[engine] <message>` + meta object", () => {
    installEngineLogBridge();
    engineLogger.error("inference.openrouter.api_unreachable", {
      model: "test/model",
      causeCode: "ENOTFOUND",
    });
    expect(electronLogSpies.error).toHaveBeenCalledTimes(1);
    const [line, meta] = electronLogSpies.error.mock.calls[0] ?? [];
    expect(line).toBe("[engine] inference.openrouter.api_unreachable");
    // level/message/timestamp/service stripped; payload meta forwarded.
    expect(meta).toEqual({ model: "test/model", causeCode: "ENOTFOUND" });
  });

  it("forwards warn→log.warn and info→log.info", () => {
    installEngineLogBridge();
    engineLogger.warn("sync.worker.mtm_failed", { causeCode: "ETIMEDOUT" });
    engineLogger.info("sync.worker.drain_completed", { processed: 1 });
    expect(electronLogSpies.warn).toHaveBeenCalledTimes(1);
    expect(String(electronLogSpies.warn.mock.calls[0]?.[0])).toBe(
      "[engine] sync.worker.mtm_failed",
    );
    expect(electronLogSpies.info).toHaveBeenCalledTimes(1);
    expect(String(electronLogSpies.info.mock.calls[0]?.[0])).toBe(
      "[engine] sync.worker.drain_completed",
    );
  });

  it("omits the meta argument when there is no payload meta", () => {
    installEngineLogBridge();
    engineLogger.warn("bare.warning");
    expect(electronLogSpies.warn).toHaveBeenCalledTimes(1);
    expect(electronLogSpies.warn.mock.calls[0]).toEqual([
      "[engine] bare.warning",
    ]);
  });

  it("does NOT forward debug even when the engine logger level allows it", () => {
    installEngineLogBridge();
    engineLogger.level = "debug";
    engineLogger.debug("noisy.debug.event", { detail: 1 });
    for (const spy of Object.values(electronLogSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("redacts secrets in forwarded meta via the wrapper's redactArgs", () => {
    installEngineLogBridge();
    engineLogger.error("provider.call_failed", {
      token: "sk-or-super-secret-value",
      model: "test/model",
    });
    expect(electronLogSpies.error).toHaveBeenCalledTimes(1);
    const meta = electronLogSpies.error.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(meta.token).toBe("[REDACTED]");
    expect(meta.model).toBe("test/model");
  });

  it("scrubs inline secret patterns in the message string", () => {
    installEngineLogBridge();
    const evmKey = `0x${"a".repeat(64)}`;
    engineLogger.error(`leaked key ${evmKey}`);
    const line = String(electronLogSpies.error.mock.calls[0]?.[0]);
    expect(line).not.toContain(evmKey);
    expect(line).toContain("[REDACTED]");
  });

  it("install is idempotent - double install adds exactly one transport", () => {
    const before = engineLogger.transports.length;
    installEngineLogBridge();
    installEngineLogBridge();
    expect(engineLogger.transports.length).toBe(before + 1);
    engineLogger.error("once");
    expect(electronLogSpies.error).toHaveBeenCalledTimes(1);
  });

  it("never re-enters winston: one engine log line → exactly one winston write and one sink call", () => {
    installEngineLogBridge();
    // Every entry into winston goes through `logger.write` — if the forward
    // wrote back through the engine logger (a loop), the spy would count a
    // second write. One write + one sink call pins the one-way direction.
    const writeSpy = vi.spyOn(engineLogger, "write");
    try {
      engineLogger.error("first", { causeCode: "ECONNREFUSED" });
      expect(electronLogSpies.error).toHaveBeenCalledTimes(1);
      expect(String(electronLogSpies.error.mock.calls[0]?.[0])).toBe(
        "[engine] first",
      );
      expect(writeSpy).toHaveBeenCalledTimes(1);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
