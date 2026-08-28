/**
 * The action-alias PARAM schemas are the only instruction the model gets before
 * it fills a parameter in, so each one has to be true of the code that receives
 * it — AND of the protocol manifest the alias forwards to.
 *
 * Three things this suite pins:
 *
 *  1. CHAIN. `TokenFind` returns `chainId` as a NUMBER, and the swap/token
 *     aliases now accept that form (`internal/chain-param.ts`). The menu still
 *     described only slugs, so the agent had no way to know the id it was
 *     already holding was acceptable.
 *  2. RELAY SLIPPAGE. Both hidden Relay bridge aliases said only "Slippage
 *     tolerance in basis points." — no unit anchor, no statement of what it
 *     protects, and no mention of the ceiling. The bridge enforces the same
 *     1000-bps cap the swap surfaces do (`relay/handlers/bridge/legs.ts` →
 *     `resolveRelaySlippageBps`), so the last block drives that REAL resolver
 *     rather than trusting the sentence.
 *  3. LANE PARITY (SPEC §1.1–§1.4, waves W5/W6). Every alias is a second, hand
 *     written spelling of a protocol manifest's params. The audit's D9/D10
 *     drifts existed because only one lane was ever pinned: the alias said
 *     `amount` while the manifest said `amountRaw`, or declared `string` where
 *     the manifest declared `number`. The parity block below asserts BOTH
 *     directions — every key the alias advertises exists on the target with the
 *     same declared type, and every REQUIRED key of the target is advertised by
 *     the alias — so a rename that lands on one lane fails the suite until it
 *     lands on the other.
 */

import { describe, it, expect } from "vitest";

import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";
import { WALLET_TOOLS } from "@vex-agent/tools/registry/wallet.js";
import { WALLET_TRANSACTION_TOOLS } from "@vex-agent/tools/registry/wallet-transaction.js";
import { WALLET_WRAP_TOOLS } from "@vex-agent/tools/registry/wallet-wrap.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import {
  resolveRelaySlippageBps,
  VEX_MAX_SLIPPAGE_BPS,
} from "@vex-agent/tools/protocols/slippage-policy.js";
import { BANNED_PARAM_KEYS } from "@vex-agent/tools/protocols/conventions.js";
import type { ToolDef } from "@vex-agent/tools/types.js";

interface JsonSchemaParam {
  readonly type?: string;
  readonly description?: string;
  readonly anyOf?: readonly { readonly type?: string }[];
}

function toolDefOf(toolName: string): ToolDef {
  const tool = [...ACTION_ALIAS_TOOLS, ...WALLET_TOOLS, ...WALLET_TRANSACTION_TOOLS, ...WALLET_WRAP_TOOLS].find(
    (t) => t.name === toolName,
  );
  if (!tool) throw new Error(`no alias/wallet tool named ${toolName}`);
  return tool;
}

function schemaPropertiesOf(toolName: string): Record<string, JsonSchemaParam> {
  const properties = (toolDefOf(toolName).parameters as {
    properties?: Record<string, JsonSchemaParam>;
  }).properties;
  return properties ?? {};
}

function requiredKeysOf(toolName: string): readonly string[] {
  const required = (toolDefOf(toolName).parameters as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((k): k is string => typeof k === "string") : [];
}

function paramOf(toolName: string, key: string): JsonSchemaParam {
  const param = schemaPropertiesOf(toolName)[key];
  if (!param) throw new Error(`${toolName} declares no "${key}" param`);
  return param;
}

const CHAIN_FORMS_SENTENCE =
  "Accepts a chain slug/alias or the numeric chain id TokenFind returns (e.g. base or 8453).";

describe("chain params — the menu must admit the form TokenFind hands back", () => {
  for (const toolName of ["SwapQuote", "SwapExecute"]) {
    it(`${toolName} tells the agent a numeric chain id is accepted`, () => {
      expect(paramOf(toolName, "chain").description).toContain(CHAIN_FORMS_SENTENCE);
    });
  }

  it("TokenCheck tells the agent the same", () => {
    expect(paramOf("TokenCheck", "chain").description).toContain(CHAIN_FORMS_SENTENCE);
  });
});

const RELAY_BRIDGE_ALIASES = ["BridgeQuoteRelay", "BridgeExecuteRelay"] as const;

describe("Relay bridge slippageBps — what it protects, and the ceiling it is held to", () => {
  for (const toolName of RELAY_BRIDGE_ALIASES) {
    it(`${toolName} says which side of the bridge the tolerance applies to`, () => {
      const description = paramOf(toolName, "slippageBps").description ?? "";
      expect(description).toContain("destination-side fill");
      expect(description).toContain("1 bps = 0.01%");
      expect(description).toContain("worst-case received amount on the destination chain");
    });

    it(`${toolName} names the retry that can actually succeed`, () => {
      const description = paramOf(toolName, "slippageBps").description ?? "";
      expect(description).toContain("re-quote with a higher value rather than retrying the same one");
    });

    it(`${toolName} states the ceiling AND that it rejects rather than clamps`, () => {
      const description = paramOf(toolName, "slippageBps").description ?? "";
      expect(description).toContain(
        `Vex caps it at ${VEX_MAX_SLIPPAGE_BPS} (10%) and rejects anything above rather than clamping.`,
      );
    });

    it(`${toolName} declares slippageBps as a NUMBER — the type the resolver enforces`, () => {
      // W3: the Relay lane was the fleet's only `type: "string"` slippage, which
      // meant the manifest `unit: "bps"` gate never ran on it. Both the relay
      // manifests and `resolveRelaySlippageBps` now take a number and REJECT a
      // string by name, so advertising `string` here would make every honest
      // attempt fail at the boundary.
      expect(paramOf(toolName, "slippageBps").type).toBe("number");
    });
  }
});

describe("the documented Relay ceiling is the one the code enforces", () => {
  // The exact resolver both Relay lanes call before anything reaches Relay.
  const subject = 'Parameter "slippageBps" for relay.bridge';

  it("accepts the documented ceiling", () => {
    expect(resolveRelaySlippageBps(subject, VEX_MAX_SLIPPAGE_BPS)).toEqual({
      ok: true,
      bps: VEX_MAX_SLIPPAGE_BPS,
    });
  });

  it("REJECTS one basis point above it — never clamps to the ceiling", () => {
    const parsed = resolveRelaySlippageBps(subject, VEX_MAX_SLIPPAGE_BPS + 1);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain("must not exceed 1000 basis points");
  });

  it("REJECTS a fractional, signed, or string literal rather than coercing it", () => {
    expect(resolveRelaySlippageBps(subject, 50.5).ok).toBe(false);
    expect(resolveRelaySlippageBps(subject, -50).ok).toBe(false);
    expect(resolveRelaySlippageBps(subject, "50").ok).toBe(false);
  });
});

// ── Lane parity: alias schema ↔ protocol manifest ────────────────────

/**
 * Every alias that forwards to protocol tools, with the keys it translates
 * VERBATIM (same name on both lanes). A key the alias renames on the way
 * through — e.g. `SwapQuote`'s Solana branch — is deliberately absent: parity
 * is asserted only where the two lanes claim to speak the same vocabulary.
 */
const ALIAS_PARITY: readonly {
  readonly alias: string;
  readonly toolIds: readonly string[];
  readonly sharedKeys: readonly string[];
}[] = [
  {
    alias: "SwapQuote",
    toolIds: ["kyberswap.swap.quote"],
    sharedKeys: ["chain", "tokenIn", "tokenOut", "amountIn", "slippageBps"],
  },
  {
    alias: "SwapExecute",
    toolIds: ["kyberswap.swap.execute"],
    sharedKeys: ["chain", "tokenIn", "tokenOut", "amountIn", "slippageBps"],
  },
  {
    alias: "SwapQuoteUniswap",
    toolIds: ["uniswap.swap.quote"],
    sharedKeys: ["chain", "tokenIn", "tokenOut", "amountIn", "slippageBps"],
  },
  {
    alias: "SwapExecuteUniswap",
    toolIds: ["uniswap.swap.execute"],
    sharedKeys: ["chain", "tokenIn", "tokenOut", "amountIn", "slippageBps"],
  },
  {
    alias: "BridgeExecute",
    toolIds: ["khalani.bridge", "relay.bridge"],
    sharedKeys: ["fromChain", "fromToken", "toChain", "toToken", "amountRaw"],
  },
  {
    alias: "BridgeQuote",
    toolIds: ["khalani.quote.get", "relay.quote.get"],
    sharedKeys: ["fromChain", "fromToken", "toChain", "toToken", "amountRaw"],
  },
  {
    alias: "BridgeQuoteRelay",
    toolIds: ["relay.quote.get"],
    sharedKeys: ["fromChain", "fromToken", "toChain", "toToken", "amountRaw", "slippageBps"],
  },
  {
    alias: "BridgeExecuteRelay",
    toolIds: ["relay.bridge"],
    sharedKeys: ["fromChain", "fromToken", "toChain", "toToken", "amountRaw", "slippageBps"],
  },
];

function manifestParam(toolId: string, key: string) {
  const manifest = getProtocolManifest(toolId);
  if (!manifest) throw new Error(`no protocol manifest for ${toolId}`);
  return manifest.params.find((param) => param.key === key);
}

describe("alias ↔ protocol parity — one rename must land on BOTH lanes", () => {
  for (const { alias, toolIds, sharedKeys } of ALIAS_PARITY) {
    for (const toolId of toolIds) {
      it(`${alias} → ${toolId}: every shared key exists on both lanes with the same type`, () => {
        for (const key of sharedKeys) {
          const aliasParam = paramOf(alias, key);
          const target = manifestParam(toolId, key);
          expect(target, `${toolId} declares no "${key}" (alias ${alias} sends it)`).toBeDefined();
          expect(aliasParam.type, `${alias}.${key} vs ${toolId}.${key}`).toBe(target?.type);
        }
      });

      it(`${alias} → ${toolId}: every REQUIRED target param is advertised by the alias`, () => {
        const manifest = getProtocolManifest(toolId);
        if (!manifest) throw new Error(`no protocol manifest for ${toolId}`);
        const aliasKeys = new Set(Object.keys(schemaPropertiesOf(alias)));
        for (const param of manifest.params) {
          if (param.required !== true) continue;
          expect(
            aliasKeys.has(param.key),
            `${alias} cannot fill ${toolId}'s required "${param.key}"`,
          ).toBe(true);
        }
      });
    }

    it(`${alias} declares no retired param spelling`, () => {
      for (const key of Object.keys(schemaPropertiesOf(alias))) {
        expect(BANNED_PARAM_KEYS.has(key), `${alias} still declares banned key "${key}"`).toBe(false);
      }
    });
  }
});

// ── The wallet lane (W5d / W6c) ──────────────────────────────────────

describe("wallet tools speak the same param vocabulary as everything else", () => {
  it("WalletSendPrepare takes amountIn in HUMAN decimals, and no bare `amount`", () => {
    const properties = schemaPropertiesOf("WalletSendPrepare");
    expect(properties.amount).toBeUndefined();
    expect(properties.amountIn?.type).toBe("string");
    expect(properties.amountIn?.description).toContain("HUMAN decimal units");
    expect(requiredKeysOf("WalletSendPrepare")).toContain("amountIn");
  });

  for (const toolName of ["WalletSendPrepare", "WalletSendConfirm"]) {
    it(`${toolName} selects a wallet FAMILY through walletFamily, never \`network\``, () => {
      const properties = schemaPropertiesOf(toolName);
      expect(properties.network).toBeUndefined();
      expect(properties.walletFamily?.type).toBe("string");
      expect(requiredKeysOf(toolName)).toContain("walletFamily");
    });
  }

  it("WalletBalances scopes by walletFamily, never `wallet`", () => {
    const properties = schemaPropertiesOf("WalletBalances");
    expect(properties.wallet).toBeUndefined();
    expect(properties.walletFamily?.type).toBe("string");
  });

  it("WalletBalances.chainIds accepts a CSV string OR an array of chains", () => {
    const branches = paramOf("WalletBalances", "chainIds").anyOf ?? [];
    expect(branches.map((branch) => branch.type)).toEqual(["string", "array"]);
  });

  it("no wallet tool declares a retired param spelling", () => {
    for (const tool of [...WALLET_TOOLS, ...WALLET_TRANSACTION_TOOLS, ...WALLET_WRAP_TOOLS]) {
      for (const key of Object.keys(schemaPropertiesOf(tool.name))) {
        expect(BANNED_PARAM_KEYS.has(key), `${tool.name} still declares banned key "${key}"`).toBe(
          false,
        );
      }
    }
  });
});
