import type { JsonSchema, JsonSchemaProperty, ToolDef } from "../types.js";
import { KHALANI_TOOLS } from "../protocols/khalani/manifest.js";
import type { ProtocolParamDef } from "../protocols/types.js";

export const KHALANI_INTERNAL_TO_PROTOCOL = {
  khalani_chains_list: "khalani.chains.list",
  khalani_tokens_top: "khalani.tokens.top",
  token_find: "khalani.tokens.search",
  khalani_tokens_balances: "khalani.tokens.balances",
} as const;

export type KhalaniInternalToolName = keyof typeof KHALANI_INTERNAL_TO_PROTOCOL;

const KHALANI_MANIFESTS = new Map(KHALANI_TOOLS.map((tool) => [tool.toolId, tool]));

export const KHALANI_INTERNAL_TOOLS: readonly ToolDef[] = Object.entries(KHALANI_INTERNAL_TO_PROTOCOL).map(
  ([name, toolId]) => {
    const manifest = KHALANI_MANIFESTS.get(toolId);
    if (!manifest) {
      throw new Error(`Missing Khalani protocol manifest for internal alias ${name}: ${toolId}`);
    }
    if (manifest.mutating) {
      throw new Error(`Khalani internal alias ${name} must not target mutating tool ${toolId}`);
    }

    return {
      name,
      kind: "internal",
      mutating: false,
      pressureSafety: "read_only",
      actionKind: "read",
      description: internalDescription(name, manifest.description),
      parameters: paramsToJsonSchema(manifest.params),
    };
  },
);

/**
 * Compile manifest params into a provider-facing JSON schema.
 *
 * The ONE ProtocolParamDef → JsonSchema compiler in the repo (protocol tools
 * otherwise reach the model through `discover_tools`, which serialises the
 * ProtocolParamDef itself). Exported so the `acceptsStringArray` union can be
 * proven end-to-end — compiled here, then through
 * `normalizeToolSchemaForProvider` — rather than only where a Khalani alias
 * happens to declare it.
 */
export function paramsToJsonSchema(params: readonly ProtocolParamDef[]): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const param of params) {
    properties[param.key] = param.acceptsStringArray === true
      // No outer `type`: JSON Schema conjoins siblings, so `type: "string"` here
      // would make the array branch unsatisfiable. See `JsonSchemaUnionProperty`.
      ? {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: param.description,
        }
      : { type: param.type, description: param.description };
    if (param.required) required.push(param.key);
  }

  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

function internalDescription(name: string, protocolDescription: string): string {
  if (name === "khalani_tokens_balances") {
    return "Read your token balances on one wallet family (EVM or Solana) via Khalani. Defaults to your personal wallet — pass `address` only if you want to check a different one. Use wallet_balances if you want all your wallet families in one call.";
  }
  if (name === "token_find") {
    return "Resolve a token symbol/name to its exact on-chain contract address(es) + decimals per chain (the canonical EVM token resolver). Use BEFORE any swap or bridge.";
  }
  return `${protocolDescription} Direct shortcut to ${KHALANI_INTERNAL_TO_PROTOCOL[name as KhalaniInternalToolName]}.`;
}
