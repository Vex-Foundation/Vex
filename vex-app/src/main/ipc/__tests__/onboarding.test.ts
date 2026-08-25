/**
 * Tests for vex.onboarding.* IPC handlers (M2 + M7).
 *
 * Covers:
 *   - getEnvState delegates to gatherEnvState and returns its result
 *   - getWizardState returns the persisted state from the store
 *   - setWizardState validates the input via the schema (rejects
 *     backward transitions BEFORE the handler runs) and persists
 *     valid input via the store
 *   - keystoreSet maps writer ok({kind:"set"|"unchanged"}) and writer
 *     err({code:"onboarding.env_persist_failed"}) through the IPC
 *     envelope unchanged
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (
  event: TestIpcEvent,
  raw: unknown
) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const mockGatherEnvState = vi.fn();
const mockSetKeystorePassword = vi.fn();
const mockStoreLoad = vi.fn();
const mockStoreUpdate = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../../onboarding/env-state.js", () => ({
  gatherEnvState: () => mockGatherEnvState(),
}));

vi.mock("../../onboarding/keystore-writer.js", () => ({
  setKeystorePassword: (pwd: string) => mockSetKeystorePassword(pwd),
}));

vi.mock("../../onboarding/wizard-state-store.js", () => ({
  wizardStateStore: {
    load: () => mockStoreLoad(),
    update: (input: unknown) => mockStoreUpdate(input),
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { registerOnboardingHandlers } = await import("../onboarding.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender();

beforeEach(() => {
  handlers.clear();
  mockGatherEnvState.mockReset();
  mockSetKeystorePassword.mockReset();
  mockStoreLoad.mockReset();
  mockStoreUpdate.mockReset();
});

afterEach(() => {
  handlers.clear();
});

describe("vex.onboarding.getEnvState handler", () => {
  it("returns ok wrapping the env-state probe result", async () => {
    mockGatherEnvState.mockResolvedValue({
      hasKeystorePassword: true,
      hasJupiterApiKey: false,
      apiKeys: {
        jupiterConfigured: false,
        tavilyConfigured: false,
        rettiwtConfigured: false,
        relayConfigured: false,
        indexifyConfigured: false,
      },
      secrets: {
        vaultConfigured: true,
        unlocked: true,
      },
      embeddings: {
        configured: false,
        reachable: false,
        baseUrlRedacted: null,
        allFieldsConfigured: false,
        dbReachable: null,
      },
      walletStatus: { evm: "missing", solana: "missing" },
      provider: {
        configured: false,
        name: null,
        modelLabel: null,
        endpointTag: null,
      },
      setupCompleteFlag: false,
    });
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.getEnvState)!;
    const result = (await fn(trustedSender, {
      requestId: "req-env",
      payload: {},
    })) as { ok: boolean; data?: { hasKeystorePassword: boolean } };
    expect(result.ok).toBe(true);
    expect(result.data?.hasKeystorePassword).toBe(true);
  });
});

describe("vex.onboarding.getWizardState handler", () => {
  it("returns the persisted state from the store", async () => {
    mockStoreLoad.mockResolvedValue({
      schemaVersion: 2,
      currentStepId: "wallets",
      completedSteps: ["keystore"],
      completed: false,
    });
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.getWizardState)!;
    const result = (await fn(trustedSender, {
      requestId: "req-ws",
      payload: {},
    })) as { ok: boolean; data?: { currentStepId: string } };
    expect(result.ok).toBe(true);
    expect(result.data?.currentStepId).toBe("wallets");
  });
});

describe("vex.onboarding.setWizardState handler", () => {
  it("persists a valid forward transition", async () => {
    mockStoreUpdate.mockResolvedValue({
      schemaVersion: 2,
      currentStepId: "wallets",
      completedSteps: ["keystore"],
      completed: false,
    });
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.setWizardState)!;
    const result = (await fn(trustedSender, {
      requestId: "req-1",
      payload: { currentStepId: "wallets", completedSteps: ["keystore"] },
    })) as { ok: boolean; data?: { currentStepId: string } };

    expect(result.ok).toBe(true);
    expect(result.data?.currentStepId).toBe("wallets");
    expect(mockStoreUpdate).toHaveBeenCalledOnce();
  });

  it("rejects a backward transition at the input schema (Zod refine)", async () => {
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.setWizardState)!;
    const result = (await fn(trustedSender, {
      requestId: "req-bad",
      payload: { currentStepId: "keystore", completedSteps: ["wallets"] },
    })) as { ok: boolean; error?: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mockStoreUpdate).not.toHaveBeenCalled();
  });

  it("rejects unknown step id at the input schema", async () => {
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.setWizardState)!;
    const result = (await fn(trustedSender, {
      requestId: "req-unknown",
      payload: { currentStepId: "zzz", completedSteps: [] },
    })) as { ok: boolean; error?: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  it("maps wizardStateStore.update() throw to onboarding.step_failed", async () => {
    mockStoreUpdate.mockRejectedValue(new Error("EACCES: writeFile failed"));
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.setWizardState)!;
    const result = (await fn(trustedSender, {
      requestId: "req-fail",
      payload: { currentStepId: "wallets", completedSteps: ["keystore"] },
    })) as { ok: boolean; error?: { code: string; retryable: boolean; userActionable: boolean } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("onboarding.step_failed");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.userActionable).toBe(true);
  });
});

describe("vex.onboarding.keystoreSet handler", () => {
  it("maps writer ok({kind:'set'}) through the IPC envelope", async () => {
    mockSetKeystorePassword.mockResolvedValue({
      ok: true,
      data: { kind: "set" },
    });
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.keystoreSet)!;
    const result = (await fn(trustedSender, {
      requestId: "req-ks-1",
      payload: { password: "1234567890" },
    })) as { ok: boolean; data?: { kind: string } };

    expect(result.ok).toBe(true);
    expect(result.data?.kind).toBe("set");
    expect(mockSetKeystorePassword).toHaveBeenCalledWith("1234567890");
  });

  it("maps writer ok({kind:'unchanged'}) through the IPC envelope", async () => {
    mockSetKeystorePassword.mockResolvedValue({
      ok: true,
      data: { kind: "unchanged" },
    });
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.keystoreSet)!;
    const result = (await fn(trustedSender, {
      requestId: "req-ks-2",
      payload: { password: "samepassword" },
    })) as { ok: boolean; data?: { kind: string } };

    expect(result.ok).toBe(true);
    expect(result.data?.kind).toBe("unchanged");
  });

  it("propagates writer err{code:'onboarding.env_persist_failed'}", async () => {
    mockSetKeystorePassword.mockResolvedValue({
      ok: false,
      error: {
        code: "onboarding.env_persist_failed",
        domain: "onboarding",
        message: "Could not persist password.",
        retryable: true,
        userActionable: true,
        redacted: true,
      },
    });
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.keystoreSet)!;
    const result = (await fn(trustedSender, {
      requestId: "req-ks-3",
      payload: { password: "1234567890" },
    })) as { ok: boolean; error?: { code: string; retryable: boolean } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("onboarding.env_persist_failed");
    expect(result.error?.retryable).toBe(true);
  });

  it("rejects passwords shorter than 10 chars (PASSWORD_CREATE_MIN) at the input schema", async () => {
    registerOnboardingHandlers();

    const fn = handlers.get(CH.onboarding.keystoreSet)!;
    const result = (await fn(trustedSender, {
      requestId: "req-ks-short",
      payload: { password: "123456789" },
    })) as { ok: boolean; error?: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mockSetKeystorePassword).not.toHaveBeenCalled();
  });
});
