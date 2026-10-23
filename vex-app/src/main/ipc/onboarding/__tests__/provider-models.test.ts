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
afterEach(() => vi.clearAllMocks());

describe("providerListModels handler", () => {
  it("returns the projected catalogue", async () => {
    mockLoad.mockResolvedValue({ models: [] });
    registerProviderModelsHandler();
    const result = await handlers.get(CH.onboarding.providerListModels)?.(sender, {
      requestId: "req-models",
      payload: {},
    });
    expect(result).toMatchObject({ ok: true, data: { models: [] } });
    expect(mockLoad).toHaveBeenCalledWith({ source: "openrouter", signal: expect.any(AbortSignal) });
  });

  it("maps failures to a redacted retryable error", async () => {
    mockLoad.mockRejectedValue(new Error("raw upstream body"));
    registerProviderModelsHandler();
    const result = await handlers.get(CH.onboarding.providerListModels)?.(sender, {
      requestId: "req-failure",
      payload: {},
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider.unavailable", retryable: true, redacted: true },
    });
    expect(JSON.stringify(result)).not.toContain("raw upstream body");
  });
});
