/**
 * Bridge param convention — W5b (`amount` → `amountRaw`), W3 (Relay slippage
 * ingress `string` → `number`+`unit`), W4a (the Relay default is MATERIALIZED
 * and sent explicitly) and the Khalani slippage refusal.
 *
 * Money path, so each rule is asserted at the boundary an agent actually hits:
 *
 *  1. the retired `amount` key is REJECTED BY NAME on all four bridge tools,
 *     and the rejection names `amountRaw` as the replacement;
 *  2. Relay's `slippageBps` is number-typed, so the manifest bps gate runs: a
 *     string, a fraction, and an over-ceiling value are all refused;
 *  3. the quote lane and the execute lane resolve the SAME slippage value when
 *     the caller omits it — the prequote round-trip W4a's materialization could
 *     have broken;
 *  4. `slippageBps` on a Khalani-routed bridge is REJECTED BY NAME, and the
 *     refusal says no slippage protection applies there.
 */

import { describe, it, expect, vi } from "vitest";

// Mocked so the identity builder resolves chains + wallet without network/vault.
vi.mock("@tools/relay/client.js", () => ({
  getCachedRelayChains: async () => [
    { id: 8453, name: "base" },
    { id: 4663, name: "robinhood" },
  ],
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => "0x1111111111111111111111111111111111111111",
}));
// The bridge venue router reads the LIVE Khalani chain registry: Base and
// Arbitrum are served here, Robinhood Chain is not, which is what makes the two
// routes below a Khalani route and a Relay route respectively.
vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getChains: async () => [
      { type: "eip155", id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
      { type: "eip155", id: 42161, name: "Arbitrum", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
    ],
  }),
}));

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import { buildRelayBridgeIdentity } from "@vex-agent/tools/protocols/prequote/identity/relay-bridge.js";
import {
  resolveRelaySlippageBps,
  VEX_DEFAULT_SLIPPAGE_BPS,
  VEX_MAX_SLIPPAGE_BPS,
} from "@vex-agent/tools/protocols/slippage-policy.js";
import {
  KHALANI_SLIPPAGE_UNSUPPORTED_REASON,
  khalaniSlippageRejection,
} from "@vex-agent/tools/protocols/khalani/slippage-unsupported.js";
import { makeProtocolContext } from "../_test-context.js";

const BRIDGE_TOOL_IDS = ["relay.quote.get", "relay.bridge", "khalani.quote.get", "khalani.bridge"] as const;

function manifest(toolId: string) {
  const found = PROTOCOL_TOOLS.find((m) => m.toolId === toolId);
  if (!found) throw new Error(`manifest missing: ${toolId}`);
  return found;
}

function param(toolId: string, key: string) {
  const found = manifest(toolId).params.find((p) => p.key === key);
  if (!found) throw new Error(`param missing: ${toolId}.${key}`);
  return found;
}

const RELAY_PARAMS = {
  fromChain: "base",
  toChain: "robinhood",
  fromToken: "eth",
  toToken: "eth",
  amountRaw: "1000",
};

describe("W5b — the retired `amount` key is rejected by name on every bridge tool", () => {
  it.each(BRIDGE_TOOL_IDS)("%s declares amountRaw, never amount", (toolId) => {
    const keys = manifest(toolId).params.map((p) => p.key);
    expect(keys).toContain("amountRaw");
    expect(keys).not.toContain("amount");
  });

  it.each(BRIDGE_TOOL_IDS)("%s rejects a legacy `amount` and names amountRaw", (toolId) => {
    const result = validateProtocolParams(manifest(toolId), {
      fromChain: "base",
      toChain: "robinhood",
      fromToken: "eth",
      toToken: "eth",
      amount: "1000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("amount");
      expect(result.reason).toContain("amountRaw");
    }
  });

  it.each(BRIDGE_TOOL_IDS)("%s names TokenFind as the decimals source on amountRaw", (toolId) => {
    const amountRaw = param(toolId, "amountRaw");
    expect(amountRaw.type).toBe("string");
    expect(amountRaw.required).toBe(true);
    expect(amountRaw.description).toContain("TokenFind");
  });
});

describe("W3 — Relay slippage ingress is number + unit bps, and the gate runs", () => {
  const RELAY_TOOL_IDS = ["relay.quote.get", "relay.bridge"] as const;

  it.each(RELAY_TOOL_IDS)("%s declares slippageBps number + unit bps", (toolId) => {
    const slippageBps = param(toolId, "slippageBps");
    expect(slippageBps.type).toBe("number");
    expect(slippageBps.unit).toBe("bps");
    expect(slippageBps.description).toContain("1 bps = 0.01%");
  });

  it.each(RELAY_TOOL_IDS)("%s accepts a whole-number tolerance", (toolId) => {
    expect(validateProtocolParams(manifest(toolId), { ...RELAY_PARAMS, slippageBps: 100 }).ok).toBe(true);
  });

  it.each(RELAY_TOOL_IDS)("%s rejects the old STRING spelling", (toolId) => {
    const result = validateProtocolParams(manifest(toolId), { ...RELAY_PARAMS, slippageBps: "100" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("slippageBps");
  });

  it.each(RELAY_TOOL_IDS)("%s rejects a fractional bps value (the gate that never ran before)", (toolId) => {
    expect(validateProtocolParams(manifest(toolId), { ...RELAY_PARAMS, slippageBps: 50.5 }).ok).toBe(false);
  });

  it("rejects — never clamps — a value above Vex's ceiling", () => {
    const over = resolveRelaySlippageBps("Relay slippageBps", VEX_MAX_SLIPPAGE_BPS + 1);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain(String(VEX_MAX_SLIPPAGE_BPS));
  });
});

describe("W4a — the Relay default is materialized, and quote↔execute still collide", () => {
  const ctx = makeProtocolContext();

  it("an omitted slippage resolves to the Vex default rather than the provider's", () => {
    const resolved = resolveRelaySlippageBps("Relay slippageBps", undefined);
    expect(resolved).toEqual({ ok: true, bps: VEX_DEFAULT_SLIPPAGE_BPS });
  });

  it("binds the materialized default into the prequote identity", async () => {
    const identity = await buildRelayBridgeIdentity("s1", RELAY_PARAMS, ctx);
    expect(identity.slippageBps).toBe(String(VEX_DEFAULT_SLIPPAGE_BPS));
  });

  it("a quote that omits slippage and an execute that omits it collide", async () => {
    const quote = await buildRelayBridgeIdentity("s1", RELAY_PARAMS, ctx);
    const execute = await buildRelayBridgeIdentity("s1", { ...RELAY_PARAMS }, ctx);
    expect(execute).toEqual(quote);
  });

  it("an EXPLICIT default and an omitted one are the same identity (no double lane)", async () => {
    const omitted = await buildRelayBridgeIdentity("s1", RELAY_PARAMS, ctx);
    const explicit = await buildRelayBridgeIdentity(
      "s1",
      { ...RELAY_PARAMS, slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
      ctx,
    );
    expect(explicit).toEqual(omitted);
  });

  it("a DIFFERENT tolerance still produces a different identity", async () => {
    const base = await buildRelayBridgeIdentity("s1", RELAY_PARAMS, ctx);
    const wider = await buildRelayBridgeIdentity("s1", { ...RELAY_PARAMS, slippageBps: 200 }, ctx);
    expect(wider.slippageBps).not.toBe(base.slippageBps);
  });
});

describe("Khalani — slippageBps is refused BY NAME, not dropped", () => {
  const KHALANI_ROUTE = { fromChain: "base", toChain: "arbitrum" };

  it("refuses a Khalani-routed slippageBps and says no protection applies", async () => {
    const refusal = await khalaniSlippageRejection("BridgeQuote", { ...KHALANI_ROUTE, slippageBps: 100 });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("BridgeQuote");
    expect(refusal).toContain(KHALANI_SLIPPAGE_UNSUPPORTED_REASON);
    expect(refusal).toMatch(/NO slippage protection applies/);
  });

  it("refuses the STRING spelling too - the reason must not depend on the value's form", async () => {
    expect(await khalaniSlippageRejection("bridge", { ...KHALANI_ROUTE, slippageBps: "100" })).not.toBeNull();
  });

  it("says nothing when no slippage was supplied", async () => {
    expect(await khalaniSlippageRejection("BridgeQuote", KHALANI_ROUTE)).toBeNull();
  });

  it("leaves a RELAY-routed slippage alone (Relay does forward it)", async () => {
    expect(
      await khalaniSlippageRejection("bridge", { fromChain: "base", toChain: "robinhood", slippageBps: 100 }),
    ).toBeNull();
  });

  it("khalani.bridge declares no slippageBps at all", () => {
    expect(manifest("khalani.bridge").params.map((p) => p.key)).not.toContain("slippageBps");
  });
});

describe("W6 — khalani account-address params are named walletAddress", () => {
  it.each(["khalani.tokens.balances", "khalani.orders.list"] as const)("%s takes walletAddress", (toolId) => {
    const keys = manifest(toolId).params.map((p) => p.key);
    expect(keys).toContain("walletAddress");
    expect(keys).not.toContain("address");
  });
});
