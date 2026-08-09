import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { LIGHTER_ENVIRONMENTS } from "@tools/lighter/constants.js";
import {
  getProtocolHandler,
  getProtocolManifest,
} from "@vex-agent/tools/protocols/catalog.js";
import { isRankedDiscoveryItem } from "@vex-agent/tools/protocols/discovery.js";
import { discoverProtocolCapabilities } from "@vex-agent/tools/protocols/runtime.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import { LIGHTER_HANDLERS } from "@vex-agent/tools/protocols/lighter/handlers.js";
import { LIGHTER_TOOLS } from "@vex-agent/tools/protocols/lighter/manifest.js";

const LIGHTER_TOOL_IDS = [
  "lighter.system",
  "lighter.markets",
  "lighter.market.get",
  "lighter.account.get",
  "lighter.positions",
  "lighter.openOrders",
  "lighter.orderHistory",
  "lighter.trades",
  "lighter.orderbook",
  "lighter.recentTrades",
  "lighter.candles",
] as const;

describe("Lighter agent discovery surface", () => {
  const ENV_KEYS = [
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIM",
    "EMBEDDING_PROVIDER",
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIM;
    delete process.env.EMBEDDING_PROVIDER;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("registers the read-only Lighter public and account tools", () => {
    expect(LIGHTER_TOOLS.map((tool) => tool.toolId)).toEqual(LIGHTER_TOOL_IDS);

    for (const tool of LIGHTER_TOOLS) {
      expect(tool.namespace).toBe("lighter");
      expect(tool.lifecycle).toBe("active");
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
      expect(tool.requiresEnv).toBeUndefined();
      expect(getProtocolManifest(tool.toolId)).toBe(tool);
      expect(getProtocolHandler(tool.toolId)).toBe(LIGHTER_HANDLERS[tool.toolId]);
    }
  });

  it("requires an explicit core or rhc environment on every tool", () => {
    for (const tool of LIGHTER_TOOLS) {
      const environment = tool.params.find((param) => param.key === "environment");
      expect(environment, `${tool.toolId} environment param`).toBeDefined();
      expect(environment?.required, `${tool.toolId} environment required`).toBe(true);
      expect(environment?.enum, `${tool.toolId} environment enum`).toEqual(LIGHTER_ENVIRONMENTS);

      const rejected = validateProtocolParams(tool, { ...tool.exampleParams, environment: "mainnet" });
      expect(rejected.ok, `${tool.toolId} rejects unsupported env`).toBe(false);
      if (!rejected.ok) expect(rejected.reason).toContain("Allowed values");
    }
  });

  it("lists the complete lighter namespace as lean discovery rows", async () => {
    const result = await discoverProtocolCapabilities({ list: true, namespace: "lighter" });
    expect(result.success).toBe(true);
    expect(result.retrieval?.method).toBe("list");
    expect(result.tools.map((tool) => tool.toolId)).toEqual(LIGHTER_TOOL_IDS);
    expect(result.nextStep).toContain("describe_tools");

    for (const tool of result.tools) {
      expect(isRankedDiscoveryItem(tool)).toBe(false);
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
      expect(tool.requiredParams).toContain("environment");
      expect(tool).not.toHaveProperty("params");
    }
  });

  it("returns full schemas when discovering the lighter namespace", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "lighter", limit: 20 });
    expect(result.success).toBe(true);
    expect(result.count).toBe(LIGHTER_TOOL_IDS.length);
    expect(result.tools.map((tool) => tool.toolId)).toEqual(LIGHTER_TOOL_IDS);

    for (const tool of result.tools) {
      expect(isRankedDiscoveryItem(tool)).toBe(true);
      if (!isRankedDiscoveryItem(tool)) continue;
      expect(tool.namespace).toBe("lighter");
      expect(tool.required).toContain("environment");
      expect(tool.exampleParams.environment).toMatch(/^(core|rhc)$/);
    }
  });

  it("pins an exact lighter tool id query to that tool", async () => {
    const result = await discoverProtocolCapabilities({ query: "lighter.orderbook", limit: 5 });
    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBe("lighter.orderbook");
  });

  it("recalls Lighter tools from natural market-data queries", async () => {
    const depth = await discoverProtocolCapabilities({
      namespace: "lighter",
      query: "rhc order book depth and bids asks",
      limit: 3,
    });
    expect(depth.success).toBe(true);
    expect(depth.tools.map((tool) => tool.toolId)).toContain("lighter.orderbook");

    const candles = await discoverProtocolCapabilities({
      namespace: "lighter",
      query: "price history candles for a lighter market",
      limit: 3,
    });
    expect(candles.success).toBe(true);
    expect(candles.tools.map((tool) => tool.toolId)).toContain("lighter.candles");
  });
});
