/**
 * The action-alias PARAM descriptions are the only instruction the model gets
 * before it fills a parameter in, so each one has to be true of the code that
 * receives it.
 *
 * Two drifts this suite pins:
 *
 *  1. CHAIN. `token_find` returns `chainId` as a NUMBER, and the swap/token
 *     aliases now accept that form (`internal/chain-param.ts`). The menu still
 *     described only slugs, so the agent had no way to know the id it was
 *     already holding was acceptable.
 *  2. RELAY SLIPPAGE. Both hidden Relay bridge aliases said only "Slippage
 *     tolerance in basis points." — no unit anchor, no statement of what it
 *     protects, and no mention of the ceiling. Every swap surface documents the
 *     1000-bps cap; the bridge enforces the SAME cap (`relay/handlers/bridge.ts`
 *     → `parseSlippageBpsString` → `checkSlippageBps` with no venue maximum,
 *     so `VEX_MAX_SLIPPAGE_BPS` binds) and said nothing about it.
 *
 * A documented cap is only worth writing if the code enforces it, so the last
 * block drives the REAL parser the Relay handler calls rather than trusting the
 * sentence.
 */

import { describe, it, expect } from "vitest";

import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";
import {
  parseSlippageBpsString,
  VEX_MAX_SLIPPAGE_BPS,
} from "@vex-agent/tools/protocols/slippage-policy.js";

interface JsonSchemaParam {
  readonly type?: string;
  readonly description?: string;
}

function paramOf(toolName: string, key: string): JsonSchemaParam {
  const tool = ACTION_ALIAS_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`no alias tool named ${toolName}`);
  const properties = (tool.parameters as { properties?: Record<string, JsonSchemaParam> }).properties;
  const param = properties?.[key];
  if (!param) throw new Error(`${toolName} declares no "${key}" param`);
  return param;
}

const CHAIN_FORMS_SENTENCE =
  "Accepts a chain slug/alias or the numeric chain id token_find returns (e.g. base or 8453).";

describe("chain params — the menu must admit the form token_find hands back", () => {
  for (const toolName of ["swap_quote", "swap_execute"]) {
    it(`${toolName} tells the agent a numeric chain id is accepted`, () => {
      expect(paramOf(toolName, "chain").description).toContain(CHAIN_FORMS_SENTENCE);
    });
  }

  it("token_check tells the agent the same", () => {
    expect(paramOf("token_check", "chain").description).toContain(CHAIN_FORMS_SENTENCE);
  });
});

const RELAY_BRIDGE_ALIASES = ["bridge_quote_relay", "bridge_execute_relay"] as const;

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

    it(`${toolName} keeps slippageBps declared as a STRING — the handler reads it with str()`, () => {
      // `relay/handlers/bridge.ts` resolves it via `str(params, "slippageBps")`,
      // which yields "" for a JSON number and would treat it as ABSENT (Relay's
      // own default), silently discarding the tolerance the agent asked for.
      // Both alias routers also validate it as `z.string()`. Advertising
      // `number` here to match the swap aliases would make every numeric attempt
      // fail at the router — the declared type must stay the enforced one.
      expect(paramOf(toolName, "slippageBps").type).toBe("string");
    });
  }
});

describe("the documented Relay ceiling is the one the code enforces", () => {
  // The exact parser `resolveSlippageBps` calls before anything reaches Relay.
  const subject = 'Parameter "slippageBps" for relay.bridge';

  it("accepts the documented ceiling", () => {
    expect(parseSlippageBpsString(subject, String(VEX_MAX_SLIPPAGE_BPS))).toEqual({
      ok: true,
      bps: VEX_MAX_SLIPPAGE_BPS,
    });
  });

  it("REJECTS one basis point above it — never clamps to the ceiling", () => {
    const parsed = parseSlippageBpsString(subject, String(VEX_MAX_SLIPPAGE_BPS + 1));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain("must not exceed 1000 basis points");
  });

  it("REJECTS a fractional or signed literal rather than coercing it", () => {
    expect(parseSlippageBpsString(subject, "50.5").ok).toBe(false);
    expect(parseSlippageBpsString(subject, "-50").ok).toBe(false);
  });
});
