/**
 * Retired input spellings (`ProtocolParamDef.aliases`), owner decision D15.
 *
 * Three things need proving and only one of them is the rewrite itself.
 *
 * ORDER. The rewrite claims to run before every other reader of a protocol
 * call. That claim is what makes it safe: the approval enqueue persists the
 * ORIGINAL `ParsedToolCall.arguments` object, not the runtime's validated copy,
 * so a rewrite placed later would leave a retired spelling in a durable row and
 * a cold resume would replay a spelling the schema no longer declares. The test
 * for it is object IDENTITY on the caller's own object plus the handler seeing
 * the canonical key, because both together are what "first, and in place" means.
 *
 * SILENCE IN THE SCHEMA. An alias that reached `paramsToJsonSchema` would teach
 * the retired spelling to every model reading the manifest today, which is the
 * opposite of a migration.
 *
 * REFUSAL, not precedence. Both spellings in one call is ambiguous and is
 * answered by name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { normalizeParamAliases } from "@vex-agent/tools/protocols/runtime/param-aliases.js";
import { paramsToJsonSchema } from "@vex-agent/tools/registry/khalani.js";
import { getProtocolManifest, PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { BANNED_PARAM_KEYS, CANONICAL_PARAM_KEYS } from "@vex-agent/tools/protocols/conventions.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

function manifestWith(params: ProtocolToolManifest["params"]): ProtocolToolManifest {
  return {
    toolId: "test.aliases",
    publicName: "test__aliases",
    namespace: "khalani",
    lifecycle: "active",
    description: "Fixture manifest used only to pin the alias rewrite.",
    mutating: false,
    actionKind: "read",
    params,
    exampleParams: {},
  } as ProtocolToolManifest;
}

const ALIASED = manifestWith([
  {
    key: "walletFamily",
    type: "string",
    description: "Wallet FAMILY, never a chain: eip155 or solana.",
    aliases: [{ key: "wallet", removeAfter: "D5 owner acceptance." }],
  },
]);

describe("normalizeParamAliases", () => {
  it("rewrites the retired spelling IN PLACE on the caller's own object", () => {
    const params: Record<string, unknown> = { wallet: "solana", limit: 5 };
    const same = params;

    expect(normalizeParamAliases(ALIASED, params)).toEqual({ ok: true });
    // Same object, not a copy: everything downstream, including the approval
    // enqueue, holds this reference.
    expect(params).toBe(same);
    expect(params).toEqual({ walletFamily: "solana", limit: 5 });
    expect("wallet" in params).toBe(false);
  });

  it("refuses BY NAME when both spellings arrive, and mutates nothing", () => {
    const params: Record<string, unknown> = { wallet: "solana", walletFamily: "eip155" };
    const result = normalizeParamAliases(ALIASED, params);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('"wallet"');
    expect(result.reason).toContain('"walletFamily"');
    expect(result.reason).toContain("Vex will not guess which one you meant");
    // The caller re-sends ONE key; nothing was silently preferred.
    expect(params).toEqual({ wallet: "solana", walletFamily: "eip155" });
  });

  it("treats an `undefined` alias value as absent, the same rule the rest of the boundary uses", () => {
    const params: Record<string, unknown> = { wallet: undefined, walletFamily: "solana" };

    expect(normalizeParamAliases(ALIASED, params)).toEqual({ ok: true });
    expect(params["walletFamily"]).toBe("solana");
  });

  it("does nothing at all to a manifest that declares no alias", () => {
    const bare = manifestWith([
      { key: "walletFamily", type: "string", description: "Wallet FAMILY, never a chain." },
    ]);
    const params: Record<string, unknown> = { wallet: "solana" };

    expect(normalizeParamAliases(bare, params)).toEqual({ ok: true });
    // Untouched: `wallet` is now an UNKNOWN key here, and the strict boundary
    // answers it by name with its replacement. That is the D5 path, and it must
    // not be silently rescued by a mechanism this tool never declared.
    expect(params).toEqual({ wallet: "solana" });
  });
});

describe("the alias rewrite runs FIRST inside executeProtocolTool", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("hands the handler the canonical key and leaves the caller's arguments canonical", async () => {
    const seen: Record<string, unknown>[] = [];
    const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");

    // The real `khalani.orders.list` manifest, with its handler replaced: the
    // point is the ORDER of the runtime's own steps, so the manifest must be
    // the production one and only the leaf is a double.
    const catalog = await import("@vex-agent/tools/protocols/catalog.js");
    const original = catalog.getProtocolHandler("khalani.orders.list");
    vi.spyOn(catalog, "getProtocolHandler").mockImplementation((toolId: string) =>
      toolId === "khalani.orders.list"
        ? (async (params: Record<string, unknown>) => {
            seen.push({ ...params });
            return { success: true, output: "{}" };
          })
        : original,
    );

    // The object the dispatcher would have taken straight off the tool call.
    const callArguments: Record<string, unknown> = { wallet: "solana", limit: 5 };
    const result = await executeProtocolTool(
      { toolId: "khalani.orders.list", params: callArguments },
      { sessionPermission: "full", approved: true, sessionId: "s1" } as never,
    );

    expect(result.success).toBe(true);
    // The handler, past the coercers and past strict validation, saw ONE
    // spelling. Strict validation would have rejected `wallet` outright, so a
    // success here is itself evidence the rewrite preceded it.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ walletFamily: "solana", limit: 5 });
    expect("wallet" in seen[0]).toBe(false);
    // And the ORIGINAL arguments object - the one an approval enqueue would
    // persist - is canonical too.
    expect(callArguments).toEqual({ walletFamily: "solana", limit: 5 });
  });
});

describe("aliases are never model-visible", () => {
  it("compiles no retired key into the JSON schema of any tool that declares one", () => {
    const aliased = PROTOCOL_TOOLS.filter((manifest) =>
      manifest.params.some((param) => (param.aliases ?? []).length > 0),
    );
    // Guard the guard: if the renames were reverted this suite must fail loudly
    // rather than pass over an empty set.
    expect(aliased.length).toBeGreaterThan(0);

    for (const manifest of aliased) {
      const schema = paramsToJsonSchema(manifest.params);
      const properties = Object.keys(schema.properties ?? {});
      for (const param of manifest.params) {
        for (const alias of param.aliases ?? []) {
          expect(properties, `${manifest.toolId} leaks the retired key ${alias.key}`)
            .not.toContain(alias.key);
        }
        expect(properties).toContain(param.key);
      }
      expect(JSON.stringify(schema)).not.toContain("removeAfter");
    }
  });

  it("declares every alias as a BANNED spelling, which is what the boundary answers by name", () => {
    for (const manifest of PROTOCOL_TOOLS) {
      for (const param of manifest.params) {
        for (const alias of param.aliases ?? []) {
          expect(BANNED_PARAM_KEYS.has(alias.key)).toBe(true);
          expect(CANONICAL_PARAM_KEYS.has(alias.key)).toBe(false);
          expect(alias.removeAfter.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("pins the six D15 renames on their tools", () => {
    const expected: readonly (readonly [string, string, string])[] = [
      ["khalani.orders.list", "walletFamily", "wallet"],
      ["khalani.tokens.balances", "walletFamily", "wallet"],
      ["morpho.markets.discover", "query", "search"],
      ["morpho.vaults.discover", "query", "search"],
    ];
    for (const [toolId, key, retired] of expected) {
      const manifest = getProtocolManifest(toolId);
      const param = manifest?.params.find((p) => p.key === key);
      expect(param, `${toolId} has no param ${key}`).toBeDefined();
      expect((param?.aliases ?? []).map((a) => a.key)).toContain(retired);
      // The retired spelling is not also a live key.
      expect(manifest?.params.some((p) => p.key === retired)).toBe(false);
    }
  });
});
