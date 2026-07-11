import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "../../__tests__/test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const mockLoad = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
}));

vi.mock("../../../onboarding/provider-model-catalog.js", () => ({
  loadProviderModelCatalog: (options: unknown) => mockLoad(options),
}));

vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerProviderModelsHandler } = await import("../provider-models.js");

const sender = createTrustedSender({ sender: createTestWebContents() });

beforeEach(() => {
  handlers.clear();
  mockLoad.mockReset();
});

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe("providerListModels handler", () => {
  it("returns the sanitized catalogue through the reserved channel", async () => {
    mockLoad.mockResolvedValue({
      models: [
        {
          modelId: "openrouter/auto",
          displayName: "OpenRouter Auto",
          providerId: "openrouter",
          contextLength: 2_000_000,
          pricingInputPerMillion: null,
          pricingOutputPerMillion: null,
        },
      ],
      fetchedAt: "2026-07-11T12:00:00.000Z",
    });
    registerProviderModelsHandler();

    const result = (await handlers.get(CH.onboarding.providerListModels)!(sender, {
      requestId: "req-models",
      payload: {},
    })) as { ok: boolean; data?: { models: unknown[] } };

    expect(result.ok).toBe(true);
    expect(result.data?.models).toHaveLength(1);
    expect(mockLoad).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it("maps catalogue failures to a redacted retryable error", async () => {
    mockLoad.mockRejectedValue(new Error("raw upstream body"));
    registerProviderModelsHandler();

    const result = (await handlers.get(CH.onboarding.providerListModels)!(sender, {
      requestId: "req-fail",
      payload: {},
    })) as { ok: boolean; error?: { code: string; message: string } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.unavailable");
    expect(result.error?.message).not.toContain("raw upstream body");
  });
});
