/**
 * vex.onboarding.providerPersist IPC handler tests (M10).
 *
 * Verifies the verify-then-persist flow:
 *   - Trusted sender check + Zod input parse + Result envelope.
 *   - Verify failure → no writer call (assert .env unchanged via spy).
 *   - Verify ok → writer called inside withEnvWriteLock; latencyMs
 *     threaded into Result.
 *   - Verify ok + persist fail → onboarding.env_persist_failed with
 *     details.verified=true.
 *   - Logging contract:
 *       success: provider=openrouter modelSet=true latencyMs=N correlationId=X
 *       failure: errCode=X correlationId=Y
 *     NEVER apiKey or model value in logs.
 *   - Error `domain === "onboarding"` consistently (codex turn 4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMainFrame,
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "../../__tests__/test-sender.js";

type Handler = (
  event: TestIpcEvent,
  raw: unknown,
) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const logInfo = vi.fn();
const mockVerify = vi.fn();
const mockWriter = vi.fn();
const mockLoadProviderDotenv = vi.fn();
const mockResetProvider = vi.fn();

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

vi.mock("../../../onboarding/openrouter-test-client.js", () => ({
  verifyOpenRouterConnection: (input: unknown, opts: unknown) =>
    mockVerify(input, opts),
}));

vi.mock("../../../onboarding/provider-writer.js", () => ({
  writeProvider: (input: unknown) => mockWriter(input),
}));

vi.mock("../../../onboarding/env-write-mutex.js", () => ({
  withEnvWriteLock: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock("../../../logger/index.js", () => ({
  log: { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// F1: handler reloads non-secret .env (overwrite) + resets the engine provider
// cache after a successful persist so the new model goes live same-session.
vi.mock("@vex-lib/runtime-env.js", () => ({
  loadProviderDotenv: (opts: unknown) => mockLoadProviderDotenv(opts),
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resetProvider: () => mockResetProvider(),
}));

const { registerProviderHandler } = await import("../provider.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

const VALID_PAYLOAD = {
  provider: "openrouter" as const,
  apiKey: "sk-or-secret-VALUE-XYZ",
  model: "anthropic/claude-sonnet-4.5",
};

beforeEach(() => {
  handlers.clear();
  mockVerify.mockReset();
  mockWriter.mockReset();
  mockLoadProviderDotenv.mockReset();
  mockResetProvider.mockReset();
  logInfo.mockReset();
});

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe("providerPersist handler", () => {
  it("verifies first, then writes; latencyMs threaded into Result", async () => {
    mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 234 } });
    mockWriter.mockResolvedValue({
      ok: true,
      data: {
        fieldsWritten: ["OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_PROVIDER"],
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(trustedSender, {
      requestId: "req-good",
      payload: VALID_PAYLOAD,
    })) as {
      ok: boolean;
      data?: {
        fieldsWritten: string[];
        verifiedLatencyMs: number;
      };
    };
    expect(result.ok).toBe(true);
    expect(result.data?.verifiedLatencyMs).toBe(234);
    expect(result.data?.fieldsWritten).toEqual([
      "OPENROUTER_API_KEY",
      "AGENT_MODEL",
      "AGENT_PROVIDER",
    ]);
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockWriter).toHaveBeenCalledTimes(1);
  });

  it("verifies BOTH providers before persisting when a fallback is configured", async () => {
    mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 120 } });
    mockWriter.mockResolvedValue({
      ok: true,
      data: {
        fieldsWritten: [
          "OPENROUTER_API_KEY",
          "AGENT_MODEL",
          "AGENT_PROVIDER",
          "OPENROUTER_API_KEY_FALLBACK",
          "AGENT_MODEL_FALLBACK",
        ],
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(trustedSender, {
      requestId: "req-fb",
      payload: {
        ...VALID_PAYLOAD,
        fallbackApiKey: "sk-or-fallback-SECRET",
        fallbackModel: "deepseek/deepseek-chat",
      },
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(mockVerify).toHaveBeenCalledTimes(2);
    // Each provider must be verified with its OWN model — verifying the
    // fallback key against the primary's model is the P1 this guards.
    expect(mockVerify.mock.calls[1]?.[0]).toMatchObject({
      apiKey: "sk-or-fallback-SECRET",
      model: "deepseek/deepseek-chat",
    });
    expect(mockWriter).toHaveBeenCalledTimes(1);
  });

  it("a bad fallback blocks the save entirely — writer NEVER called", async () => {
    mockVerify
      .mockResolvedValueOnce({ ok: true, data: { latencyMs: 90 } })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "provider.invalid_api_key",
          domain: "onboarding",
          message: "API key rejected",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId: "req-fb-bad",
        },
      });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(trustedSender, {
      requestId: "req-fb-bad",
      payload: {
        ...VALID_PAYLOAD,
        fallbackApiKey: "sk-or-bad",
        fallbackModel: "deepseek/deepseek-chat",
      },
    })) as {
      ok: boolean;
      error?: { code: string; details?: { scope?: string } };
    };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.invalid_api_key");
    // scope lets the renderer point the error at the fallback fields.
    expect(result.error?.details?.scope).toBe("fallback");
    // Atomic: a half-good pair persists nothing, not even the good primary.
    expect(mockWriter).not.toHaveBeenCalled();
  });

  it("never logs either API key", async () => {
    mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 120 } });
    mockWriter.mockResolvedValue({ ok: true, data: { fieldsWritten: [] } });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    await fn(trustedSender, {
      requestId: "req-log",
      payload: {
        ...VALID_PAYLOAD,
        fallbackApiKey: "sk-or-fallback-SECRET",
        fallbackModel: "deepseek/deepseek-chat",
      },
    });

    const logged = logInfo.mock.calls.flat().join("\n");
    expect(logged).not.toContain("sk-or-secret-VALUE-XYZ");
    expect(logged).not.toContain("sk-or-fallback-SECRET");
    expect(logged).toContain("fallbackSet=true");
  });

  it("verify failure short-circuits — writer NEVER called", async () => {
    mockVerify.mockResolvedValue({
      ok: false,
      error: {
        code: "provider.invalid_api_key",
        domain: "onboarding",
        message: "API key rejected",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "req-bad",
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(trustedSender, {
      requestId: "req-bad",
      payload: VALID_PAYLOAD,
    })) as { ok: boolean; error?: { code: string; domain: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.invalid_api_key");
    expect(result.error?.domain).toBe("onboarding");
    expect(mockWriter).not.toHaveBeenCalled();
  });

  it("verify ok + persist fail returns env_persist_failed with details.verified=true", async () => {
    mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 100 } });
    mockWriter.mockResolvedValue({
      ok: false,
      error: {
        code: "onboarding.env_persist_failed",
        domain: "onboarding",
        message: "disk full",
        retryable: true,
        userActionable: true,
        redacted: true,
        details: { verified: true, partialFieldsWritten: [] },
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(trustedSender, {
      requestId: "req-disk",
      payload: VALID_PAYLOAD,
    })) as {
      ok: boolean;
      error?: {
        code: string;
        details?: { verified?: boolean };
      };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("onboarding.env_persist_failed");
    expect(result.error?.details?.verified).toBe(true);
  });

  it("logs include provider+modelSet+latencyMs+correlationId on success — NEVER apiKey or model VALUE", async () => {
    mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 99 } });
    mockWriter.mockResolvedValue({
      ok: true,
      data: {
        fieldsWritten: ["OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_PROVIDER"],
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    await fn(trustedSender, {
      requestId: "req-logspy",
      payload: VALID_PAYLOAD,
    });
    const allLogs = logInfo.mock.calls.map((c) => String(c[0]));
    const mergedLog = allLogs.join("\n");
    expect(mergedLog).toContain("providerPersist");
    expect(mergedLog).toContain("provider=openrouter");
    expect(mergedLog).toContain("modelSet=true");
    expect(mergedLog).toContain("latencyMs=99");
    expect(mergedLog).toContain("correlationId=req-logspy");
    // Never the apiKey VALUE.
    expect(mergedLog).not.toContain(VALID_PAYLOAD.apiKey);
    // Never the model VALUE either (defense vs custom OpenRouter routes).
    expect(mergedLog).not.toContain(VALID_PAYLOAD.model);
  });

  it("logs errCode + correlationId on verify failure (no apiKey value)", async () => {
    mockVerify.mockResolvedValue({
      ok: false,
      error: {
        code: "provider.invalid_api_key",
        domain: "onboarding",
        message: "API key rejected",
        retryable: false,
        userActionable: true,
        redacted: true,
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    await fn(trustedSender, {
      requestId: "req-fail",
      payload: VALID_PAYLOAD,
    });
    const merged = logInfo.mock.calls.map((c) => String(c[0])).join("\n");
    expect(merged).toContain("errCode=provider.invalid_api_key");
    expect(merged).toContain("correlationId=req-fail");
    expect(merged).not.toContain(VALID_PAYLOAD.apiKey);
  });

  it("rejects whitespace-only apiKey at the Zod boundary", async () => {
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(trustedSender, {
      requestId: "req-ws",
      payload: { provider: "openrouter", apiKey: "   ", model: "x" },
    })) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockWriter).not.toHaveBeenCalled();
  });

  it("returned VexError.message NEVER contains the SDK raw message (handler pass-through safety)", async () => {
    mockVerify.mockResolvedValue({
      ok: false,
      error: {
        code: "provider.test_failed",
        domain: "onboarding",
        message:
          "Verification failed. Try again, or check the OpenRouter dashboard for service issues.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "req-leak-test",
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(trustedSender, {
      requestId: "req-leak-test",
      payload: VALID_PAYLOAD,
    })) as { ok: boolean; error?: { message: string; correlationId?: string } };
    expect(result.ok).toBe(false);
    // VexError.message is the safe copy from the test client; handler
    // does NOT re-wrap or augment with SDK internals. The test client
    // tests already assert NO `RAW_SDK_LEAK_TEST` sentinel — at the
    // handler level we assert the VexError shape is preserved unchanged.
    expect(result.error?.message).toContain("Verification failed");
    expect(result.error?.message).not.toContain("RAW_SDK_LEAK_TEST");
    expect(result.error?.correlationId).toBe("req-leak-test");
  });

  it("rejects payload from untrusted sender", async () => {
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(
      {
        senderFrame: createMainFrame("https://malicious.example.com"),
        sender: trustedSender.sender,
      },
      { requestId: "req-bad-sender", payload: VALID_PAYLOAD },
    )) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_sender");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("on success reloads .env (overwrite) then resets the inference provider, in order", async () => {
    mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 50 } });
    mockWriter.mockResolvedValue({
      ok: true,
      data: {
        fieldsWritten: ["OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_PROVIDER"],
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    const result = (await fn(trustedSender, {
      requestId: "req-reload",
      payload: VALID_PAYLOAD,
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mockLoadProviderDotenv).toHaveBeenCalledTimes(1);
    expect(mockLoadProviderDotenv).toHaveBeenCalledWith({ overwrite: true });
    expect(mockResetProvider).toHaveBeenCalledTimes(1);
    // reload must run BEFORE reset so resolveProvider() rebuilds with the new model
    expect(mockLoadProviderDotenv.mock.invocationCallOrder[0]).toBeLessThan(
      mockResetProvider.mock.invocationCallOrder[0],
    );
  });

  it("verify failure → neither reload nor provider reset", async () => {
    mockVerify.mockResolvedValue({
      ok: false,
      error: {
        code: "provider.invalid_api_key",
        domain: "onboarding",
        message: "API key rejected",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "req-vf",
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    await fn(trustedSender, { requestId: "req-vf", payload: VALID_PAYLOAD });
    expect(mockLoadProviderDotenv).not.toHaveBeenCalled();
    expect(mockResetProvider).not.toHaveBeenCalled();
  });

  it("persist failure → neither reload nor provider reset", async () => {
    mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 10 } });
    mockWriter.mockResolvedValue({
      ok: false,
      error: {
        code: "onboarding.env_persist_failed",
        domain: "onboarding",
        message: "disk full",
        retryable: true,
        userActionable: true,
        redacted: true,
        details: { verified: true, partialFieldsWritten: [] },
      },
    });
    registerProviderHandler();
    const fn = handlers.get(CH.onboarding.providerPersist)!;
    await fn(trustedSender, { requestId: "req-pf", payload: VALID_PAYLOAD });
    expect(mockLoadProviderDotenv).not.toHaveBeenCalled();
    expect(mockResetProvider).not.toHaveBeenCalled();
  });
});
