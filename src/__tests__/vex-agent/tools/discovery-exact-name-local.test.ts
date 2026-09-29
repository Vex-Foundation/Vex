/**
 * A query that is ONE candidate's exact name is resolved locally, before dense
 * scoring, and never reaches the embedder. Everything else (prefixes, ambiguous
 * names, intent prose, names the filters excluded) still takes the ranked path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const embedQuerySpy = vi.hoisted(() =>
  vi.fn(async (_query: string): Promise<{ embedding: number[]; providerModel: string }> => {
    throw new Error("embeddings unavailable in this test");
  }),
);

vi.mock("../../../vex-agent/embeddings/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../vex-agent/embeddings/client.js")>();
  return { ...actual, embedQuery: embedQuerySpy };
});

import { discoverProtocolCapabilities } from "../../../vex-agent/tools/protocols/runtime.js";
import { resolveUniqueExactNameMatch } from "../../../vex-agent/tools/protocols/toolid-pin.js";
import { PROTOCOL_TOOLS } from "../../../vex-agent/tools/protocols/catalog.js";

function catalogTool(toolId: string) {
  const found = PROTOCOL_TOOLS.find((m) => m.toolId === toolId);
  if (!found) throw new Error(`fixture drift: ${toolId} is not a catalog manifest`);
  return found;
}

describe("resolveUniqueExactNameMatch", () => {
  const candidates = [...PROTOCOL_TOOLS];

  it("resolves an exact toolId and an exact publicName to the same manifest", () => {
    const tool = catalogTool("dexscreener.search");
    expect(resolveUniqueExactNameMatch(tool.toolId, candidates)?.manifest.toolId).toBe(tool.toolId);
    expect(resolveUniqueExactNameMatch(tool.toolId, candidates)?.whyMatched).toEqual(["toolId"]);
    expect(resolveUniqueExactNameMatch(tool.publicName, candidates)?.manifest.toolId).toBe(tool.toolId);
    expect(resolveUniqueExactNameMatch(tool.publicName, candidates)?.whyMatched).toEqual(["publicName"]);
  });

  it("resolves every catalog toolId and publicName to its own manifest", () => {
    const misses = PROTOCOL_TOOLS.filter((tool) =>
      resolveUniqueExactNameMatch(tool.toolId, candidates)?.manifest.toolId !== tool.toolId
      || resolveUniqueExactNameMatch(tool.publicName, candidates)?.manifest.toolId !== tool.toolId,
    ).map((tool) => tool.toolId);
    expect(misses).toEqual([]);
  });

  it("does not resolve a prefix, even a unique one", () => {
    const target = catalogTool("dexscreener.launchpad.pairs");
    const prefix = target.toolId.slice(0, target.toolId.length - 3);
    expect(resolveUniqueExactNameMatch(prefix, candidates)).toBeNull();
  });

  it("does not resolve intent prose or an empty query", () => {
    expect(resolveUniqueExactNameMatch("dexscreener search pairs", candidates)).toBeNull();
    expect(resolveUniqueExactNameMatch("   ", candidates)).toBeNull();
  });

  it("does not resolve a name two distinct candidates share", () => {
    const tool = catalogTool("dexscreener.search");
    const clash = { ...catalogTool("dexscreener.trending"), publicName: tool.toolId };
    expect(resolveUniqueExactNameMatch(tool.toolId, [tool, clash])).toBeNull();
  });

  it("does not resolve a name that is not among the candidates", () => {
    expect(resolveUniqueExactNameMatch("dexscreener.search", [catalogTool("dexscreener.trending")])).toBeNull();
  });
});

describe("discovery resolves an exact name before dense scoring", () => {
  const ENV_KEYS = ["JUPITER_API_KEY"] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    embedQuerySpy.mockClear();
    for (const k of ENV_KEYS) original[k] = process.env[k];
    delete process.env.JUPITER_API_KEY;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("an exact toolId never calls the embedder and ranks the tool first", async () => {
    const result = await discoverProtocolCapabilities({ query: "dexscreener.search", limit: 5 });
    expect(embedQuerySpy).not.toHaveBeenCalled();
    expect(result.tools[0]?.toolId).toBe("dexscreener.search");
    expect(result.tools[0]?.whyMatched).toEqual(["toolId"]);
    expect(result.retrieval?.method).toBe("exact");
    expect(result.retrieval?.denseFailed).toBe(false);
    const ids = result.tools.map((t) => t.toolId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("an exact publicName never calls the embedder", async () => {
    const tool = catalogTool("dexscreener.search");
    const result = await discoverProtocolCapabilities({ query: `  ${tool.publicName.toUpperCase()} `, limit: 5 });
    expect(embedQuerySpy).not.toHaveBeenCalled();
    expect(result.tools[0]?.toolId).toBe(tool.toolId);
    expect(result.tools[0]?.whyMatched).toEqual(["publicName"]);
  });

  it("a unique prefix still takes the ranked path, and is still pinned after it", async () => {
    const target = catalogTool("dexscreener.launchpad.pairs");
    const prefix = target.toolId.slice(0, target.toolId.length - 3);
    const result = await discoverProtocolCapabilities({ query: prefix, limit: 5 });
    expect(embedQuerySpy).toHaveBeenCalledTimes(1);
    expect(result.retrieval?.method).toBe("lexical");
    expect(result.tools[0]?.toolId).toBe(target.toolId);
  });

  it("an ambiguous prefix takes the ranked path", async () => {
    await discoverProtocolCapabilities({ query: "dexscreener.", limit: 5 });
    expect(embedQuerySpy).toHaveBeenCalledTimes(1);
  });

  it("intent prose takes the ranked path", async () => {
    await discoverProtocolCapabilities({ query: "trending meme tokens", limit: 5 });
    expect(embedQuerySpy).toHaveBeenCalledTimes(1);
  });

  it("an exact name the namespace filter excluded is not resolved or returned", async () => {
    const result = await discoverProtocolCapabilities({ query: "dexscreener.search", namespace: "khalani", limit: 5 });
    expect(embedQuerySpy).toHaveBeenCalledTimes(1);
    expect(result.retrieval?.method).not.toBe("exact");
    for (const tool of result.tools) expect(tool.namespace).toBe("khalani");
  });

  it("an exact name whose required env is unmet is not resolved or returned", async () => {
    const gated = PROTOCOL_TOOLS.find((m) => m.requiresEnv === "JUPITER_API_KEY" && m.lifecycle === "active");
    if (!gated) throw new Error("fixture drift: no active JUPITER_API_KEY-gated manifest");
    const result = await discoverProtocolCapabilities({ query: gated.toolId, limit: 5 });
    expect(embedQuerySpy).toHaveBeenCalledTimes(1);
    expect(result.retrieval?.method).not.toBe("exact");
    expect(result.tools.map((t) => t.toolId)).not.toContain(gated.toolId);
  });
});
