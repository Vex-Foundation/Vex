/**
 * The six market-data Pendle read tools — their contract, and their registration.
 *
 * Every one of them is REGISTERED as of card R4: composed into `PENDLE_TOOLS`,
 * wired to a handler, carrying a retrieval passage. This file asserts all three
 * together, because a manifest without a handler is a tool the model can see and
 * cannot call, and a manifest without a passage is one dense retrieval cannot
 * find.
 *
 * The description assertions are not style policing. A context-free agent plans
 * from these sentences alone, and the gap register records what happens when one
 * of them is untrue: an LP tool that promised post-expiry removal it could not
 * do, and a redeem that promised the underlying while delivering something else.
 */

import { describe, expect, it } from "vitest";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

import { PENDLE_TOOLS } from "@vex-agent/tools/protocols/pendle/manifest.js";
import { PENDLE_HANDLERS } from "@vex-agent/tools/protocols/pendle/handlers.js";
import { PENDLE_MARKET_GET_TOOL } from "@vex-agent/tools/protocols/pendle/manifests/market-get.js";
import { PENDLE_MARKET_HISTORY_TOOL } from "@vex-agent/tools/protocols/pendle/manifests/market-history.js";
import { PENDLE_MARKET_CANDLES_TOOL } from "@vex-agent/tools/protocols/pendle/manifests/market-candles.js";
import { PENDLE_ORDERBOOK_TOOL } from "@vex-agent/tools/protocols/pendle/manifests/orderbook.js";
import { PENDLE_REWARDS_MERKLE_TOOL } from "@vex-agent/tools/protocols/pendle/manifests/rewards-merkle.js";
import { PENDLE_PRICES_ASSETS_TOOL } from "@vex-agent/tools/protocols/pendle/manifests/prices-assets.js";

const NEW_TOOLS: readonly ProtocolToolManifest[] = [
  PENDLE_MARKET_GET_TOOL,
  PENDLE_MARKET_HISTORY_TOOL,
  PENDLE_MARKET_CANDLES_TOOL,
  PENDLE_ORDERBOOK_TOOL,
  PENDLE_REWARDS_MERKLE_TOOL,
  PENDLE_PRICES_ASSETS_TOOL,
];

const EXPECTED_IDS = [
  "pendle.market.get",
  "pendle.market.history",
  "pendle.market.candles",
  "pendle.orderbook",
  "pendle.rewards.merkle",
  "pendle.prices.assets",
];

function requiredKeys(tool: ProtocolToolManifest): string[] {
  return tool.params.filter((p) => p.required === true).map((p) => p.key);
}

describe("market-data Pendle reads — registration", () => {
  it("declares exactly the six tool ids", () => {
    expect(NEW_TOOLS.map((t) => t.toolId)).toEqual(EXPECTED_IDS);
  });

  it("is composed into the live Pendle tool list, taking it from sixteen to twenty-two", () => {
    expect(PENDLE_TOOLS).toHaveLength(22);
    const live = new Map(PENDLE_TOOLS.map((t) => [t.toolId, t]));
    for (const tool of NEW_TOOLS) expect(live.get(tool.toolId)).toBe(tool);
  });

  it("wires a handler for every one — a manifest without a handler is uncallable", () => {
    for (const toolId of EXPECTED_IDS) {
      expect(typeof PENDLE_HANDLERS[toolId]).toBe("function");
    }
  });

  it("carries a retrieval passage for every one — a manifest without one cannot be found", () => {
    for (const tool of NEW_TOOLS) {
      expect(tool.discovery?.embeddingText?.length ?? 0).toBeGreaterThan(0);
      expect(tool.discovery?.chains?.length ?? 0).toBeGreaterThan(0);
      // `paramKeywords` is derived from param keys at metadata compile; a
      // hand-authored one would drift from the params it claims to mirror.
      expect(tool.discovery?.paramKeywords).toBeUndefined();
    }
  });
});

describe("new Pendle read manifests — classification", () => {
  it("is read-only across the board: nothing here may reach a wallet or a signer", () => {
    for (const tool of NEW_TOOLS) {
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
      expect(tool.namespace).toBe("pendle");
      expect(tool.lifecycle).toBe("active");
      expect(tool.toolId).toMatch(/^pendle\./);
    }
  });

  it("gives every tool a substantive description and a usable example", () => {
    for (const tool of NEW_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(200);
      expect(Object.keys(tool.exampleParams).length).toBeGreaterThan(0);
      for (const key of Object.keys(tool.exampleParams)) {
        expect(tool.params.map((p) => p.key)).toContain(key);
      }
    }
  });

  it("describes every param, with the accepted range on every numeric one", () => {
    for (const tool of NEW_TOOLS) {
      for (const param of tool.params) {
        expect(param.description.length).toBeGreaterThan(30);
        if (param.type === "number") {
          expect(param.description).toMatch(/\d/);
          expect(param.description.toLowerCase()).toMatch(/default|at most|whole number|≥|-/);
        }
      }
    }
  });
});

describe("new Pendle read manifests — required inputs", () => {
  it("requires exactly what each read cannot be performed without", () => {
    expect(requiredKeys(PENDLE_MARKET_GET_TOOL)).toEqual(["chain"]);
    expect(requiredKeys(PENDLE_MARKET_HISTORY_TOOL)).toEqual(["chain", "market"]);
    expect(requiredKeys(PENDLE_MARKET_CANDLES_TOOL)).toEqual(["chain", "asset"]);
    expect(requiredKeys(PENDLE_ORDERBOOK_TOOL)).toEqual(["chain", "market"]);
    expect(requiredKeys(PENDLE_PRICES_ASSETS_TOOL)).toEqual(["chain"]);
    expect(requiredKeys(PENDLE_REWARDS_MERKLE_TOOL)).toEqual([]);
  });

  it("offers market.get all three identifiers, none of them required", () => {
    const keys = PENDLE_MARKET_GET_TOOL.params.map((p) => p.key);
    expect(keys).toEqual(["chain", "market", "pt", "yt"]);
    expect(PENDLE_MARKET_GET_TOOL.description).toMatch(/matured/i);
  });

  it("gives the merkle read NO wallet parameter — the session wallet is the only subject", () => {
    const keys = PENDLE_REWARDS_MERKLE_TOOL.params.map((p) => p.key);
    expect(keys).toEqual(["chain"]);
    expect(keys).not.toContain("wallet");
    expect(keys).not.toContain("user");
    expect(keys).not.toContain("address");
  });
});

describe("new Pendle read manifests — honesty about what Vex cannot do", () => {
  it("says a matured market has no live rates and that trades are exact-input only", () => {
    const description = PENDLE_MARKET_GET_TOOL.description;
    expect(description).toMatch(/rates: null/);
    expect(description.toLowerCase()).toContain("exact-input");
    expect(description.toLowerCase()).toContain("never a guaranteed amountout");
  });

  it("does not promise EXACT token lists the handler ships bounded", () => {
    // The handler caps each accepted-token list and reports `total`/`truncated`;
    // a description promising the exact lists would be the same class of untrue
    // sentence the gap register catalogues.
    const description = PENDLE_MARKET_GET_TOOL.description;
    expect(description).not.toMatch(/exact token lists/i);
    expect(description.toLowerCase()).toContain("truncated");
  });

  it("says Vex cannot fill a resting limit order", () => {
    const description = PENDLE_ORDERBOOK_TOOL.description;
    expect(description).toMatch(/CANNOT FILL/);
    expect(description.toLowerCase()).toContain("amm");
    expect(description.toLowerCase()).toContain("never places, signs or cancels");
  });

  it("says the merkle rewards can never be claimed through Vex, and where to claim them", () => {
    const description = PENDLE_REWARDS_MERKLE_TOOL.description;
    expect(description).toMatch(/VEX CANNOT CLAIM THEM/);
    expect(description).toContain("merkle proof");
    expect(description).toContain("app.pendle.finance");
  });

  it("separates a price mark from an executable quote on both price-shaped tools", () => {
    expect(PENDLE_PRICES_ASSETS_TOOL.description).toMatch(/NOT executable quotes/);
    expect(PENDLE_MARKET_CANDLES_TOOL.description).toMatch(/not executable quotes/);
  });

  it("warns that LP volume on the candles endpoint is structurally zero", () => {
    const description = PENDLE_MARKET_CANDLES_TOOL.description;
    expect(description).toContain("volume as 0");
    expect(description).toContain("pendle.market.history");
  });

  it("tells the agent that history describes the past and does not predict a fill", () => {
    expect(PENDLE_MARKET_HISTORY_TOOL.description.toLowerCase()).toContain("do not predict");
  });
});
