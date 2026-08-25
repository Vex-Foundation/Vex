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
  "lighter.account.onboarding.status",
  "lighter.system",
  "lighter.markets",
  "lighter.market.get",
  "lighter.account.get",
  "lighter.positions",
  "lighter.openOrders",
  "lighter.orderHistory",
  "lighter.trades",
  "lighter.apiKeys.inspect",
  "lighter.order.preview",
  "lighter.deposit.status",
  "lighter.withdraw.status",
  "lighter.key.register.status",
  "lighter.order.status",
  "lighter.orderbook",
  "lighter.recentTrades",
  "lighter.candles",
  "lighter.order.cancel.prepare",
  "lighter.order.cancel",
  "lighter.order.modify.prepare",
  "lighter.order.modify",
  "lighter.order.cancelAll.prepare",
  "lighter.order.cancelAll",
  "lighter.position.close.prepare",
  "lighter.position.close",
  "lighter.withdraw.claim.prepare",
  "lighter.withdraw.claim",
  "lighter.withdraw.prepare",
  "lighter.withdraw",
  "lighter.key.register.prepare",
  "lighter.key.register",
  "lighter.deposit.prepare",
  "lighter.deposit",
  "lighter.order.create.prepare",
  "lighter.order.create",
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

  it("registers the Lighter public, account, preview, and approval-gated order tools", () => {
    expect(LIGHTER_TOOLS.map((tool) => tool.toolId)).toEqual(LIGHTER_TOOL_IDS);

    for (const tool of LIGHTER_TOOLS) {
      expect(tool.namespace).toBe("lighter");
      expect(tool.lifecycle).toBe("active");
      expect(tool.requiresEnv).toBeUndefined();
      expect(getProtocolManifest(tool.toolId)).toBe(tool);
      expect(getProtocolHandler(tool.toolId)).toBe(LIGHTER_HANDLERS[tool.toolId]);
    }
    expect(getProtocolManifest("lighter.order.create.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(getProtocolManifest("lighter.order.create")).toMatchObject({
      mutating: true,
      actionKind: "external_post",
    });
    expect(getProtocolManifest("lighter.order.cancel.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(getProtocolManifest("lighter.order.cancel")).toMatchObject({
      mutating: true,
      actionKind: "external_post",
    });
    expect(getProtocolManifest("lighter.order.modify.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(getProtocolManifest("lighter.order.modify")).toMatchObject({
      mutating: true,
      actionKind: "external_post",
    });
    expect(getProtocolManifest("lighter.order.cancelAll.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(getProtocolManifest("lighter.order.cancelAll")).toMatchObject({
      mutating: true,
      actionKind: "external_post",
    });
    expect(getProtocolManifest("lighter.position.close.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(getProtocolManifest("lighter.position.close")).toMatchObject({
      mutating: true,
      actionKind: "external_post",
    });
    expect(getProtocolManifest("lighter.key.register.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(getProtocolManifest("lighter.key.register")).toMatchObject({
      mutating: true,
      actionKind: "user_wallet_broadcast",
    });
    expect(getProtocolManifest("lighter.key.register.status")).toMatchObject({
      mutating: false,
      actionKind: "read",
    });
    expect(getProtocolManifest("lighter.withdraw.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(getProtocolManifest("lighter.withdraw")).toMatchObject({
      mutating: true,
      actionKind: "external_post",
    });
    expect(getProtocolManifest("lighter.withdraw.claim.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(getProtocolManifest("lighter.withdraw.claim")).toMatchObject({
      mutating: true,
      actionKind: "user_wallet_broadcast",
    });
  });

  it("accepts core or rhc environment on environment-scoped tools", () => {
    for (const tool of LIGHTER_TOOLS.filter((candidate) =>
      candidate.params.some((param) => param.key === "environment"),
    )) {
      const environment = tool.params.find((param) => param.key === "environment");
      expect(environment, `${tool.toolId} environment param`).toBeDefined();
      expect(environment?.required, `${tool.toolId} environment optional`).not.toBe(true);
      expect(environment?.enum, `${tool.toolId} environment enum`).toEqual(LIGHTER_ENVIRONMENTS);

      const rejected = validateProtocolParams(tool, { ...tool.exampleParams, environment: "mainnet" });
      expect(rejected.ok, `${tool.toolId} rejects unsupported env`).toBe(false);
      if (!rejected.ok) expect(rejected.reason).toContain("Allowed values");
    }
  });

  it("publishes an exact perp-or-spot selector for order previews", () => {
    const preview = getProtocolManifest("lighter.order.preview");
    expect(preview).toBeDefined();
    const marketType = preview?.params.find((param) => param.key === "marketType");
    expect(marketType).toMatchObject({
      type: "string",
      enum: ["perp", "spot"],
    });
    expect(marketType?.required).not.toBe(true);
    expect(preview?.description).toContain("refuses a product mismatch");
    expect(preview?.exampleParams).toMatchObject({
      environment: "core",
      marketSymbol: "ETH/USDC",
      marketType: "spot",
    });

    const accepted = validateProtocolParams(preview!, preview!.exampleParams);
    expect(accepted.ok).toBe(true);
    const rejected = validateProtocolParams(preview!, {
      ...preview!.exampleParams,
      marketType: "all",
    });
    expect(rejected.ok).toBe(false);
  });

  it("lists the complete lighter namespace as lean discovery rows", async () => {
    const result = await discoverProtocolCapabilities({ list: true, namespace: "lighter" });
    expect(result.success).toBe(true);
    expect(result.retrieval?.method).toBe("list");
    expect(result.tools.map((tool) => tool.toolId)).toEqual(LIGHTER_TOOL_IDS);
    expect(result.nextStep).toContain('ToolSearch(query="select:');

    for (const tool of result.tools) {
      expect(isRankedDiscoveryItem(tool)).toBe(false);
      if (tool.toolId === "lighter.order.create" || tool.toolId === "lighter.order.cancel" || tool.toolId === "lighter.order.modify" || tool.toolId === "lighter.order.cancelAll" || tool.toolId === "lighter.position.close" || tool.toolId === "lighter.withdraw") {
        expect(tool.mutating).toBe(true);
        expect(tool.actionKind).toBe("external_post");
        expect(tool.requiredParams).toContain("intentId");
      } else if (tool.toolId === "lighter.withdraw.claim") {
        expect(tool.mutating).toBe(true);
        expect(tool.actionKind).toBe("user_wallet_broadcast");
        expect(tool.requiredParams).toContain("claimId");
      } else if (tool.toolId === "lighter.deposit") {
        expect(tool.mutating).toBe(true);
        expect(tool.actionKind).toBe("user_wallet_broadcast");
        expect(tool.requiredParams).toContain("intentId");
      } else if (tool.toolId === "lighter.key.register") {
        expect(tool.mutating).toBe(true);
        expect(tool.actionKind).toBe("user_wallet_broadcast");
        expect(tool.requiredParams).toContain("intentId");
      } else if (
        tool.toolId === "lighter.order.create.prepare"
        || tool.toolId === "lighter.order.cancel.prepare"
        || tool.toolId === "lighter.order.modify.prepare"
        || tool.toolId === "lighter.order.cancelAll.prepare"
        || tool.toolId === "lighter.position.close.prepare"
        || tool.toolId === "lighter.withdraw.prepare"
        || tool.toolId === "lighter.withdraw.claim.prepare"
        || tool.toolId === "lighter.deposit.prepare"
        || tool.toolId === "lighter.key.register.prepare"
      ) {
        expect(tool.mutating).toBe(false);
        expect(tool.actionKind).toBe("approval_prepare");
      } else {
        expect(tool.mutating).toBe(false);
        expect(tool.actionKind).toBe("read");
      }
      expect(tool).not.toHaveProperty("params");
    }
  });

  it("returns ranked schemas up to the global discovery cap", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "lighter", limit: 22 });
    expect(result.success).toBe(true);
    expect(result.count).toBe(20);
    expect(result.tools.map((tool) => tool.toolId)).toEqual(LIGHTER_TOOL_IDS.slice(0, 20));

    for (const tool of result.tools) {
      expect(isRankedDiscoveryItem(tool)).toBe(true);
      if (!isRankedDiscoveryItem(tool)) continue;
      expect(tool.namespace).toBe("lighter");
      if (
        tool.toolId === "lighter.order.create"
        || tool.toolId === "lighter.order.cancel"
        || tool.toolId === "lighter.order.modify"
        || tool.toolId === "lighter.order.cancelAll"
        || tool.toolId === "lighter.position.close"
        || tool.toolId === "lighter.withdraw"
        || tool.toolId === "lighter.key.register"
      ) {
        expect(tool.required).toContain("intentId");
      } else if (tool.toolId === "lighter.withdraw.claim") {
        expect(tool.required).toContain("claimId");
      } else {
        expect(tool.required).not.toContain("environment");
      }
    }
  });

  it("recalls key registration separately from deposit and order execution", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "lighter",
      query: "lighter key registration",
      limit: 5,
    });
    expect(result.success).toBe(true);
    expect(result.tools.map((tool) => tool.toolId)).toContain(
      "lighter.key.register.prepare",
    );
  });

  it.each([
    "hey, set up my Lighter account",
    "I need to trade on Lighter",
    "I want to trade perps on Lighter",
    "get me ready to trade on Lighter",
  ])("recalls managed onboarding from a normal-user request: %s", async (query) => {
    const result = await discoverProtocolCapabilities({
      namespace: "lighter",
      query,
      limit: 5,
    });
    expect(result.success).toBe(true);
    expect(result.tools.map((tool) => tool.toolId)).toContain(
      "lighter.account.onboarding.status",
    );
  });

  it("pins an exact lighter tool id query to that tool", async () => {
    const result = await discoverProtocolCapabilities({ query: "lighter.orderbook", limit: 5 });
    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBe("lighter.orderbook");
  });

  it("recalls the order preview gate from preview-order queries", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "lighter",
      query: "preview a rhc lighter order before placing it",
      limit: 5,
    });

    expect(result.success).toBe(true);
    expect(result.tools.map((tool) => tool.toolId)).toContain("lighter.order.preview");
  });

  it("recalls the order create preparation gate from approval queries", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "lighter",
      query: "prepare approval to create this rhc lighter order preview",
      limit: 5,
    });

    expect(result.success).toBe(true);
    expect(result.tools.map((tool) => tool.toolId)).toContain("lighter.order.create.prepare");
  });

  it("recalls deposit preparation and status as separate capabilities", async () => {
    const prepare = await discoverProtocolCapabilities({
      namespace: "lighter",
      query: "prepare a lighter deposit to fund and onboard my wallet",
      limit: 5,
    });
    expect(prepare.success).toBe(true);
    expect(prepare.tools.map((tool) => tool.toolId)).toContain(
      "lighter.deposit.prepare",
    );

    const status = await discoverProtocolCapabilities({
      namespace: "lighter",
      query: "my lighter deposit is stuck or ambiguous check funding status",
      limit: 5,
    });
    expect(status.success).toBe(true);
    expect(status.tools.map((tool) => tool.toolId)).toContain(
      "lighter.deposit.status",
    );
  });

  it("routes an explicit deposit amount to exact deposit preparation, not target-balance onboarding", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "lighter",
      query: "fund my Lighter RHC account with 5 USDG from my Vex wallet",
      limit: 5,
    });

    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBe("lighter.deposit.prepare");
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
