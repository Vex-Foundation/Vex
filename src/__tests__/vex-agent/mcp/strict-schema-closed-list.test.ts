/**
 * The strict MCP projection admits the comma-separated spelling of a closed
 * list, and every exported protocol tool's own `exampleParams`.
 *
 * THE DEFECT THIS CLOSES, measured 2026-10-07
 *
 * `dexscreener__pair_get` ships `include: "reactions,insight"` as its worked
 * call and its description promises "a comma-separated string or an array".
 * The strict projection compiled the string branch to `enum: [reactions,
 * insight]`, so the SDK's Ajv2020 admission gate refused the shipped example
 * before the runtime ever saw it - and the runtime gate refused it too, by the
 * same whole-string comparison. Both gates now read the string member by
 * member; this suite runs the REAL SDK validator (`fromJsonSchema`, the one
 * `mcp/server.ts` registers every tool with), not a re-derived copy of it.
 *
 * The contract `strict-schema.ts` owes is one-directional: anything the
 * projection admits, `validateProtocolParams` admits. The parity case below
 * proves it for the closed-list pattern over a set of hostile spellings.
 */

import { describe, expect, it } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import type { JsonSchemaType } from "@modelcontextprotocol/server";

import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import { strictProtocolToolInputSchema } from "@vex-agent/mcp/inventory/strict-schema.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import type { JsonSchema } from "@vex-agent/tools/types.js";

/**
 * The schema as the client receives it: `tools/list` is a JSON frame, so the
 * round trip is the faithful reproduction, and it is also what lets Vex's own
 * `JsonSchema` vocabulary meet the SDK's parameter type without a cast.
 */
function wireSchema(schema: JsonSchema): JsonSchemaType {
  return JSON.parse(JSON.stringify(schema));
}

async function admits(schema: JsonSchema, args: Record<string, unknown>): Promise<boolean> {
  const result = await fromJsonSchema(wireSchema(schema))["~standard"].validate(args);
  return result.issues === undefined;
}

const LIST_MANIFEST: ProtocolToolManifest = {
  toolId: "test.closed_list",
  publicName: "test__closed_list",
  namespace: "dexscreener",
  lifecycle: "active",
  description: "Fixture manifest for the closed-list string branch.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "include",
      type: "string",
      description: "side reads",
      acceptsStringArray: true,
      // `a.b` and `c+d` carry pattern syntax characters on purpose: an
      // unescaped `.` would admit `axb`, and `\-`-style escapes of anything
      // else are a SyntaxError under the `u` flag Ajv compiles with.
      enum: ["reactions", "insight", "a.b", "c+d"],
    },
  ],
  exampleParams: { include: "reactions" },
};

describe("strict projection - closed-list STRING branch", () => {
  const schema = strictProtocolToolInputSchema(LIST_MANIFEST);

  it("admits a comma-separated list of listed members, trimmed, empties ignored", async () => {
    for (const include of ["reactions", "reactions,insight", " reactions , insight ,", "a.b,c+d", ",insight"]) {
      expect(await admits(schema, { include }), include).toBe(true);
    }
  });

  it("refuses an off-list member, a whitespace-only separator and an empty list", async () => {
    for (const include of ["reactions,other", "reactions insight", "axb", "cccd", " , ", "", "Reactions"]) {
      expect(await admits(schema, { include }), include).toBe(false);
    }
  });

  it("never admits a value the runtime refuses", async () => {
    const probes = [
      "reactions", "reactions,insight", "reactions,,insight", "\treactions\n,insight",
      "reactions;insight", "reactions,insight,other", "axb", "a.b", "c+d,a.b ", ",", "",
      "reactions, Insight", " insight ",
    ];
    for (const include of probes) {
      if (!(await admits(schema, { include }))) continue;
      expect(validateProtocolParams(LIST_MANIFEST, { include }), include).toEqual({ ok: true });
    }
  });

  it("keeps the array branch exact, member by member", async () => {
    expect(await admits(schema, { include: ["reactions", "insight"] })).toBe(true);
    expect(await admits(schema, { include: ["reactions,insight"] })).toBe(false);
  });
});

describe("every exported protocol tool admits its own exampleParams over MCP", () => {
  const byName = new Map(PROTOCOL_TOOLS.map((manifest) => [manifest.publicName, manifest] as const));
  const exported = buildStudioInventory().flatMap((tool) => {
    const manifest = byName.get(tool.publicName);
    return manifest === undefined ? [] : [[tool.publicName, tool.inputSchema, manifest] as const];
  });

  it("covers a non-trivial exported surface", () => {
    expect(exported.length).toBeGreaterThan(50);
  });

  it.each(exported)("%s", async (_name, inputSchema, manifest) => {
    expect(await admits(inputSchema, { ...manifest.exampleParams })).toBe(true);
  });
});
