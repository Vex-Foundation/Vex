/**
 * Interactive discovery never waits on a hung embedder for longer than its
 * 5 s budget: it falls back to lexical ranking, and says the rows are lower
 * confidence in the result, the model-facing copy and telemetry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import logger from "@utils/logger.js";
import {
  LOW_CONFIDENCE_WARNING,
  discoverProtocolCapabilities,
} from "../../../vex-agent/tools/protocols/discovery.js";
import { toModelDiscoveryResult } from "../../../vex-agent/tools/protocols/discovery/rows.js";
import {
  logDiscoveryTelemetry,
  newDiscoveryRunId,
} from "../../../vex-agent/tools/protocols/discovery.telemetry.js";
import { requireValue } from "../../helpers/require-value.js";

const ENV_KEYS = ["EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIM", "EMBEDDING_PROVIDER"] as const;

function hangingFetch() {
  return vi.fn((_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  );
}

describe("interactive discovery embedding budget", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.EMBEDDING_MODEL = "ai/embeddinggemma:300M-Q8_0";
    process.env.EMBEDDING_DIM = "768";
    process.env.EMBEDDING_PROVIDER = "local";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns a flagged lexical fallback within ~5 s when the embedder hangs", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const request = { query: "swap usdc on base", limit: 5 };

    const startedAt = Date.now();
    const result = await discoverProtocolCapabilities(request);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(6_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(result.success).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);
    const retrieval = requireValue(result.retrieval);
    expect(retrieval.method).toBe("lexical");
    expect(retrieval.denseFailed).toBe(true);
    expect(retrieval.lowConfidence).toBe(true);
    expect(retrieval.denseFailureReason).toBe("timeout");
    expect(result.warnings).toContain(LOW_CONFIDENCE_WARNING);

    // Model copy: the flag and the warning survive, the reason is telemetry-only.
    const modelResult = toModelDiscoveryResult(result);
    expect(modelResult.retrieval?.lowConfidence).toBe(true);
    expect(modelResult.retrieval).not.toHaveProperty("denseFailureReason");
    expect(modelResult.warnings).toContain(LOW_CONFIDENCE_WARNING);

    // Telemetry carries both.
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
    logDiscoveryTelemetry({ request, result, discoveryRunId: newDiscoveryRunId() });
    expect(info).toHaveBeenCalledWith("tools.discover.completed", expect.objectContaining({
      lowConfidence: true, denseFailureReason: "timeout", denseFailed: true,
    }));
  }, 15_000);

  it("an unconfigured embedder also flags the fallback as low confidence, with reason error", async () => {
    delete process.env.EMBEDDING_BASE_URL;
    const result = await discoverProtocolCapabilities({ query: "swap usdc on base", limit: 5 });
    expect(result.retrieval?.lowConfidence).toBe(true);
    expect(result.retrieval?.denseFailureReason).toBe("error");
    expect(result.warnings).toContain(LOW_CONFIDENCE_WARNING);
  });

  it("does not flag an exact-name hit or a catalog listing", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const exact = await discoverProtocolCapabilities({ query: "dexscreener.search", limit: 5 });
    const catalog = await discoverProtocolCapabilities({ limit: 5 });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const result of [exact, catalog]) {
      expect(result.retrieval?.lowConfidence).toBeUndefined();
      expect(result.warnings).not.toContain(LOW_CONFIDENCE_WARNING);
    }
  });
});
