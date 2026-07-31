/**
 * `acceptsStringArray` — the opt-in string|string[] param capability.
 *
 * THE DEFECT THIS CLOSES, measured in the persona gate
 *
 * `agents_dm/agentscan-phase4/persona-tests/call-records.json`, first record:
 * `dexscreener.profiles {chainIds: ["solana"], limit: 15}` → **78 bytes, ok:false**.
 * The identical call spelled `chainIds: "solana"` → 5,215 bytes of answer. A
 * context-free agent reading "comma-separated chain slugs" reasonably sends the
 * JSON array a JSON tool call makes natural, and burned a call finding out.
 *
 * THE CAPABILITY IS OPT-IN, AND THAT IS THE POINT
 *
 * `ProtocolParamDef.type` stays `"string"`; a param that genuinely means ONE
 * value (`query`, `slug`, `chainId`, `tokenAddress`) still REJECTS an array, so
 * widening is a per-param decision with a per-param reason rather than a blanket
 * loosening of the boundary. The declared flag is what the compiled provider
 * schema and the runtime gate both read.
 */

import { describe, expect, it } from "vitest";

import { normalizeToolSchemaForProvider } from "@vex-agent/inference/schema-normalizer.js";
import { paramsToJsonSchema } from "@vex-agent/tools/registry/khalani.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import { coerceStringArrayParams } from "@vex-agent/tools/protocols/runtime/string-array-coercion.js";
import type {
  ProtocolParamDef,
  ProtocolToolManifest,
} from "@vex-agent/tools/protocols/types.js";
import type { JsonSchemaProperty } from "@vex-agent/tools/types.js";

const LIST_PARAM: ProtocolParamDef = {
  key: "chainIds",
  type: "string",
  acceptsStringArray: true,
  description: "Comma-separated chain slugs, or an array of them.",
};

const SINGLE_PARAM: ProtocolParamDef = {
  key: "query",
  type: "string",
  required: true,
  description: "One thing to match.",
};

const MANIFEST: ProtocolToolManifest = {
  toolId: "test.string_array",
  namespace: "dexscreener",
  lifecycle: "active",
  description: "Fixture manifest for the string|string[] boundary.",
  mutating: false,
  actionKind: "read",
  params: [SINGLE_PARAM, LIST_PARAM],
  exampleParams: { query: "PEPE" },
};

function rejectionFor(params: Record<string, unknown>): string {
  const outcome = validateProtocolParams(MANIFEST, params);
  expect(outcome.ok, `expected rejection for ${JSON.stringify(params)}`).toBe(false);
  return outcome.ok ? "" : outcome.reason;
}

describe("acceptsStringArray — runtime param boundary", () => {
  it("accepts BOTH spellings on an opt-in param", () => {
    expect(validateProtocolParams(MANIFEST, { query: "PEPE", chainIds: "solana,base" }).ok).toBe(true);
    expect(validateProtocolParams(MANIFEST, { query: "PEPE", chainIds: ["solana", "base"] }).ok).toBe(true);
  });

  it("REJECTS an array on a param that was not opted in, naming the parameter", () => {
    const reason = rejectionFor({ query: ["PEPE", "WIF"] });
    expect(reason).toContain("query");
    // "got object" is what `typeof []` yields and is actively misleading here.
    expect(reason).toContain("array");
  });

  it("rejects a non-string member BY POSITION rather than coercing it", () => {
    const reason = rejectionFor({ query: "PEPE", chainIds: ["solana", 5, "base"] });
    expect(reason).toContain("chainIds");
    expect(reason).toContain("index 1");
    expect(reason).toContain("number");
  });

  it("rejects an empty array instead of reading it as 'no filter'", () => {
    const reason = rejectionFor({ query: "PEPE", chainIds: [] });
    expect(reason).toContain("chainIds");
    expect(reason).toMatch(/empty array/i);
  });

  it("still rejects a non-string, non-array value", () => {
    expect(rejectionFor({ query: "PEPE", chainIds: 5 })).toContain("chainIds");
    expect(rejectionFor({ query: "PEPE", chainIds: { solana: true } })).toContain("chainIds");
  });

  it("is a validation gate only — the params object reaching the handler is untouched", () => {
    const params: Record<string, unknown> = { query: "PEPE", chainIds: ["solana"] };
    const snapshot = JSON.stringify(params);
    expect(validateProtocolParams(MANIFEST, params).ok).toBe(true);
    expect(JSON.stringify(params)).toBe(snapshot);
  });
});

describe("acceptsStringArray — a JSON array that arrived as a string", () => {
  // Live session 2026-07-30: a model sent `chainIds: "[\"robinhood\"]"` — the
  // array spelling, JSON-encoded into the string branch of the union. It passes
  // the type gate as a string and then reaches the comma-splitting reader,
  // which reads the literal `["robinhood"]` as a chain slug: a silent wrong
  // answer, which is the one outcome this param family exists to prevent.
  it("parses a JSON-encoded array on an opt-in param", () => {
    const coerced = coerceStringArrayParams(MANIFEST, {
      query: "robinhood",
      chainIds: '["robinhood"]',
    });
    expect(coerced.params).toEqual({ query: "robinhood", chainIds: ["robinhood"] });
    expect(coerced.coercedKeys).toEqual(["chainIds"]);
    expect(validateProtocolParams(MANIFEST, coerced.params).ok).toBe(true);
  });

  it("leaves an ordinary comma string and a real array alone", () => {
    const params = { query: "PEPE", chainIds: "solana,base" };
    expect(coerceStringArrayParams(MANIFEST, params).params).toEqual(params);
    const arrayParams = { query: "PEPE", chainIds: ["solana"] };
    expect(coerceStringArrayParams(MANIFEST, arrayParams).params).toEqual(arrayParams);
  });

  it("never widens a param that was NOT opted in", () => {
    const params = { query: '["PEPE","WIF"]' };
    expect(coerceStringArrayParams(MANIFEST, params).params).toEqual(params);
  });

  it("leaves anything that is not a JSON array of strings untouched", () => {
    for (const value of ['[1,2]', "[not json", '["a", 2]', '{"a":1}', "[", "solana"]) {
      const params = { query: "PEPE", chainIds: value };
      expect(coerceStringArrayParams(MANIFEST, params).params, value).toEqual(params);
    }
  });

  it("does not mutate the input params object", () => {
    const params: Record<string, unknown> = { query: "PEPE", chainIds: '["solana"]' };
    coerceStringArrayParams(MANIFEST, params);
    expect(params.chainIds).toBe('["solana"]');
  });
});

describe("acceptsStringArray — compiled provider schema", () => {
  function propertyOf(key: string): JsonSchemaProperty {
    const property = paramsToJsonSchema(MANIFEST.params).properties[key];
    if (property === undefined) throw new Error(`no compiled property for ${key}`);
    return property;
  }

  it("compiles an opt-in param to an anyOf union with NO outer type", () => {
    const property = propertyOf("chainIds");
    // Emitting `type: "string"` beside the union would make the array branch
    // invalid by conjunction under every strict validator.
    expect("type" in property).toBe(false);
    expect(property.anyOf).toEqual([
      { type: "string" },
      { type: "array", items: { type: "string" } },
    ]);
  });

  it("leaves an ordinary param as a plain typed property", () => {
    expect(propertyOf("query")).toEqual({ type: "string", description: SINGLE_PARAM.description });
  });

  it("the union SURVIVES provider strict-mode normalization", () => {
    const normalized = normalizeToolSchemaForProvider(paramsToJsonSchema(MANIFEST.params));
    const property = normalized.properties.chainIds;
    expect(property).toBeDefined();
    if (property === undefined) return;
    expect("type" in property).toBe(false);
    // The normalizer must walk INTO the branches: the array branch keeps its
    // `items`, and no branch acquires a bogus `type`.
    expect(property.anyOf).toEqual([
      { type: "string" },
      { type: "array", items: { type: "string" } },
    ]);
  });

  it("normalization stays idempotent over a union property", () => {
    const once = normalizeToolSchemaForProvider(paramsToJsonSchema(MANIFEST.params));
    expect(normalizeToolSchemaForProvider(once)).toEqual(once);
  });

  it("injects the default items schema into a bare array branch", () => {
    const normalized = normalizeToolSchemaForProvider({
      type: "object",
      properties: { tags: { anyOf: [{ type: "string" }, { type: "array" }] } },
    });
    expect(normalized.properties.tags?.anyOf?.[1]).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });
});
