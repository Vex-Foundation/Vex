import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProviderModelCatalogForTests,
  loadProviderModelCatalog,
} from "../provider-model-catalog.js";

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    contextLength: 200_000,
    supportedParameters: ["tools", "tool_choice"],
    pricing: { prompt: "0.000003", completion: "0.000015" },
    ...overrides,
  };
}

function clientFactory(data: ReadonlyArray<ReturnType<typeof model>>) {
  const list = vi.fn().mockResolvedValue({ data });
  return {
    list,
    factory: () => ({ models: { list } }) as never,
  };
}

beforeEach(() => __resetProviderModelCatalogForTests());

describe("provider model catalogue", () => {
  it("projects tool-capable models, prices, provider, and context", async () => {
    const client = clientFactory([
      model(),
      model({
        id: "legacy/text-only",
        name: "Legacy text only",
        supportedParameters: ["temperature"],
      }),
    ]);

    const result = await loadProviderModelCatalog({
      clientFactory: client.factory,
      now: () => Date.parse("2026-07-11T12:00:00.000Z"),
    });

    expect(client.list).toHaveBeenCalledWith(
      { outputModalities: "text", supportedParameters: "tools" },
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
    expect(result.models).toEqual([
      {
        modelId: "anthropic/claude-sonnet-4.5",
        displayName: "Anthropic: Claude Sonnet 4.5",
        providerId: "anthropic",
        contextLength: 200_000,
        pricingInputPerMillion: 3,
        pricingOutputPerMillion: 15,
      },
    ]);
    expect(result.fetchedAt).toBe("2026-07-11T12:00:00.000Z");
  });

  it("reuses a fresh cache and serves last-good data on refresh failure", async () => {
    let now = 1_000;
    const first = clientFactory([model()]);
    const initial = await loadProviderModelCatalog({
      clientFactory: first.factory,
      now: () => now,
    });

    const ignored = clientFactory([model({ id: "openai/ignored" })]);
    const cached = await loadProviderModelCatalog({
      clientFactory: ignored.factory,
      now: () => now + 500,
    });
    expect(cached).toBe(initial);
    expect(ignored.list).not.toHaveBeenCalled();

    now += 3_600_001;
    const failingList = vi.fn().mockRejectedValue(new Error("offline"));
    const stale = await loadProviderModelCatalog({
      clientFactory: () => ({ models: { list: failingList } }) as never,
      now: () => now,
    });
    expect(stale).toBe(initial);
  });
});
