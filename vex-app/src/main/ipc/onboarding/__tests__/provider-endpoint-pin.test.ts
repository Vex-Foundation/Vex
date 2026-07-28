/**
 * Server-side authorisation of the renderer-supplied endpoint pin, plus the
 * read-only `providerListEndpoints` channel.
 *
 * The renderer is untrusted: a tag it sends is written only after main proves
 * the tag is one of the tool-capable endpoints IT projected for that model.
 * An unverified tag is rejected BY NAME — a silent drop would report "saved"
 * while requests kept routing somewhere else.
 *
 * New file: `provider.test.ts` owns the verify-then-persist contract and is
 * already sizeable.
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
const mockLoadEndpoints = vi.fn();

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
  loadProviderEndpointCatalog: (modelId: string) => mockLoadEndpoints(modelId),
}));
vi.mock("../../../onboarding/env-write-mutex.js", () => ({
  withEnvWriteLock: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@vex-lib/runtime-env.js", () => ({ loadProviderDotenv: vi.fn() }));
vi.mock("@vex-agent/inference/registry.js", () => ({ resetProvider: vi.fn() }));

const { registerProviderHandler } = await import("../provider.js");
const { registerProviderEndpointsHandler } = await import(
  "../provider-endpoints.js"
);
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

const PAYLOAD = {
  provider: "openrouter" as const,
  apiKey: "sk-or-secret-VALUE-XYZ",
  model: "anthropic/claude-sonnet-4.5",
};

beforeEach(() => {
  handlers.clear();
  mockVerify.mockReset();
  mockWriter.mockReset();
  mockIsKnownEndpoint.mockReset();
  mockLoadEndpoints.mockReset();
  mockVerify.mockResolvedValue({ ok: true, data: { latencyMs: 12 } });
  mockWriter.mockResolvedValue({
    ok: true,
    data: {
      fieldsWritten: ["OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_PROVIDER"],
    },
  });
});

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

async function persist(payload: unknown): Promise<{
  ok: boolean;
  error?: { code: string; domain: string; message: string };
}> {
  registerProviderHandler();
  const fn = handlers.get(CH.onboarding.providerPersist)!;
  return (await fn(trustedSender, {
    requestId: "req-1",
    payload,
  })) as { ok: boolean; error?: { code: string; domain: string; message: string } };
}

describe("endpoint pin authorisation on providerPersist", () => {
  it("persists a tag main confirms is tool-capable for the selected model", async () => {
    mockIsKnownEndpoint.mockResolvedValue(true);
    const result = await persist({ ...PAYLOAD, endpointTag: "anthropic/2" });

    expect(result.ok).toBe(true);
    expect(mockIsKnownEndpoint).toHaveBeenCalledWith(
      "anthropic/claude-sonnet-4.5",
      "anthropic/2",
    );
    expect(mockWriter).toHaveBeenCalledWith(
      expect.objectContaining({ endpointTag: "anthropic/2" }),
    );
  });

  it("rejects an unknown tag BY NAME and writes nothing", async () => {
    mockIsKnownEndpoint.mockResolvedValue(false);
    const result = await persist({ ...PAYLOAD, endpointTag: "attacker-choice" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.endpoint_unavailable");
    expect(result.error?.domain).toBe("onboarding");
    expect(result.error?.message).toContain("attacker-choice");
    expect(mockWriter).not.toHaveBeenCalled();
  });

  it("does not consult the endpoint catalogue at all on Auto", async () => {
    const result = await persist(PAYLOAD);
    expect(result.ok).toBe(true);
    expect(mockIsKnownEndpoint).not.toHaveBeenCalled();
  });

  it("rejects a malformed tag at the schema boundary before any catalogue read", async () => {
    const result = await persist({ ...PAYLOAD, endpointTag: "bad tag" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mockIsKnownEndpoint).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe("providerListEndpoints handler", () => {
  async function list(payload: unknown): Promise<{
    ok: boolean;
    data?: { endpoints: ReadonlyArray<{ tag: string }> };
    error?: { code: string };
  }> {
    registerProviderEndpointsHandler();
    const fn = handlers.get(CH.onboarding.providerListEndpoints)!;
    return (await fn(trustedSender, { requestId: "req-2", payload })) as never;
  }

  it("returns the projected endpoints for a valid model id", async () => {
    mockLoadEndpoints.mockResolvedValue({
      modelId: "anthropic/claude-sonnet-4.5",
      endpoints: [
        {
          tag: "anthropic",
          providerName: "Anthropic",
          contextLength: 1_000_000,
          quantization: null,
          pricingInputPerMillion: 3,
          pricingOutputPerMillion: 15,
          pricingCacheReadPerMillion: 0.3,
          pricingCacheWritePerMillion: 3.75,
        },
      ],
    });
    const result = await list({ modelId: "anthropic/claude-sonnet-4.5" });
    expect(result.ok).toBe(true);
    expect(result.data?.endpoints.map((e) => e.tag)).toEqual(["anthropic"]);
  });

  it("rejects a malformed model id without touching the catalogue", async () => {
    const result = await list({ modelId: "../../etc/passwd" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mockLoadEndpoints).not.toHaveBeenCalled();
  });

  it("maps a catalogue failure to a redacted provider.unavailable", async () => {
    mockLoadEndpoints.mockRejectedValue(new Error("sk-or-leak-me"));
    const result = await list({ modelId: "anthropic/claude-sonnet-4.5" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.unavailable");
    expect(JSON.stringify(result)).not.toContain("sk-or-leak-me");
  });
});
