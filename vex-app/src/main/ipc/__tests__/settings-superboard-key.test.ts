import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences, type Preferences } from "@shared/schemas/preferences.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const state = vi.hoisted(() => ({ preferences: null as Preferences | null }));
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  whenEngineDbReady: vi.fn(),
  getUserProfile: vi.fn(),
  setUserProfile: vi.fn(),
  getReportingState: vi.fn(),
  persistShareToken: vi.fn(),
  persistRotationCandidate: vi.fn(),
  markShareTokenRegistered: vi.fn(),
  commitShareTokenRotation: vi.fn(),
  registerPersistedShareToken: vi.fn(),
  rotatePersistedShareToken: vi.fn(),
  resolveAgentscanBaseUrl: vi.fn(),
  loadConfig: vi.fn(),
  readShareTokenRotationAvailability: vi.fn(),
  fetchCapabilities: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));

vi.mock("../../preferences/store.js", () => ({
  preferencesStore: {
    load: async () => state.preferences,
    update: async (patch: Partial<Preferences>) => {
      if (state.preferences === null) throw new Error("Preferences were not initialized");
      state.preferences = {
        ...state.preferences,
        ...patch,
      };
      return state.preferences;
    },
  },
}));
vi.mock("../../telemetry/sentry-lifecycle.js", () => ({
  disableSentry: vi.fn(),
  initSentryIfConsented: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...args: unknown[]) => mocks.ensureEngineDbUrl(...args),
  whenEngineDbReady: (...args: unknown[]) => mocks.whenEngineDbReady(...args),
  EngineDbWaitAbortedError: class EngineDbWaitAbortedError extends Error {
    constructor() {
      super("engine database wait aborted");
      this.name = "EngineDbWaitAbortedError";
    }
  },
}));
vi.mock("@vex-agent/db/repos/soul.js", () => ({
  getUserProfile: (...args: unknown[]) => mocks.getUserProfile(...args),
  setUserProfile: (...args: unknown[]) => mocks.setUserProfile(...args),
}));
vi.mock("@vex-agent/db/repos/agentscan-reporting.js", () => ({
  getReportingState: (...args: unknown[]) => mocks.getReportingState(...args),
  persistShareToken: (...args: unknown[]) => mocks.persistShareToken(...args),
  persistRotationCandidate: (...args: unknown[]) => mocks.persistRotationCandidate(...args),
  markShareTokenRegistered: (...args: unknown[]) => mocks.markShareTokenRegistered(...args),
  commitShareTokenRotation: (...args: unknown[]) => mocks.commitShareTokenRotation(...args),
}));
vi.mock("@vex-agent/agentscan/register-share-token.js", () => ({
  registerPersistedShareToken: (...args: unknown[]) => mocks.registerPersistedShareToken(...args),
  rotatePersistedShareToken: (...args: unknown[]) => mocks.rotatePersistedShareToken(...args),
}));
vi.mock("@vex-agent/agentscan/share-token-rotation-capability.js", () => ({
  readShareTokenRotationAvailability: (...args: unknown[]) =>
    mocks.readShareTokenRotationAvailability(...args),
}));
vi.mock("@vex-agent/agentscan/client.js", () => ({
  buildAgentscanClient: () => ({ fetchCapabilities: mocks.fetchCapabilities }),
}));
vi.mock("@vex-agent/sync/agentscan-report/production-deps.js", () => ({
  resolveAgentscanBaseUrl: (...args: unknown[]) => mocks.resolveAgentscanBaseUrl(...args),
}));
vi.mock("@config/store.js", () => ({
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
}));

const { registerSettingsHandlers } = await import("../settings.js");
const { CH } = await import("@shared/ipc/channels.js");
const { log } = await import("../../logger/index.js");

const sender = createTrustedSender({ sender: createTestWebContents() });
const SHARE = "A".repeat(43);
const CANDIDATE = "N".repeat(43);
const INGEST = "I".repeat(43);
const REQUEST_ID = "00000000-0000-4000-8000-000000000333";

type CallResult = {
  readonly ok: boolean;
  readonly data?: SuperboardKeyStatus;
  readonly error?: { readonly code: string };
};

async function call(channel: string, payload: unknown): Promise<CallResult> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Handler not registered: ${channel}`);
  return (await handler(sender, {
    requestId: REQUEST_ID,
    payload,
  })) as CallResult;
}

function reportingState(overrides: Record<string, unknown> = {}) {
  return {
    agentHash: "a".repeat(64),
    registrationGeneration: 0,
    ingestToken: INGEST,
    shareToken: null,
    shareTokenRegisteredAt: null,
    shareTokenRotationCandidate: null,
    shareTokenRotatedAt: null,
    ...overrides,
  };
}

function attemptLines(): string[] {
  return vi.mocked(log.info).mock.calls
    .map((args) => String(args[0]))
    .filter((line) => line.includes("[agentscan:share-token] attempt"));
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  state.preferences = structuredClone(defaultPreferences);
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.whenEngineDbReady.mockResolvedValue(undefined);
  mocks.resolveAgentscanBaseUrl.mockReturnValue("http://localhost");
  mocks.loadConfig.mockReturnValue({ services: { agentscanApiUrl: "http://localhost" } });
  mocks.registerPersistedShareToken.mockResolvedValue({ kind: "registered" });
  mocks.rotatePersistedShareToken.mockResolvedValue({ kind: "registered" });
  mocks.readShareTokenRotationAvailability.mockResolvedValue({ kind: "available" });
  registerSettingsHandlers();
});

describe("settings.getSuperboardKey", () => {
  it("returns not_ready when ingestToken is null", async () => {
    mocks.getReportingState.mockResolvedValue(reportingState({ ingestToken: null, agentHash: null }));
    const result = await call(CH.settings.getSuperboardKey, {});
    expect(result).toEqual({ ok: true, data: { kind: "not_ready" } });
    expect(JSON.stringify(result)).not.toContain("ingestToken");
    expect(JSON.stringify(result)).not.toContain(INGEST);
    expect(mocks.registerPersistedShareToken).not.toHaveBeenCalled();
    expect(attemptLines()).toHaveLength(0);
  });

  it("returns registered with rotation from availability and never includes secrets", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
    );
    const result = await call(CH.settings.getSuperboardKey, {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      kind: "registered",
      shareToken: SHARE,
      rotation: { kind: "available" },
      rotatedAt: null,
    });
    expect(JSON.stringify(result)).not.toContain("ingestToken");
    expect(JSON.stringify(result)).not.toContain("agentHash");
    expect(mocks.registerPersistedShareToken).not.toHaveBeenCalled();
  });

  it("retries ensure when a token is pending", async () => {
    mocks.getReportingState
      .mockResolvedValueOnce(reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }))
      .mockResolvedValueOnce(
        reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
      );
    mocks.registerPersistedShareToken.mockResolvedValueOnce({ kind: "registered" });
    const result = await call(CH.settings.getSuperboardKey, {});
    expect(result.data).toEqual({
      kind: "registered",
      shareToken: SHARE,
      rotation: { kind: "available" },
      rotatedAt: null,
    });
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(1);
  });

  it("does not remint from GET after auth_lost; generate still mints", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }),
    );
    mocks.registerPersistedShareToken.mockResolvedValue({ kind: "auth_lost" });
    const first = await call(CH.settings.getSuperboardKey, {});
    expect(first.data).toMatchObject({
      kind: "pending",
      shareToken: SHARE,
      attempt: {
        kind: "failed",
        failure: { kind: "auth_lost" },
        detail: "unauthorized",
        correlationId: REQUEST_ID,
      },
    });
    await call(CH.settings.getSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(1);
    await call(CH.settings.generateSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(2);
  });

  it("holds a 4xx http failure until an explicit call", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }),
    );
    mocks.registerPersistedShareToken.mockResolvedValue({
      kind: "http",
      status: 400,
      code: "validation_failed",
      retryAfterSeconds: null,
      detail: "HTTP 400 validation_failed",
    });
    const first = await call(CH.settings.getSuperboardKey, {});
    expect(first.data).toMatchObject({
      kind: "pending",
      attempt: {
        kind: "failed",
        failure: { kind: "http", status: 400, code: "validation_failed" },
        detail: "HTTP 400 validation_failed",
      },
    });
    await call(CH.settings.getSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(1);
    await call(CH.settings.generateSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(2);
  });

  it("skips GET mint during a rate_limited cooldown and retries after", async () => {
    vi.useFakeTimers();
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }),
    );
    mocks.registerPersistedShareToken.mockResolvedValue({
      kind: "rate_limited",
      retryAfterSeconds: 60,
      detail: "HTTP 429 rate_limited",
    });
    await call(CH.settings.getSuperboardKey, {});
    await call(CH.settings.getSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await call(CH.settings.getSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("cools a transport failure down for 30 seconds by default", async () => {
    vi.useFakeTimers();
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }),
    );
    mocks.registerPersistedShareToken.mockResolvedValue({
      kind: "transport",
      reason: "network",
      detail: "VexError: fetch failed (ECONNREFUSED)",
    });
    const first = await call(CH.settings.getSuperboardKey, {});
    expect(first.data).toMatchObject({
      kind: "pending",
      attempt: { kind: "failed", failure: { kind: "transport", reason: "network" } },
    });
    await vi.advanceTimersByTimeAsync(29_999);
    await call(CH.settings.getSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await call(CH.settings.getSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("retries the same pending token after server recovery advances the identity generation", async () => {
    mocks.getReportingState.mockResolvedValue(reportingState({ shareToken: SHARE }));
    mocks.registerPersistedShareToken.mockResolvedValueOnce({ kind: "auth_lost" });
    await call(CH.settings.getSuperboardKey, {});

    mocks.getReportingState
      .mockResolvedValueOnce(reportingState({ shareToken: SHARE, registrationGeneration: 1 }))
      .mockResolvedValueOnce(reportingState({
        shareToken: SHARE,
        registrationGeneration: 1,
        shareTokenRegisteredAt: "2026-09-08T00:00:00.000Z",
      }));
    mocks.registerPersistedShareToken.mockResolvedValueOnce({ kind: "registered" });

    const result = await call(CH.settings.getSuperboardKey, {});
    expect(result.data).toMatchObject({ kind: "registered", shareToken: SHARE });
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(2);
  });

  it("reports unknown rotation availability when the base URL is missing", async () => {
    mocks.resolveAgentscanBaseUrl.mockReturnValue(null);
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
    );
    const result = await call(CH.settings.getSuperboardKey, {});
    expect(result.data).toEqual({
      kind: "registered",
      shareToken: SHARE,
      rotation: { kind: "unavailable", reason: "unknown" },
      rotatedAt: null,
    });
    expect(mocks.readShareTokenRotationAvailability).not.toHaveBeenCalled();
  });
});

describe("settings.generateSuperboardKey", () => {
  it("registers the existing token and never rotates", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
    );
    const result = await call(CH.settings.generateSuperboardKey, {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      kind: "registered",
      shareToken: SHARE,
      rotation: { kind: "available" },
      rotatedAt: null,
    });
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(1);
    expect(mocks.rotatePersistedShareToken).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("ingestToken");
  });

  it("does not remint when AgentScan reports share_token_conflict", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }),
    );
    mocks.registerPersistedShareToken.mockResolvedValue({ kind: "conflict" });
    const result = await call(CH.settings.generateSuperboardKey, {});
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      kind: "pending",
      shareToken: SHARE,
      attempt: {
        kind: "failed",
        failure: { kind: "conflict" },
        detail: "conflict",
        correlationId: REQUEST_ID,
      },
    });
  });

  it.each([
    {
      outcome: { kind: "http", status: 400, code: "validation_failed", retryAfterSeconds: null, detail: "HTTP 400 validation_failed" },
      failure: { kind: "http", status: 400, code: "validation_failed" },
      detail: "HTTP 400 validation_failed",
    },
    {
      outcome: { kind: "http", status: 503, code: "internal", retryAfterSeconds: 15, detail: "HTTP 503 internal" },
      failure: { kind: "http", status: 503, code: "internal" },
      detail: "HTTP 503 internal",
    },
    {
      outcome: { kind: "transport", reason: "timeout", detail: "VexError: Request timed out after 15000ms" },
      failure: { kind: "transport", reason: "timeout" },
      detail: "VexError: Request timed out after 15000ms",
    },
    {
      outcome: { kind: "malformed_response", detail: "malformed share-token response" },
      failure: { kind: "malformed_response" },
      detail: "malformed response",
    },
    {
      outcome: { kind: "conflict" },
      failure: { kind: "conflict" },
      detail: "conflict",
    },
    {
      outcome: { kind: "auth_lost" },
      failure: { kind: "auth_lost" },
      detail: "unauthorized",
    },
    {
      outcome: { kind: "stopped", reason: "consent_revoked" },
      failure: { kind: "stopped", reason: "consent_revoked" },
      detail: "consent_revoked",
    },
    {
      outcome: { kind: "stopped", reason: "quarantined" },
      failure: { kind: "stopped", reason: "quarantined" },
      detail: "quarantined",
    },
    {
      outcome: { kind: "rate_limited", retryAfterSeconds: 12, detail: "HTTP 429 rate_limited" },
      failure: { kind: "rate_limited", retryAfterSeconds: 12 },
      detail: "HTTP 429 rate_limited",
    },
  ])("maps $outcome.kind to its structured failure", async ({ outcome, failure, detail }) => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }),
    );
    mocks.registerPersistedShareToken.mockResolvedValue(outcome);
    const result = await call(CH.settings.generateSuperboardKey, {});
    expect(result.data).toMatchObject({
      kind: "pending",
      shareToken: SHARE,
      attempt: { kind: "failed", failure, detail, correlationId: REQUEST_ID },
    });
    const attempt = (result.data as { attempt: { at: string; durationMs: number } }).attempt;
    expect(Number.isNaN(Date.parse(attempt.at))).toBe(false);
    expect(typeof attempt.durationMs).toBe("number");
  });
});

describe("settings.rotateSuperboardKey", () => {
  it("refuses without a request when the server predates rotation", async () => {
    mocks.readShareTokenRotationAvailability.mockResolvedValue({ kind: "unavailable", reason: "server" });
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
    );
    const result = await call(CH.settings.rotateSuperboardKey, {});
    expect(result.data).toEqual({
      kind: "registered",
      shareToken: SHARE,
      rotation: { kind: "unavailable", reason: "server" },
      rotatedAt: null,
    });
    expect(mocks.rotatePersistedShareToken).not.toHaveBeenCalled();
    expect(mocks.registerPersistedShareToken).not.toHaveBeenCalled();
    expect(attemptLines()).toHaveLength(0);
  });

  it("refuses without a request when availability is unknown", async () => {
    mocks.readShareTokenRotationAvailability.mockResolvedValue({ kind: "unknown", reason: "transport" });
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
    );
    const result = await call(CH.settings.rotateSuperboardKey, {});
    expect(result.data).toEqual({
      kind: "registered",
      shareToken: SHARE,
      rotation: { kind: "unavailable", reason: "unknown" },
      rotatedAt: null,
    });
    expect(mocks.rotatePersistedShareToken).not.toHaveBeenCalled();
    expect(mocks.registerPersistedShareToken).not.toHaveBeenCalled();
  });

  it("rotates when available and surfaces rotatedAt after the commit", async () => {
    mocks.getReportingState
      .mockResolvedValueOnce(
        reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
      )
      .mockResolvedValueOnce(
        reportingState({
          shareToken: CANDIDATE,
          shareTokenRegisteredAt: "2026-09-08T00:00:00.000Z",
          shareTokenRotatedAt: "2026-09-08T00:00:00.000Z",
        }),
      );
    mocks.rotatePersistedShareToken.mockResolvedValueOnce({ kind: "registered" });
    const result = await call(CH.settings.rotateSuperboardKey, {});
    expect(mocks.rotatePersistedShareToken).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({
      kind: "registered",
      shareToken: CANDIDATE,
      rotation: { kind: "available" },
      rotatedAt: "2026-09-08T00:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain(SHARE);
    // The commit clears the candidate on both sides of the attempt; the log
    // still states what went on the wire.
    const lines = attemptLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("action=rotate outcome=registered");
    expect(lines[0]).toContain("rotation=true");
  });

  it("retries a pending rotation even when availability is unknown", async () => {
    mocks.readShareTokenRotationAvailability.mockResolvedValue({ kind: "unknown", reason: "refused" });
    mocks.getReportingState.mockResolvedValue(
      reportingState({
        shareToken: SHARE,
        shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z",
        shareTokenRotationCandidate: CANDIDATE,
      }),
    );
    mocks.rotatePersistedShareToken.mockResolvedValue({
      kind: "transport",
      reason: "timeout",
      detail: "VexError: Request timed out after 15000ms",
    });
    const result = await call(CH.settings.rotateSuperboardKey, {});
    expect(mocks.rotatePersistedShareToken).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      kind: "registered",
      shareToken: SHARE,
      rotation: {
        kind: "pending",
        attempt: {
          kind: "failed",
          failure: { kind: "transport", reason: "timeout" },
          correlationId: REQUEST_ID,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(CANDIDATE);
  });

  it("returns the current status unchanged when rotation is not allowed", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }),
    );
    mocks.rotatePersistedShareToken.mockResolvedValue({
      kind: "rotation_not_allowed",
      reason: "not_registered",
    });
    const result = await call(CH.settings.rotateSuperboardKey, {});
    expect(result.data).toEqual({
      kind: "pending",
      shareToken: SHARE,
      attempt: { kind: "none" },
    });
    const lines = attemptLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("action=rotate outcome=rotation_not_allowed");
    expect(lines[0]).toContain("reason=not_registered correlationId=");
  });
});

describe("settings superboard key attempt log", () => {
  it("writes exactly one line per attempt with the correlation id and never a secret", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: null }),
    );
    mocks.registerPersistedShareToken.mockResolvedValue({ kind: "conflict" });
    await call(CH.settings.getSuperboardKey, {});
    await call(CH.settings.getSuperboardKey, {});
    await call(CH.settings.generateSuperboardKey, {});
    const lines = attemptLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("action=get");
    expect(lines[0]).toContain("outcome=conflict");
    expect(lines[0]).toContain(`correlationId=${REQUEST_ID}`);
    expect(lines[0]).toContain("rotation=false");
    expect(lines[1]).toContain("action=ensure");
    for (const line of lines) {
      expect(line).not.toContain(SHARE);
      expect(line).not.toContain(CANDIDATE);
      expect(line).not.toContain(INGEST);
      expect(line).not.toContain("http://localhost");
    }
  });

  it("logs transport reason, http status and code, and rotation attempts", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({
        shareToken: SHARE,
        shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z",
        shareTokenRotationCandidate: CANDIDATE,
      }),
    );
    mocks.registerPersistedShareToken.mockResolvedValue({
      kind: "transport",
      reason: "redirect",
      detail: "VexError: fetch failed (unexpected redirect)",
    });
    await call(CH.settings.getSuperboardKey, {});
    mocks.rotatePersistedShareToken.mockResolvedValue({
      kind: "http",
      status: 400,
      code: "validation_failed",
      retryAfterSeconds: null,
      detail: "HTTP 400 validation_failed",
    });
    await call(CH.settings.rotateSuperboardKey, {});
    const lines = attemptLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("transport=redirect");
    expect(lines[0]).toContain("rotation=true");
    expect(lines[0]).toContain("status=-");
    expect(lines[1]).toContain("action=rotate");
    expect(lines[1]).toContain("outcome=http");
    expect(lines[1]).toContain("status=400");
    expect(lines[1]).toContain("code=validation_failed");
    expect(lines[1]).toContain("rotation=true");
  });
});

describe("settings.regenerateSuperboardKey", () => {
  it("does not register a regenerate Superboard key channel", () => {
    expect(handlers.has("vex:settings:regenerateSuperboardKey")).toBe(false);
  });
});

describe("settings superboard key readiness", () => {
  it("returns internal.unexpected when the engine database wait fails", async () => {
    mocks.whenEngineDbReady.mockRejectedValueOnce(new Error("aborted"));
    const result = await call(CH.settings.getSuperboardKey, {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
    expect(mocks.getReportingState).not.toHaveBeenCalled();
  });
});
