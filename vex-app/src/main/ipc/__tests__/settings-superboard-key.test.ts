import { beforeEach, describe, expect, it, vi } from "vitest";

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
  markShareTokenRegistered: vi.fn(),
  registerPersistedShareToken: vi.fn(),
  resolveAgentscanBaseUrl: vi.fn(),
  loadConfig: vi.fn(),
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
      state.preferences = {
        ...state.preferences!,
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
  markShareTokenRegistered: (...args: unknown[]) => mocks.markShareTokenRegistered(...args),
}));
vi.mock("@vex-agent/agentscan/register-share-token.js", () => ({
  registerPersistedShareToken: (...args: unknown[]) => mocks.registerPersistedShareToken(...args),
}));
vi.mock("@vex-agent/sync/agentscan-report/production-deps.js", () => ({
  resolveAgentscanBaseUrl: (...args: unknown[]) => mocks.resolveAgentscanBaseUrl(...args),
}));
vi.mock("@config/store.js", () => ({
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
}));

const { registerSettingsHandlers } = await import("../settings.js");
const { CH } = await import("@shared/ipc/channels.js");

const sender = createTrustedSender({ sender: createTestWebContents() });
const SHARE = "vex_share_" + "A".repeat(43);
const INGEST = "I".repeat(43);

type CallResult = {
  readonly ok: boolean;
  readonly data?: SuperboardKeyStatus;
  readonly error?: { readonly code: string };
};

async function call(channel: string, payload: unknown): Promise<CallResult> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Handler not registered: ${channel}`);
  return (await handler(sender, {
    requestId: "00000000-0000-4000-8000-000000000333",
    payload,
  })) as CallResult;
}

function reportingState(overrides: Record<string, unknown> = {}) {
  return {
    agentHash: "a".repeat(64),
    ingestToken: INGEST,
    shareToken: null,
    shareTokenRegisteredAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  state.preferences = structuredClone(defaultPreferences);
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.whenEngineDbReady.mockResolvedValue(undefined);
  mocks.resolveAgentscanBaseUrl.mockReturnValue("http://localhost");
  mocks.loadConfig.mockReturnValue({ services: { agentscanApiUrl: "http://localhost" } });
  mocks.registerPersistedShareToken.mockResolvedValue({ kind: "registered" });
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
  });

  it("returns registered shareToken and never includes ingestToken", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
    );
    const result = await call(CH.settings.getSuperboardKey, {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ kind: "registered", shareToken: SHARE });
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
    expect(result.data).toEqual({ kind: "registered", shareToken: SHARE });
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "ensure" }),
    );
  });
});

describe("settings.generateSuperboardKey", () => {
  it("registers with mode ensure", async () => {
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: SHARE, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
    );
    const result = await call(CH.settings.generateSuperboardKey, {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ kind: "registered", shareToken: SHARE });
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "ensure" }),
    );
    expect(JSON.stringify(result)).not.toContain("ingestToken");
  });
});

describe("settings.regenerateSuperboardKey", () => {
  it("registers with mode rotate", async () => {
    const rotated = "vex_share_" + "B".repeat(43);
    mocks.getReportingState.mockResolvedValue(
      reportingState({ shareToken: rotated, shareTokenRegisteredAt: "2026-09-07T00:00:00.000Z" }),
    );
    const result = await call(CH.settings.regenerateSuperboardKey, {});
    expect(result.data).toEqual({ kind: "registered", shareToken: rotated });
    expect(mocks.registerPersistedShareToken).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "rotate" }),
    );
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
