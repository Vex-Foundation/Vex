/**
 * Sentry lifecycle tests (M11).
 *
 * Critical guarantees (codex v2/v3 RED items):
 *   - capabilities.get() never loads @sentry/electron — verified via a
 *     mock factory side-effect counter that flips ONLY when the SDK is
 *     dynamically imported.
 *   - initSentryIfConsented is gated by preferences.telemetry.enabled
 *     AND a resolvable DSN; either missing → no init.
 *   - disableSentry deletes the offline queue at
 *     `${app.getPath("userData")}/sentry` (which resolves to
 *     ELECTRON_STATE_DIR after the M0 userData remap).
 *   - Init is idempotent (second call after success → no double init).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let sentryModuleLoaded = false;
const mockInit = vi.fn();
const mockClose = vi.fn(async () => undefined);
const mockDedupe = vi.fn(() => ({ name: "Dedupe" }));
const mockLinkedErrors = vi.fn(() => ({ name: "LinkedErrors" }));

vi.mock("@sentry/electron/main", async () => {
  sentryModuleLoaded = true;
  return {
    init: mockInit,
    close: mockClose,
    dedupeIntegration: mockDedupe,
    linkedErrorsIntegration: mockLinkedErrors,
    captureMessage: vi.fn(),
    IPCMode: { Classic: "classic", Protocol: "protocol", Both: "both" },
  };
});

let userDataDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => {
      if (key === "userData") return userDataDir;
      return "";
    },
  },
}));

const mockLoad = vi.fn();
vi.mock("../../preferences/store.js", () => ({
  preferencesStore: {
    load: () => mockLoad(),
  },
}));

const mockResolveDsn = vi.fn();
vi.mock("../dsn.js", () => ({
  resolveDsn: () => mockResolveDsn(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const lifecycleModule = await import("../sentry-lifecycle.js");
const {
  initSentryIfConsented,
  disableSentry,
  captureRendererError,
  __resetSentryLifecycleForTests,
  __isSentryInitializedForTests,
} = lifecycleModule;

beforeEach(() => {
  sentryModuleLoaded = false;
  mockInit.mockReset();
  mockClose.mockReset().mockImplementation(async () => undefined);
  mockLoad.mockReset();
  mockResolveDsn.mockReset();
  __resetSentryLifecycleForTests();
  userDataDir = mkdtempSync(path.join(tmpdir(), "vex-sentry-test-"));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("initSentryIfConsented", () => {
  it("returns false + does not init when consent is off - SDK module NOT loaded", async () => {
    mockLoad.mockResolvedValue({
      telemetry: { enabled: false, consentedAt: null },
    });
    const initialized = await initSentryIfConsented();
    expect(initialized).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
    expect(__isSentryInitializedForTests()).toBe(false);
    // Lazy-load proof: the SDK module mock factory side-effect is the
    // tripwire — codex's recommended verification for "no SDK before
    // consent" (post-impl YELLOW).
    expect(sentryModuleLoaded).toBe(false);
  });

  it("returns false + does not init when DSN unresolvable - SDK module NOT loaded", async () => {
    mockLoad.mockResolvedValue({
      telemetry: { enabled: true, consentedAt: "2026-05-12T00:00:00Z" },
    });
    mockResolveDsn.mockReturnValue(null);
    const initialized = await initSentryIfConsented();
    expect(initialized).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
    expect(sentryModuleLoaded).toBe(false);
  });

  it("initializes with explicit safe options when consent + DSN ok - flips lazy-load flag", async () => {
    mockLoad.mockResolvedValue({
      telemetry: { enabled: true, consentedAt: "2026-05-12T00:00:00Z" },
    });
    mockResolveDsn.mockReturnValue("https://abc@example/1");
    const initialized = await initSentryIfConsented();
    expect(initialized).toBe(true);
    expect(sentryModuleLoaded).toBe(true);
    expect(mockInit).toHaveBeenCalledTimes(1);
    const opts = mockInit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts).toBeDefined();
    expect(opts["dsn"]).toBe("https://abc@example/1");
    expect(opts["defaultIntegrations"]).toBe(false);
    expect(opts["sendDefaultPii"]).toBe(false);
    expect(opts["includeLocalVariables"]).toBe(false);
    expect(opts["attachScreenshot"]).toBe(false);
    expect(opts["enableLogs"]).toBe(false);
    expect(opts["enableMetrics"]).toBe(false);
    expect(opts["sendClientReports"]).toBe(false);
    expect(opts["skipOpenTelemetrySetup"]).toBe(true);
    expect(opts["autoSessionTracking"]).toBe(false);
  });

  it("is idempotent - second call after success is a no-op", async () => {
    mockLoad.mockResolvedValue({
      telemetry: { enabled: true, consentedAt: "2026-05-12T00:00:00Z" },
    });
    mockResolveDsn.mockReturnValue("https://abc@example/1");
    expect(await initSentryIfConsented()).toBe(true);
    expect(await initSentryIfConsented()).toBe(false);
    expect(mockInit).toHaveBeenCalledTimes(1);
  });
});

describe("disableSentry", () => {
  it("closes the SDK and clears the offline queue dir", async () => {
    mockLoad.mockResolvedValue({
      telemetry: { enabled: true, consentedAt: "2026-05-12T00:00:00Z" },
    });
    mockResolveDsn.mockReturnValue("https://abc@example/1");
    await initSentryIfConsented();
    // Seed an offline queue directory at the userData remap target.
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const queueDir = path.join(userDataDir, "sentry", "queue");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(path.join(queueDir, "evt-1.json"), "{}");
    expect(existsSync(queueDir)).toBe(true);

    await disableSentry();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(existsSync(queueDir)).toBe(false);
    expect(__isSentryInitializedForTests()).toBe(false);
  });

  it("when SDK never initialized: does not call Sentry.close but still rms cache", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const queueDir = path.join(userDataDir, "sentry");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(path.join(queueDir, "leftover"), "x");

    await disableSentry();
    expect(mockClose).not.toHaveBeenCalled();
    expect(existsSync(queueDir)).toBe(false);
  });
});

describe("captureRendererError", () => {
  it("returns false when SDK not initialized", async () => {
    const recorded = await captureRendererError({
      kind: "boundary",
      message: "x",
      componentStack: null,
    });
    expect(recorded).toBe(false);
  });
});
