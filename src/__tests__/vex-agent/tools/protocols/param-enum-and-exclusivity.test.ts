/**
 * W7 schema expressiveness at the param boundary (SPEC §1.7):
 * `ProtocolParamDef.enum`, `ProtocolToolManifest.exclusiveParamGroups`, and the
 * W6f chain number→string normalization.
 *
 * Each rejection is asserted on its TEXT, not just its falseness: the whole
 * point of these gates is that the agent can fix the call from the message
 * without spending another discovery.
 */

import { describe, it, expect } from "vitest";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import { paramsToJsonSchema } from "@vex-agent/tools/registry/khalani.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

function manifest(overrides: Partial<ProtocolToolManifest>): ProtocolToolManifest {
  return {
    toolId: "test.tool",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "test manifest",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    ...overrides,
  };
}

describe("ProtocolParamDef.enum", () => {
  const ENUM_MANIFEST = manifest({
    params: [
      { key: "chain", type: "string", required: true, description: "chain", enum: ["BASE", "SOLANA"] },
    ],
    exampleParams: { chain: "BASE" },
  });

  it("accepts a listed value", () => {
    expect(validateProtocolParams(ENUM_MANIFEST, { chain: "BASE" })).toEqual({ ok: true });
  });

  it("rejects an off-list value NAMING the allowed values", () => {
    const result = validateProtocolParams(ENUM_MANIFEST, { chain: "base" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Allowed values for "chain" on test.tool: BASE, SOLANA');
    expect(result.reason).toContain("case-sensitive");
  });

  it("never echoes the value the model sent", () => {
    const result = validateProtocolParams(ENUM_MANIFEST, { chain: "0xdeadbeefsecret" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain("0xdeadbeef");
  });

  it("checks every member of an array-valued param, by position", () => {
    const listManifest = manifest({
      params: [
        {
          key: "chainIds",
          type: "string",
          description: "chains",
          acceptsStringArray: true,
          enum: ["base", "solana"],
        },
      ],
    });
    expect(validateProtocolParams(listManifest, { chainIds: ["base", "solana"] })).toEqual({ ok: true });
    const result = validateProtocolParams(listManifest, { chainIds: ["base", "ethereum"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("index 1");
    expect(result.reason).toContain("base, solana");
  });

  it("compiles into the JSON schema enum keyword", () => {
    const property = paramsToJsonSchema(ENUM_MANIFEST.params).properties.chain;
    expect(property).toEqual({ type: "string", description: "chain", enum: ["BASE", "SOLANA"] });
  });

  it("compiles onto BOTH branches of an acceptsStringArray union", () => {
    const property = paramsToJsonSchema([
      { key: "chainIds", type: "string", description: "chains", acceptsStringArray: true, enum: ["base"] },
    ]).properties.chainIds;
    expect(property).toEqual({
      anyOf: [
        { type: "string", enum: ["base"] },
        { type: "array", items: { type: "string", enum: ["base"] } },
      ],
      description: "chains",
    });
  });

  it("leaves a param without an enum untouched in the compiled schema", () => {
    const property = paramsToJsonSchema([
      { key: "query", type: "string", description: "text" },
    ]).properties.query;
    expect(property).toEqual({ type: "string", description: "text" });
  });
});

describe("ProtocolToolManifest.exclusiveParamGroups", () => {
  const XOR_MANIFEST = manifest({
    params: [
      { key: "tokenAddress", type: "string", description: "a token contract" },
      { key: "pairAddress", type: "string", description: "a pair contract" },
    ],
    exclusiveParamGroups: [["tokenAddress", "pairAddress"]],
  });

  it("accepts exactly one member", () => {
    expect(validateProtocolParams(XOR_MANIFEST, { tokenAddress: "0xabc" })).toEqual({ ok: true });
    expect(validateProtocolParams(XOR_MANIFEST, { pairAddress: "0xabc" })).toEqual({ ok: true });
  });

  it("rejects BOTH members naming the group, not one offending key", () => {
    const result = validateProtocolParams(XOR_MANIFEST, { tokenAddress: "0xa", pairAddress: "0xb" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Provide exactly one of: tokenAddress, pairAddress.");
    expect(result.reason).toContain("you sent 2: [tokenAddress, pairAddress]");
  });

  it("rejects an empty group the same way — the agent needs to know WHICH to add", () => {
    const result = validateProtocolParams(XOR_MANIFEST, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Provide exactly one of: tokenAddress, pairAddress.");
    expect(result.reason).toContain("none of them is set");
  });

  it("is inert on a manifest that declares no groups", () => {
    expect(validateProtocolParams(manifest({}), {})).toEqual({ ok: true });
  });
});

describe("W6f chain number→string normalization", () => {
  const CHAIN_MANIFEST = manifest({
    params: [
      { key: "chain", type: "string", required: true, description: "chain slug or numeric id" },
      { key: "query", type: "string", description: "search text" },
    ],
  });

  it("accepts a JSON number for a chain param and hands the handler the string", () => {
    const params: Record<string, unknown> = { chain: 8453 };
    expect(validateProtocolParams(CHAIN_MANIFEST, params)).toEqual({ ok: true });
    expect(params.chain).toBe("8453");
  });

  it("normalizes every chain-valued key in the allowlist", () => {
    const bridgeManifest = manifest({
      params: [
        { key: "fromChain", type: "string", required: true, description: "source" },
        { key: "toChain", type: "string", required: true, description: "destination" },
      ],
    });
    const params: Record<string, unknown> = { fromChain: 1, toChain: 8453 };
    expect(validateProtocolParams(bridgeManifest, params)).toEqual({ ok: true });
    expect(params).toEqual({ fromChain: "1", toChain: "8453" });
  });

  it("still REJECTS a number for a non-chain string param", () => {
    const params: Record<string, unknown> = { chain: "base", query: 8453 };
    const result = validateProtocolParams(CHAIN_MANIFEST, params);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Parameter "query" for test.tool has invalid type');
    expect(params.query).toBe(8453);
  });

  it("does not touch a chain param that is already a string", () => {
    const params: Record<string, unknown> = { chain: "base" };
    expect(validateProtocolParams(CHAIN_MANIFEST, params)).toEqual({ ok: true });
    expect(params.chain).toBe("base");
  });

  it("leaves a non-integer or non-positive chain number to the type gate", () => {
    for (const bad of [8453.5, 0, -1]) {
      const params: Record<string, unknown> = { chain: bad };
      const result = validateProtocolParams(CHAIN_MANIFEST, params);
      expect(result.ok, `chain: ${bad}`).toBe(false);
      expect(params.chain).toBe(bad);
    }
  });
});
