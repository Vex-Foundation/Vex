/**
 * The app catalogue and the reasoning-capability resolver over the Vex Cloud
 * `/v1/models`, replayed from a LIVE capture of a local gateway
 * (`src/__tests__/vex-agent/inference/fixtures/vex-cloud/`), through the
 * production client wiring with only `fetch` injected.
 *
 * Pinned:
 *  - `source: "vexcloud"` reads `<origin>/v1/models` keyless, never
 *    openrouter.ai, and keeps a cache apart from the OpenRouter list;
 *  - the capability is `mandatory: true`: no Off (`none`) is selectable, the
 *    per-model default is preselected, a model's own minimum is respected;
 *  - the resolver used by `models.list` and `sessions.getModel` reads the Vex
 *    Cloud catalogue when the engine is in Vex Cloud mode.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectDefaultReasoningEffort } from "@shared/schemas/reasoning.js";

const { __resetProviderModelCatalogForTests, getModelReasoningCapability, loadProviderModelCatalog } = await import(
  "../provider-model-catalog.js"
);

const LIVE = readFileSync(
  new URL("../../../../../src/__tests__/vex-agent/inference/fixtures/vex-cloud/v1-models.live-2026-10-20.json", import.meta.url),
  "utf8",
);

let urls: string[] = [];
let authorizations: Array<string | null> = [];
const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init);
  urls.push(request.url);
  authorizations.push(request.headers.get("authorization"));
  return new Response(LIVE, { status: 200, headers: { "content-type": "application/json" } });
});

beforeEach(() => {
  urls = [];
  authorizations = [];
  fetcher.mockClear();
  __resetProviderModelCatalogForTests();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-must-not-be-sent");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Vex Cloud model list", () => {
  it("lists the gateway's allowlist from /v1/models on the Vex Cloud host, keyless", async () => {
    const catalogue = await loadProviderModelCatalog({ source: "vexcloud", fetcher });

    expect(new URL(urls[0] ?? "").origin).toBe("https://inference.projectvex.ai");
    expect(new URL(urls[0] ?? "").pathname).toBe("/v1/models");
    expect(authorizations).toEqual([null]);
    expect(catalogue.models.map((model) => model.modelId)).toEqual(
      expect.arrayContaining(["anthropic/claude-haiku-5.5", "google/gemini-4-argon", "deepseek/deepseek-v4.1-flash-1017"]),
    );
    expect(catalogue.models).toHaveLength(10);
  });

  it("keeps its cache apart from the OpenRouter list", async () => {
    await loadProviderModelCatalog({ source: "vexcloud", fetcher });
    await loadProviderModelCatalog({ source: "vexcloud", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await loadProviderModelCatalog({ source: "openrouter", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(urls[1] ?? "").origin).toBe("https://openrouter.ai");
  });
});

describe("the reasoning capability is mandatory: no Off", () => {
  it("haiku: every positive level, default medium, never none", async () => {
    const entry = await getModelReasoningCapability("anthropic/claude-haiku-5.5", { source: "vexcloud", fetcher });
    const reasoning = entry?.reasoning;
    expect(reasoning).toEqual({
      supportedEfforts: ["max", "xhigh", "high", "medium", "low"],
      defaultEffort: "medium",
      defaultEnabled: true,
      mandatory: true,
    });
    if (reasoning == null) throw new Error("expected a capability");
    expect(reasoning.supportedEfforts).not.toContain("none");
    expect(selectDefaultReasoningEffort(reasoning)).toBe("medium");
  });

  it("Gemini Argon starts at medium", async () => {
    const entry = await getModelReasoningCapability("google/gemini-4-argon", { source: "vexcloud", fetcher });
    expect(entry?.reasoning?.supportedEfforts).toEqual(["high", "medium"]);
  });
});

describe("the resolver follows the engine's mode", () => {
  it("reads the Vex Cloud catalogue when AGENT_PROVIDER=vexcloud", async () => {
    vi.resetModules();
    const calls: Array<{ readonly source: string | undefined }> = [];
    vi.doMock("../provider-model-catalog.js", () => ({
      getModelReasoningCapability: async (_id: string, options: { source?: string }) => {
        calls.push({ source: options.source });
        return null;
      },
    }));
    vi.doMock("@vex-agent/inference/registry.js", () => ({ resolveProvider: async () => null }));
    vi.stubEnv("AGENT_PROVIDER", "vexcloud");
    const { resolveReasoningCapability } = await import("../../ipc/reasoning-capability-resolver.js");
    await resolveReasoningCapability("anthropic/claude-haiku-5.5", new AbortController().signal);
    vi.stubEnv("AGENT_PROVIDER", "openrouter");
    await resolveReasoningCapability("anthropic/claude-haiku-5.5", new AbortController().signal);
    expect(calls).toEqual([{ source: "vexcloud" }, { source: "openrouter" }]);
    vi.doUnmock("../provider-model-catalog.js");
    vi.doUnmock("@vex-agent/inference/registry.js");
  });
});
