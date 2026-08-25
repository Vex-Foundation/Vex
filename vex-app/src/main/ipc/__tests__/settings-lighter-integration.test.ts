import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences, type Preferences } from "@shared/schemas/preferences.js";
import type { LighterIntegrationState } from "@shared/schemas/lighter-integration.js";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const state = vi.hoisted(() => ({ preferences: null as Preferences | null }));
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  getPrimaryEvmAddress: vi.fn(),
  getLighterIntegrationSetting: vi.fn(),
  setLighterIntegrationEnabled: vi.fn(),
  inspectLighterCredentialConnections: vi.fn(),
  forgetLighterCredentialConnection: vi.fn(),
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
      state.preferences = { ...state.preferences!, ...patch };
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
vi.mock("../runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: (...args: unknown[]) => mocks.ensureEngineDbUrl(...args),
}));
vi.mock("@vex-lib/wallet.js", () => ({
  getPrimaryEvmAddress: () => mocks.getPrimaryEvmAddress(),
}));
vi.mock("@vex-agent/db/repos/lighter-integration-settings.js", () => ({
  getLighterIntegrationSetting: (...args: unknown[]) =>
    mocks.getLighterIntegrationSetting(...args),
  setLighterIntegrationEnabled: (...args: unknown[]) =>
    mocks.setLighterIntegrationEnabled(...args),
}));
vi.mock("../../lighter/credential-connection-cleanup.js", () => {
  class LighterCredentialCleanupError extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  }
  return {
    LighterCredentialCleanupError,
    inspectLighterCredentialConnections: (...args: unknown[]) =>
      mocks.inspectLighterCredentialConnections(...args),
    forgetLighterCredentialConnection: (...args: unknown[]) =>
      mocks.forgetLighterCredentialConnection(...args),
  };
});

const { registerSettingsHandlers } = await import("../settings.js");
const { CH } = await import("@shared/ipc/channels.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const sender = createTrustedSender({ sender: createTestWebContents() });

type CallResult = {
  readonly ok: boolean;
  readonly data?: LighterIntegrationState;
  readonly error?: { readonly code: string; readonly message: string };
};

async function call(channel: string, payload: unknown): Promise<CallResult> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Handler not registered: ${channel}`);
  return (await handler(sender, {
    requestId: "00000000-0000-4000-8000-000000000223",
    payload,
  })) as CallResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  state.preferences = structuredClone(defaultPreferences);
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.getPrimaryEvmAddress.mockReturnValue(WALLET);
  mocks.getLighterIntegrationSetting.mockResolvedValue(null);
  mocks.inspectLighterCredentialConnections.mockResolvedValue({ connections: [] });
  registerSettingsHandlers();
});

describe("settings Lighter credential cleanup", () => {
  const STRAY = "0x2222222222222222222222222222222222222222";
  const scopes = [
    { environment: "core", accountIndex: 736778, apiKeyIndex: 7, managed: true },
    { environment: "rhc", accountIndex: 1171, apiKeyIndex: 7, managed: true },
  ] as const;

  it("exposes only the sanitized live ownership review", async () => {
    mocks.inspectLighterCredentialConnections.mockResolvedValueOnce({
      connections: [{ walletAddress: STRAY, protected: false, scopes }],
    });

    const result = await call(CH.settings.inspectLighterCredentialConnections, {});

    expect(result).toEqual({
      ok: true,
      data: { connections: [{ walletAddress: STRAY, protected: false, scopes }] },
    });
  });

  it("binds the destructive request to the exact reviewed wallet and scopes", async () => {
    mocks.forgetLighterCredentialConnection.mockResolvedValueOnce({
      walletAddress: STRAY,
      removedScopes: scopes,
    });

    const result = await call(CH.settings.forgetLighterCredentialConnection, {
      walletAddress: STRAY,
      scopes,
    });

    expect(result).toEqual({
      ok: true,
      data: { walletAddress: STRAY, removedScopes: scopes },
    });
    expect(mocks.forgetLighterCredentialConnection).toHaveBeenCalledWith({
      walletAddress: STRAY,
      scopes,
    });
  });

  it("rejects an unreviewed empty scope set at the IPC boundary", async () => {
    const result = await call(CH.settings.forgetLighterCredentialConnection, {
      walletAddress: STRAY,
      scopes: [],
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.forgetLighterCredentialConnection).not.toHaveBeenCalled();
  });
});

describe("settings.getLighterIntegration", () => {
  it("returns a disabled public state when the wallet has no setting yet", async () => {
    const result = await call(CH.settings.getLighterIntegration, { environment: "core" });

    expect(result).toEqual({
      ok: true,
      data: {
        environment: "core",
        walletAddress: WALLET,
        enabled: false,
        enabledAt: null,
        disabledAt: null,
        createdAt: null,
        updatedAt: null,
      },
    });
    expect(mocks.getLighterIntegrationSetting).toHaveBeenCalledWith("core", WALLET);
  });

  it("fails closed when no primary EVM wallet exists", async () => {
    mocks.getPrimaryEvmAddress.mockReturnValueOnce(null);

    const result = await call(CH.settings.getLighterIntegration, { environment: "core" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("wallet.keystore_missing");
    expect(result.error?.message).toContain("Add an EVM wallet");
    expect(mocks.getLighterIntegrationSetting).not.toHaveBeenCalled();
  });
});

describe("settings.setLighterIntegration", () => {
  it("binds activation to the main-process primary wallet", async () => {
    const now = new Date("2026-08-17T10:00:00.000Z");
    mocks.setLighterIntegrationEnabled.mockResolvedValueOnce({
      environment: "core",
      walletAddress: WALLET,
      enabled: true,
      enabledAt: now,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await call(CH.settings.setLighterIntegration, {
      environment: "core",
      enabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.enabledAt).toBe(now.toISOString());
    expect(mocks.setLighterIntegrationEnabled).toHaveBeenCalledWith({
      environment: "core",
      walletAddress: WALLET,
      enabled: true,
    });
  });

  it("rejects a renderer-supplied wallet address before persistence", async () => {
    const result = await call(CH.settings.setLighterIntegration, {
      environment: "core",
      enabled: true,
      walletAddress: "0x2222222222222222222222222222222222222222",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.setLighterIntegrationEnabled).not.toHaveBeenCalled();
  });
});
