import type { JsonSchema, JsonSchemaProperty, ToolDef } from "../types.js";
import { KHALANI_TOOLS } from "../protocols/khalani/manifest.js";
import type { ProtocolParamDef } from "../protocols/types.js";
import { READ_ONLY_NO_VEX_FEE } from "../vex-fee-notes.js";

/**
 * Internal-alias → protocol toolId, for the Khalani reads that earn a flat name.
 *
 * ONE alias remains by design (2026-07-30). `khalani_chains_list`,
 * `khalani_tokens_top` and `khalani_tokens_balances` were removed: each was a
 * tool-on-tool shortcut that no observed live session called, while every one
 * of them cost schema tokens in every request. Their protocol tools are
 * unchanged and still reachable through `ToolSearch` + `execute_tool`
 * (`khalani.chains.list`, `khalani.tokens.top`, `khalani.tokens.balances`).
 *
 * `TokenFind` stays because it is load-bearing: it sits on the hottest path in
 * the product (address + decimals resolution before every swap and bridge) and
 * is named by the swap chain-param docs, `ChainRead`'s description, and the
 * safety doctrine prose.
 */
export const KHALANI_INTERNAL_TO_PROTOCOL = {
  TokenFind: "khalani.tokens.search",
} as const;

export type KhalaniInternalToolName = keyof typeof KHALANI_INTERNAL_TO_PROTOCOL;

/**
 * `TokenFind`'s result shape, held ONCE.
 *
 * The description below interpolates this same constant, so the field the
 * `ToolDef` publishes and the sentence the model reads cannot become two
 * texts. The suite asserts the containment either way, but one source is
 * better than a checked copy.
 */
const TOKEN_FIND_RETURNS =
  "RETURNS count and tokens, each row carrying symbol, name, address, chainId (a NUMBER, not a chain "
  + "slug) and decimals, plus priceUsd, balance and isRiskToken where the registry has them; it returns "
  + "every match with no limit and no paging. One symbol can match several chains and several contracts, "
  + "so the result is a candidate set to choose from, and the `decimals` you use must come from the row "
  + "for the exact chain you are transacting on.";

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
      returns: internalReturns(name),
      vexFee: READ_ONLY_NO_VEX_FEE,
      parameters: paramsToJsonSchema(manifest.params),
    };
  },
);

/**
 * Compile manifest params into a provider-facing JSON schema.
 *
 * The ONE ProtocolParamDef → JsonSchema compiler in the repo (protocol tools
 * otherwise reach the model through `ToolSearch`, which serialises the
 * ProtocolParamDef itself). Exported so the `acceptsStringArray` union can be
 * proven end-to-end - compiled here, then through
 * `normalizeToolSchemaForProvider` - rather than only where a Khalani alias
 * happens to declare it.
 */
export function paramsToJsonSchema(params: readonly ProtocolParamDef[]): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const param of params) {
    // A closed value set is compiled onto EVERY branch that can carry a value:
    // JSON Schema's `enum` beside an `anyOf` would constrain the union as a
    // whole, but an array VALUE never equals one of the member strings, so the
    // array branch would become unsatisfiable - the same trap as `type` above.
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

/**
 * The authored result shape for one internal alias, or a hard failure.
 *
 * THROWS rather than returning undefined, the same argument the inventory's
 * `requireTitle` makes: an alias exported to an external agent without a
 * result contract is an unreviewed row, and a silent absence would ship it
 * looking deliberate. The alias map has one entry, so the compiler cannot
 * enforce this and the registration-time throw does.
 */
function internalReturns(name: string): string {
  if (name === "TokenFind") return TOKEN_FIND_RETURNS;
  throw new Error(
    `Khalani internal alias ${name} has no authored RETURNS text. Add one beside `
    + "TOKEN_FIND_RETURNS in registry/khalani.ts in the same change that added the alias.",
  );
}

function internalDescription(name: string, protocolDescription: string): string {
  if (name === "TokenFind") {
    return `${"Resolve a token symbol/name to its exact on-chain contract address(es) + decimals per chain (the canonical EVM token resolver). Use BEFORE any swap or bridge. "}${TOKEN_FIND_RETURNS}${" It covers KHALANI-REGISTERED CHAINS ONLY, and that set is dynamic - list it with the khalani namespace's supported-chains tool, reached with ToolSearch, rather than assuming it. App-local chains such as Robinhood Chain (4663) are NOT resolvable here, even though SwapQuote and SwapExecute trade on them: resolve an address there with the dexscreener namespace's pair search, reached with vex_ToolSearch (symbol to address on the chain slug), with `WalletTrackToken` (action:\"list\" shows the tracked set on an app-local chain), or with `WalletBalances` (the tokens the wallet actually holds), then pass that ADDRESS to the swap tools. Robinhood Chain is bridged by Relay only, through BridgeQuoteRelay and BridgeExecuteRelay."}`;
  }
  return `${protocolDescription} Direct shortcut to ${KHALANI_INTERNAL_TO_PROTOCOL[name as KhalaniInternalToolName]}.`;
}
