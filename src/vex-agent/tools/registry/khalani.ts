import type { JsonSchema, JsonSchemaProperty, ToolDef } from "../types.js";
import { KHALANI_TOOLS } from "../protocols/khalani/manifest.js";
import type { ProtocolParamDef } from "../protocols/types.js";

/**
 * Internal-alias → protocol toolId, for the Khalani reads that earn a flat name.
 *
 * ONE alias remains by design (2026-07-30). `khalani_chains_list`,
 * `khalani_tokens_top` and `khalani_tokens_balances` were removed: each was a
 * tool-on-tool shortcut that no observed live session called, while every one
 * of them cost schema tokens in every request. Their protocol tools are
 * unchanged and still reachable through `discover_tools` + `execute_tool`
 * (`khalani.chains.list`, `khalani.tokens.top`, `khalani.tokens.balances`).
 *
 * `token_find` stays because it is load-bearing: it sits on the hottest path in
 * the product (address + decimals resolution before every swap and bridge) and
 * is named by the swap chain-param docs, `chain_read`'s description, and the
 * safety doctrine prose.
 */
export const KHALANI_INTERNAL_TO_PROTOCOL = {
  token_find: "khalani.tokens.search",
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
    // A closed value set is compiled onto EVERY branch that can carry a value:
    // JSON Schema's `enum` beside an `anyOf` would constrain the union as a
    // whole, but an array VALUE never equals one of the member strings, so the
    // array branch would become unsatisfiable — the same trap as `type` above.
    const values = param.enum && param.enum.length > 0 ? [...param.enum] : undefined;
    properties[param.key] = param.acceptsStringArray === true
      // No outer `type`: JSON Schema conjoins siblings, so `type: "string"` here
      // would make the array branch unsatisfiable. See `JsonSchemaUnionProperty`.
      ? {
          anyOf: [
            values ? { type: "string", enum: values } : { type: "string" },
            { type: "array", items: values ? { type: "string", enum: values } : { type: "string" } },
          ],
          description: param.description,
        }
      : values
        ? { type: param.type, description: param.description, enum: values }
        : { type: param.type, description: param.description };
    if (param.required) required.push(param.key);
  }

  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

function internalDescription(name: string, protocolDescription: string): string {
  if (name === "token_find") {
    return "Resolve a token symbol/name to its exact on-chain contract address(es) + decimals per chain (the canonical EVM token resolver). Use BEFORE any swap or bridge. It covers KHALANI-REGISTERED CHAINS ONLY, and that set is dynamic - list it with `khalani.chains.list` rather than assuming it. App-local chains such as Robinhood Chain (4663) are NOT resolvable here; there use `dexscreener.search` (symbol to address lookup on the chain slug), `wallet_track_token` (save a token so Vex tracks it on app-local chains, action:\"list\" for the tracked set), or `wallet_balances` (the tokens the wallet actually holds).";
  }
  return `${protocolDescription} Direct shortcut to ${KHALANI_INTERNAL_TO_PROTOCOL[name as KhalaniInternalToolName]}.`;
}
