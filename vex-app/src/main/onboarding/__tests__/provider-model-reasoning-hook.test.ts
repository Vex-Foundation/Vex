import { describe, expect, it, vi } from "vitest";
import { HTTPClient } from "@vex-lib/openrouter-client.js";
import {
  buildReasoningCapabilityMap,
  createReasoningCapabilityHook,
} from "../provider-model-reasoning-hook.js";

describe("buildReasoningCapabilityMap", () => {
  it("builds one entry per valid model id with independent reasoning + supportsReasoningParameter fields", () => {
    const map = buildReasoningCapabilityMap({
      data: [
        {
          id: "anthropic/claude",
          supported_parameters: ["tools", "reasoning", "reasoning_effort"],
          reasoning: {
            supported_efforts: ["high", "medium", "low"],
            default_effort: "medium",
            default_enabled: true,
            mandatory: false,
          },
        },
        {
          id: "openai/gpt",
          supported_parameters: ["tools"],
        },
      ],
    });

    expect(map).not.toBeNull();
    expect(map?.get("anthropic/claude")).toEqual({
      reasoning: {
        supportedEfforts: ["high", "medium", "low", "none"],
        defaultEffort: "medium",
        defaultEnabled: true,
        mandatory: false,
      },
      supportsReasoningParameter: true,
    });
    expect(map?.get("openai/gpt")).toEqual({
      reasoning: null,
      supportsReasoningParameter: false,
    });
  });

  it("reasoning present without supported_efforts (omitted) normalizes to null, but still records supportsReasoningParameter", () => {
    const map = buildReasoningCapabilityMap({
      data: [
        {
          id: "vendor/weird-model",
          supported_parameters: ["reasoning"],
          reasoning: { default_effort: "medium" }, // supported_efforts omitted
        },
      ],
    });
    expect(map?.get("vendor/weird-model")).toEqual({
      reasoning: null,
      supportsReasoningParameter: true,
    });
  });

  it("supported_efforts: null normalizes to the full canonical positive set", () => {
    const map = buildReasoningCapabilityMap({
      data: [
        {
          id: "vendor/unrestricted",
          supported_parameters: ["reasoning_effort"],
          reasoning: { supported_efforts: null },
        },
      ],
    });
    expect(map?.get("vendor/unrestricted")?.reasoning?.supportedEfforts).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });

  it("skips malformed rows (non-string id) but keeps valid rows in the same payload", () => {
    const map = buildReasoningCapabilityMap({
      data: [
        { id: 12345, reasoning: { supported_efforts: ["high"] } },
        { id: "vendor/valid", reasoning: { supported_efforts: ["high"] } },
        "not even an object",
        null,
      ],
    });
    expect(map?.size).toBe(1);
    expect(map?.has("vendor/valid")).toBe(true);
  });

  it("keeps the FIRST occurrence on duplicate model ids", () => {
    const map = buildReasoningCapabilityMap({
      data: [
        { id: "vendor/dup", reasoning: { supported_efforts: ["high"] } },
        { id: "vendor/dup", reasoning: { supported_efforts: ["low"] } },
      ],
    });
    expect(map?.get("vendor/dup")?.reasoning?.supportedEfforts).toEqual(["high", "none"]);
  });

  it("drops unrecognized effort strings inside an otherwise-valid row (not a malformed-row rejection)", () => {
    const map = buildReasoningCapabilityMap({
      data: [{ id: "vendor/x", reasoning: { supported_efforts: ["high", "ultra-max"] } }],
    });
    expect(map?.get("vendor/x")?.reasoning?.supportedEfforts).toEqual(["high", "none"]);
  });

  it("returns null for an outer payload that isn't {data: [...]}", () => {
    expect(buildReasoningCapabilityMap({ notData: [] })).toBeNull();
    expect(buildReasoningCapabilityMap(null)).toBeNull();
    expect(buildReasoningCapabilityMap("garbage")).toBeNull();
  });
});

describe("createReasoningCapabilityHook - mechanical fail-open (D1a)", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("captures the capability map on a normal 200 response", async () => {
    const { hook, read } = createReasoningCapabilityHook();
    const res = jsonResponse({
      data: [{ id: "vendor/a", reasoning: { supported_efforts: ["high"] } }],
    });
    await hook(res, new Request("https://openrouter.ai/api/v1/models"));
    expect(read()?.get("vendor/a")?.reasoning?.supportedEfforts).toEqual(["high", "none"]);
  });

  it("skips non-200 responses without throwing (capability stays null)", async () => {
    const { hook, read } = createReasoningCapabilityHook();
    const res = jsonResponse({ error: "server error" }, 500);
    await expect(hook(res, new Request("https://x"))).resolves.toBeUndefined();
    expect(read()).toBeNull();
  });

  it("clone() throwing is caught - the hook resolves normally, capability stays null", async () => {
    const { hook, read } = createReasoningCapabilityHook();
    const res = jsonResponse({ data: [{ id: "vendor/a" }] });
    vi.spyOn(res, "clone").mockImplementation(() => {
      throw new Error("clone boom");
    });
    await expect(hook(res, new Request("https://x"))).resolves.toBeUndefined();
    expect(read()).toBeNull();
  });

  it("json() rejecting is caught - the hook resolves normally, capability stays null", async () => {
    const { hook, read } = createReasoningCapabilityHook();
    const res = jsonResponse({ data: [{ id: "vendor/a" }] });
    const clone = res.clone();
    vi.spyOn(clone, "json").mockRejectedValue(new Error("json boom"));
    vi.spyOn(res, "clone").mockReturnValue(clone);
    await expect(hook(res, new Request("https://x"))).resolves.toBeUndefined();
    expect(read()).toBeNull();
  });

  it("each createReasoningCapabilityHook() call is request-local - no shared mutable state across instances", async () => {
    const first = createReasoningCapabilityHook();
    const second = createReasoningCapabilityHook();
    await first.hook(
      jsonResponse({ data: [{ id: "vendor/a", reasoning: { supported_efforts: ["high"] } }] }),
      new Request("https://x"),
    );
    expect(first.read()).not.toBeNull();
    expect(second.read()).toBeNull();
  });
});

describe("createReasoningCapabilityHook wired into the real HTTPClient (integration)", () => {
  it("a throwing hook never rejects HTTPClient.request() - the SDK's response still resolves", async () => {
    const rawBody = JSON.stringify({
      data: [{ id: "vendor/a", reasoning: { supported_efforts: ["high", "medium"] } }],
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(rawBody, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { hook, read } = createReasoningCapabilityHook();
    const client = new HTTPClient({ fetcher }).addHook("response", hook);

    const response = await client.request(new Request("https://openrouter.ai/api/v1/models"));

    // The client's own response is fully intact — our hook read a CLONE,
    // never consuming the original body the caller still needs to read.
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(JSON.parse(rawBody));
    expect(read()?.get("vendor/a")?.reasoning?.supportedEfforts).toEqual([
      "high",
      "medium",
      "none",
    ]);
  });

  it("a body that fails to parse as JSON degrades to null capability without breaking the caller's own read", async () => {
    const rawBody = "not json at all";
    const fetcher = vi.fn().mockResolvedValue(
      new Response(rawBody, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const { hook, read } = createReasoningCapabilityHook();
    const client = new HTTPClient({ fetcher }).addHook("response", hook);

    const response = await client.request(new Request("https://openrouter.ai/api/v1/models"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(rawBody);
    expect(read()).toBeNull();
  });
});
