/**
 * Delta-save on `providerPersist`: change the model (and/or the endpoint pin)
 * WITHOUT re-entering the API key.
 *
 * The contract under test is a security contract, not a convenience one:
 *
 *   - the stored key is loaded MAIN-SIDE from the encrypted vault and the
 *     verify-then-persist invariant is preserved — a keep-key save is verified
 *     with the SAME 16-token completion as a first-run save, never skipped;
 *   - the vault entry is NOT rewritten when the key did not change;
 *   - no stored key AND no supplied key ⇒ rejected BY NAME, nothing written;
 *   - the endpoint-pin authorisation path runs identically on a delta save;
 *   - nothing about the key (value, length, prefix) appears in the response
 *     or in any log line.
 *
 * New file: `provider.test.ts` owns the first-run verify-then-persist contract
 * and `provider-endpoint-pin.test.ts` owns pin authorisation; both are already
 * sizeable and this is a distinct reason to change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "../../__tests__/test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const mockVerify = vi.fn();
const mockWriter = vi.fn();
const mockIsKnownEndpoint = vi.fn();
const mockReadUnlockedSecret = vi.fn();
const mockLogInfo = vi.fn();

const STORED_KEY = "sk-or-STORED-vault-key-000";
const REPLACEMENT_KEY = "sk-or-REPLACEMENT-key-111";

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
vi.mock("../../../onboarding/provider-endpoint-catalog.js", () => ({
  isKnownToolCapableEndpoint: (modelId: string, tag: string) =>
    mockIsKnownEndpoint(modelId, tag),
}));
vi.mock("../../../secrets/session.js", () => ({
  readUnlockedSecret: (key: string) => mockReadUnlockedSecret(key),
}));
vi.mock("../../../onboarding/env-write-mutex.js", () => ({
  withEnvWriteLock: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("../../../logger/index.js", () => ({
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@vex-lib/runtime-env.js", () => ({ loadProviderDotenv: vi.fn() }));
vi.mock("@vex-agent/inference/registry.js", () => ({ resetProvider: vi.fn() }));

const { registerProviderHandler } = await import("../provider.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

/** A complete `VexError` — `registerHandler` validates the error envelope. */
function vexError(code: string, domain: string): Record<string, unknown> {
  return {
    code,
    domain,
    message: "Fixed test copy.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId: "req-keep",
  };
}

interface PersistResponse {
  readonly ok: boolean;
  readonly data?: { readonly fieldsWritten: ReadonlyArray<string> };
  readonly error?: { readonly code: string; readonly message: string };
}

async function persist(payload: unknown): Promise<PersistResponse> {
  registerProviderHandler();
  const fn = handlers.get(CH.onboarding.providerPersist)!;
  return (await fn(trustedSender, {
    requestId: "req-keep",
    payload,
  })) as PersistResponse;
}

beforeEach(() => {
  handlers.clear();
  mockVerify.mockReset();
  mockWriter.mockReset();
  mockIsKnownEndpoint.mockReset();
  mockReadUnlockedSecret.mockReset();
  mockLogInfo.mockReset();
  mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 21 } });
  mockWriter.mockResolvedValue({
    ok: true,
    data: { fieldsWritten: ["AGENT_MODEL", "AGENT_PROVIDER"] },
  });
  mockReadUnlockedSecret.mockReturnValue({ ok: true, data: STORED_KEY });
});

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe("providerPersist keep-existing-key delta save", () => {
  it("verifies the new model against the STORED key when apiKey is omitted", async () => {
    const result = await persist({
      provider: "openrouter",
      model: "openai/gpt-5.2",
    });

    expect(result.ok).toBe(true);
    expect(mockReadUnlockedSecret).toHaveBeenCalledWith("OPENROUTER_API_KEY");
    expect(mockVerify).toHaveBeenCalledWith(
      { apiKey: STORED_KEY, model: "openai/gpt-5.2" },
      expect.anything(),
    );
  });

  it("does not rewrite the vault entry: the writer gets NO apiKey to store", async () => {
    await persist({ provider: "openrouter", model: "openai/gpt-5.2" });

    expect(mockWriter).toHaveBeenCalledTimes(1);
    const written = mockWriter.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty("apiKey");
    expect(written.model).toBe("openai/gpt-5.2");
  });

  it("still verifies before persisting — a verify failure writes nothing", async () => {
    mockVerify.mockResolvedValue({
      ok: false,
      error: vexError("provider.invalid_api_key", "onboarding"),
    });

    const result = await persist({
      provider: "openrouter",
      model: "openai/gpt-5.2",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.invalid_api_key");
    expect(mockWriter).not.toHaveBeenCalled();
  });

  it("rejects BY NAME when no key is stored and none was supplied", async () => {
    mockReadUnlockedSecret.mockReturnValue({ ok: true, data: null });

    const result = await persist({
      provider: "openrouter",
      model: "openai/gpt-5.2",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.api_key_required");
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockWriter).not.toHaveBeenCalled();
  });

  it("surfaces a locked vault instead of silently falling back", async () => {
    mockReadUnlockedSecret.mockReturnValue({
      ok: false,
      error: vexError("wallet.keystore_locked", "wallet"),
    });

    const result = await persist({
      provider: "openrouter",
      model: "openai/gpt-5.2",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("wallet.keystore_locked");
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockWriter).not.toHaveBeenCalled();
  });

  it("runs the SAME endpoint-pin authorisation on a keep-key delta save", async () => {
    mockIsKnownEndpoint.mockResolvedValue(true);
    const ok = await persist({
      provider: "openrouter",
      model: "openai/gpt-5.2",
      endpointTag: "azure",
    });
    expect(ok.ok).toBe(true);
    expect(mockIsKnownEndpoint).toHaveBeenCalledWith("openai/gpt-5.2", "azure");

    mockIsKnownEndpoint.mockResolvedValue(false);
    const rejected = await persist({
      provider: "openrouter",
      model: "openai/gpt-5.2",
      endpointTag: "attacker-choice",
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("provider.endpoint_unavailable");
    expect(mockWriter).toHaveBeenCalledTimes(1);
  });

  it("never leaks the stored key into the response or the logs", async () => {
    await persist({ provider: "openrouter", model: "openai/gpt-5.2" });
    mockReadUnlockedSecret.mockReturnValue({ ok: true, data: null });
    const rejected = await persist({
      provider: "openrouter",
      model: "openai/gpt-5.2",
    });

    const logged = mockLogInfo.mock.calls.flat().join(" ");
    expect(logged).not.toContain(STORED_KEY);
    expect(logged).not.toContain(String(STORED_KEY.length));
    expect(JSON.stringify(rejected)).not.toContain(STORED_KEY);
  });
});

describe("providerPersist rotation path (apiKey supplied)", () => {
  it("verifies and stores the SUPPLIED key, never reading the vault", async () => {
    const result = await persist({
      provider: "openrouter",
      apiKey: REPLACEMENT_KEY,
      model: "openai/gpt-5.2",
    });

    expect(result.ok).toBe(true);
    expect(mockReadUnlockedSecret).not.toHaveBeenCalled();
    expect(mockVerify).toHaveBeenCalledWith(
      { apiKey: REPLACEMENT_KEY, model: "openai/gpt-5.2" },
      expect.anything(),
    );
    expect(mockWriter).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: REPLACEMENT_KEY }),
    );
  });

  it("treats a whitespace-only apiKey as invalid input, not as 'keep'", async () => {
    const result = await persist({
      provider: "openrouter",
      apiKey: "   ",
      model: "openai/gpt-5.2",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mockReadUnlockedSecret).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
