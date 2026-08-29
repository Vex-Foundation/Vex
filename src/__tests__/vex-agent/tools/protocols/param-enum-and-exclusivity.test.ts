/**
 * W7 schema expressiveness at the param boundary (SPEC §1.7):
 * `ProtocolParamDef.enum`, the three cross-param group fields
 * (`exclusiveParamGroups` / `atMostOne` / `atLeastOneOf`), the chain
 * normalizations (number→string, and enum case-folding), and the banned-key
 * replacement naming on an unknown key.
 *
 * Each rejection is asserted on its TEXT, not just its falseness: the whole
 * point of these gates is that the agent can fix the call from the message
 * without spending another discovery.
 */

import { describe, it, expect } from "vitest";
import {
  describeParamGroupConstraints,
  validateProtocolParams,
} from "@vex-agent/tools/protocols/runtime/params.js";
import { paramsToJsonSchema } from "@vex-agent/tools/registry/khalani.js";
import { lintExclusiveParamGroups } from "@vex-agent/tools/protocols/_manifest-lint/rules.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

function manifest(overrides: Partial<ProtocolToolManifest>): ProtocolToolManifest {
  return {
    toolId: "test.tool",
    publicName: "test__tool",
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

  // `chain: "base"` was this assertion's original input and is now ACCEPTED —
  // chain values fold case (see "chain-value enum case folding" below). The
  // rule it proves is unchanged, so it is proven on an off-list value instead.
  it("rejects an off-list value NAMING the allowed values", () => {
    const result = validateProtocolParams(ENUM_MANIFEST, { chain: "arbitrum" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Allowed values for "chain" on test__tool: BASE, SOLANA');
  });

  it("matches case-sensitively on any param that is not a chain value", () => {
    const windowManifest = manifest({
      params: [{ key: "statsInterval", type: "string", description: "window", enum: ["1h"] }],
    });
    const result = validateProtocolParams(windowManifest, { statsInterval: "1H" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
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
    expect(result.reason).toContain('Parameter "query" for test__tool has invalid type');
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

describe("ProtocolToolManifest.atMostOne", () => {
  const LEG_MANIFEST = manifest({
    params: [
      { key: "depositAmountRaw", type: "string", description: "add collateral" },
      { key: "withdrawAmountRaw", type: "string", description: "remove collateral" },
      { key: "withdrawAll", type: "boolean", description: "remove all collateral" },
    ],
    atMostOne: [["depositAmountRaw", "withdrawAmountRaw", "withdrawAll"]],
  });

  it("accepts ZERO members — the whole reason this is not exclusiveParamGroups", () => {
    expect(validateProtocolParams(LEG_MANIFEST, {})).toEqual({ ok: true });
  });

  it("accepts exactly one member", () => {
    expect(validateProtocolParams(LEG_MANIFEST, { withdrawAll: true })).toEqual({ ok: true });
  });

  it("rejects MULTIPLE members naming the group and the rule", () => {
    const result = validateProtocolParams(LEG_MANIFEST, {
      depositAmountRaw: "1", withdrawAll: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(
      "Provide at most one of: depositAmountRaw, withdrawAmountRaw, withdrawAll.",
    );
    expect(result.reason).toContain("you sent 2: [depositAmountRaw, withdrawAll]");
  });

  it("never echoes a value on the you-sent lane", () => {
    const result = validateProtocolParams(LEG_MANIFEST, {
      depositAmountRaw: "999666333", withdrawAmountRaw: "1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain("999666333");
  });

  it("is inert on a manifest that declares no groups", () => {
    expect(validateProtocolParams(manifest({}), {})).toEqual({ ok: true });
  });
});

describe("ProtocolToolManifest.atLeastOneOf", () => {
  const ANY_LEG_MANIFEST = manifest({
    params: [
      { key: "depositAmountRaw", type: "string", description: "add collateral" },
      { key: "borrowAmountRaw", type: "string", description: "borrow debt" },
    ],
    atLeastOneOf: [["depositAmountRaw", "borrowAmountRaw"]],
  });

  it("rejects ZERO members, listing every key that would have worked", () => {
    const result = validateProtocolParams(ANY_LEG_MANIFEST, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(
      "Provide at least one of: depositAmountRaw, borrowAmountRaw.",
    );
    expect(result.reason).toContain("this call would do nothing");
  });

  it("accepts one member", () => {
    expect(validateProtocolParams(ANY_LEG_MANIFEST, { borrowAmountRaw: "1" })).toEqual({ ok: true });
  });

  it("accepts MULTIPLE members — at-least-one puts no ceiling on the call", () => {
    expect(validateProtocolParams(ANY_LEG_MANIFEST, {
      depositAmountRaw: "1", borrowAmountRaw: "2",
    })).toEqual({ ok: true });
  });

  it("treats null / empty string as absent, exactly like the required gate", () => {
    const result = validateProtocolParams(ANY_LEG_MANIFEST, {
      depositAmountRaw: "", borrowAmountRaw: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Provide at least one of");
  });
});

describe("solana.lend.borrowOperate adoption", () => {
  const BORROW_OPERATE = getProtocolManifest("solana.lend.borrowOperate");

  function validate(params: Record<string, unknown>) {
    if (!BORROW_OPERATE) throw new Error("solana.lend.borrowOperate manifest is missing");
    return validateProtocolParams(BORROW_OPERATE, { vaultId: 1, ...params });
  }

  it("allows the legal opposite-direction combinations", () => {
    expect(validate({ depositAmountRaw: "1", borrowAmountRaw: "2" })).toEqual({ ok: true });
    expect(validate({ withdrawAmountRaw: "1", repayAmountRaw: "2" })).toEqual({ ok: true });
    expect(validate({ withdrawAll: true, repayAll: true })).toEqual({ ok: true });
  });

  it("allows a single-leg call — collateral only, debt untouched", () => {
    expect(validate({ depositAmountRaw: "1" })).toEqual({ ok: true });
    expect(validate({ repayAll: true })).toEqual({ ok: true });
  });

  it("rejects two params on the same leg", () => {
    const result = validate({ depositAmountRaw: "1", withdrawAll: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Provide at most one of: depositAmountRaw, withdrawAmountRaw, withdrawAll.");
  });

  it("rejects the SAME-DIRECTION combinations the handler refuses, at the boundary", () => {
    // Both legs move money IN (deposit collateral + repay debt).
    const inbound = validate({ depositAmountRaw: "1", repayAmountRaw: "2" });
    expect(inbound.ok).toBe(false);
    if (!inbound.ok) {
      expect(inbound.reason).toContain("Provide at most one of: depositAmountRaw, repayAmountRaw, repayAll.");
    }
    // Both legs move money OUT (withdraw collateral + borrow debt).
    const outbound = validate({ withdrawAmountRaw: "1", borrowAmountRaw: "2" });
    expect(outbound.ok).toBe(false);
    if (!outbound.ok) {
      expect(outbound.reason).toContain("Provide at most one of: withdrawAmountRaw, withdrawAll, borrowAmountRaw.");
    }
  });

  it("rejects the empty call naming all six legs", () => {
    const result = validate({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(
      "Provide at least one of: depositAmountRaw, withdrawAmountRaw, withdrawAll, "
      + "borrowAmountRaw, repayAmountRaw, repayAll.",
    );
  });
});

describe("solana.prices adoption", () => {
  const PRICES = getProtocolManifest("solana.prices");

  it("declares mints/queries as exactly-one, matching the handler", () => {
    if (!PRICES) throw new Error("solana.prices manifest is missing");
    expect(validateProtocolParams(PRICES, { mints: "So111" })).toEqual({ ok: true });
    expect(validateProtocolParams(PRICES, { queries: "SOL" })).toEqual({ ok: true });
    for (const bad of [{}, { mints: "So111", queries: "SOL" }]) {
      const result = validateProtocolParams(PRICES, { ...bad });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain("Provide exactly one of: mints, queries.");
    }
  });
});

describe("param-group constraints rendering", () => {
  it("renders every declared group, exactly-one then at-most-one then at-least-one", () => {
    expect(describeParamGroupConstraints(manifest({
      exclusiveParamGroups: [["a", "b"]],
      atMostOne: [["c", "d"]],
      atLeastOneOf: [["a", "c"]],
    }))).toEqual([
      "Provide exactly one of: a, b.",
      "Provide at most one of: c, d.",
      "Provide at least one of: a, c.",
    ]);
  });

  it("renders nothing for a manifest without groups", () => {
    expect(describeParamGroupConstraints(manifest({}))).toEqual([]);
  });

  it("is the SAME sentence the runtime rejects with", () => {
    const xor = manifest({
      params: [
        { key: "a", type: "string", description: "a" },
        { key: "b", type: "string", description: "b" },
      ],
      atMostOne: [["a", "b"]],
    });
    const [sentence] = describeParamGroupConstraints(xor);
    const result = validateProtocolParams(xor, { a: "1", b: "2" });
    expect(result.ok).toBe(false);
    if (result.ok || sentence === undefined) return;
    expect(result.reason).toContain(sentence);
  });
});

describe("chain-value enum case folding", () => {
  const CHAIN_ENUM_MANIFEST = manifest({
    params: [
      { key: "chain", type: "string", required: true, description: "chain", enum: ["BASE", "SOLANA"] },
      { key: "statsInterval", type: "string", description: "window", enum: ["5m", "1h"] },
    ],
  });

  it("accepts any casing on a chain param and hands the handler the DECLARED spelling", () => {
    for (const sent of ["base", "Base", "BASE"]) {
      const params: Record<string, unknown> = { chain: sent };
      expect(validateProtocolParams(CHAIN_ENUM_MANIFEST, params), sent).toEqual({ ok: true });
      expect(params.chain).toBe("BASE");
    }
  });

  it("folds toward a lowercase declaration too", () => {
    const lower = manifest({
      params: [{ key: "chain", type: "string", required: true, description: "chain", enum: ["base"] }],
    });
    const params: Record<string, unknown> = { chain: "BASE" };
    expect(validateProtocolParams(lower, params)).toEqual({ ok: true });
    expect(params.chain).toBe("base");
  });

  it("still rejects an off-list chain value, naming the allowed values", () => {
    const result = validateProtocolParams(CHAIN_ENUM_MANIFEST, { chain: "arbitrum" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("BASE, SOLANA");
    expect(result.reason).toContain("a chain value matches in any case");
  });

  it("keeps every NON-chain enum case-SENSITIVE", () => {
    const result = validateProtocolParams(CHAIN_ENUM_MANIFEST, { chain: "BASE", statsInterval: "1H" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Parameter "statsInterval"');
    expect(result.reason).toContain("case-sensitive");
  });

  it("does not fold a chain param that declares no enum", () => {
    const noEnum = manifest({
      params: [{ key: "chain", type: "string", required: true, description: "chain" }],
    });
    const params: Record<string, unknown> = { chain: "BASE" };
    expect(validateProtocolParams(noEnum, params)).toEqual({ ok: true });
    expect(params.chain).toBe("BASE");
  });
});

describe("unknown-key rejection names the replacement", () => {
  const CHAIN_MANIFEST = manifest({
    params: [{ key: "chain", type: "string", required: true, description: "chain" }],
  });

  it("names the canonical key for a BANNED spelling", () => {
    const result = validateProtocolParams(CHAIN_MANIFEST, { chain: "base", chainId: "8453" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Unknown parameter "chainId"');
    expect(result.reason).toContain("use `chain`");
  });

  it("says nothing extra for an unknown key that is merely unknown", () => {
    const result = validateProtocolParams(CHAIN_MANIFEST, { chain: "base", sparkle: "1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Unknown parameter "sparkle"');
    expect(result.reason).toContain("Allowed parameters: chain.");
    expect(result.reason).not.toContain("Instead");
  });
});

describe("manifest-lint: prose group claims must be backed by a declared field", () => {
  const param = (key: string, description: string) =>
    ({ key, type: "string", description, required: false }) as const;

  it("flags an at-most-one prose claim with no atMostOne group", () => {
    const issues = lintExclusiveParamGroups(
      "test.tool",
      [param("a", "Provide at most one of a, b.")],
      undefined,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("`atMostOne`");
  });

  it("flags an at-least-one prose claim with no atLeastOneOf group", () => {
    const issues = lintExclusiveParamGroups(
      "test.tool",
      [param("a", "Provide at least one of a, b.")],
      { atMostOne: [["a", "b"]] },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("`atLeastOneOf`");
  });

  it("is satisfied once the matching field is declared", () => {
    expect(lintExclusiveParamGroups(
      "test.tool",
      [param("a", "Provide at most one of a, b. Provide at least one of a, b.")],
      { atMostOne: [["a", "b"]], atLeastOneOf: [["a", "b"]] },
    )).toEqual([]);
  });

  it("accepts an at-most-one group as the backing for a mutual-exclusion sentence", () => {
    expect(lintExclusiveParamGroups(
      "test.tool",
      [param("a", "Mutually exclusive with b.")],
      { atMostOne: [["a", "b"]] },
    )).toEqual([]);
  });

  it("does not fire on ordinary English about DATA", () => {
    expect(lintExclusiveParamGroups(
      "test.tool",
      [param("requireSocials", "Keep only rows with at least one social link.")],
      undefined,
    )).toEqual([]);
  });
});
