import type { JsonSchema, JsonSchemaProperty, ToolDef } from "../types.js";
import { KHALANI_TOOLS } from "../protocols/khalani/manifest.js";
import type { ProtocolParamDef } from "../protocols/types.js";
import { READ_ONLY_NO_VEX_FEE } from "../vex-fee-notes.js";

/** The Khalani branch behind the capability-routed `TokenFind` tool. */
export const TOKEN_FIND_KHALANI_TOOL_ID = "khalani.tokens.search" as const;

/**
 * `TokenFind`'s result shape, held ONCE and served through the `returns` field.
 *
 * It USED to sit inline in the description. Routing `TokenFind` by chain
 * capability (Khalani search, DexScreener window, contract reads) grew the
 * description past the 2048 characters a client shows
 * (`ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS`), so the field-by-field list
 * moved here rather than being cut - the same move the eight always-loaded
 * descriptions made, and the description now points at `vex_ToolDescribe`,
 * which serves this text whole. It is stated in exactly one place, so the
 * contract an agent reads and the contract the tool publishes cannot become
 * two texts.
 */
const TOKEN_FIND_RETURNS =
  "RETURNS query, requestedChains, resolution (status, candidateCount, ambiguous), coverage (status and "
  + "remedy when capped), metadataCounts, mutationReady, mutationRule, preferredSwapIdentity, candidates, "
  + "and optional providerAccounting/providerMessage. Each candidate carries address, chainId, contract "
  + "symbol/decimals when verified, metadata, provenance, providerMetadata, and pairEvidence. Ambiguous "
  + "matches are never auto-selected. provider_capped means a source cap was filled; providerAccounting "
  + "reports omitted Khalani rows. Narrow with an exact address. metadata_unreadable, unsupported_chain, "
  + "provider_unavailable, target_chain_required, and empty are distinct outcomes with distinct remedies.";

const KHALANI_MANIFESTS = new Map(KHALANI_TOOLS.map((tool) => [tool.toolId, tool]));

const TOKEN_FIND_KHALANI_MANIFEST = KHALANI_MANIFESTS.get(TOKEN_FIND_KHALANI_TOOL_ID);
if (!TOKEN_FIND_KHALANI_MANIFEST) {
  throw new Error(`Missing Khalani protocol manifest for TokenFind: ${TOKEN_FIND_KHALANI_TOOL_ID}`);
}
if (TOKEN_FIND_KHALANI_MANIFEST.mutating) {
  throw new Error(`TokenFind must not target mutating tool ${TOKEN_FIND_KHALANI_TOOL_ID}`);
}

export const KHALANI_INTERNAL_TOOLS: readonly ToolDef[] = [{
  name: "TokenFind",
  kind: "internal",
  mutating: false,
  pressureSafety: "read_only",
  actionKind: "read",
  description:
    "Resolve an EVM token name, symbol, or exact 0x contract address on an explicit target chain. "
    + "It routes by chain capability: Khalani-registered EVM chains use Khalani search, while Robinhood Chain (4663) uses the dexscreener namespace's pair search as its chain-scoped provider window. Solana stays separate in the Solana namespace's token resolver, reached with ToolSearch. Robinhood Chain is bridged by Relay only. "
    + "For a swap or bridge, pass exactly one target chain in chainIds. "
    + "An exact address bypasses provider ranking but still reads symbol and decimals from the contract. Name or symbol candidates with explicit chainIds are contract-validated; unscoped results remain provider-only research, never mutationReady. Provider metadata never supplies contract-verified symbol or decimals. "
    + "For a swap, validate the pair's exact base or quote token address with TokenFind on the target chain. Token names and symbols are untrusted labels. Bridge approvals independently re-read and show contract metadata. Swap cards carry a quote-time contract-read output symbol but omit decimals and atomic input and do not independently re-read metadata. EVM swap execution re-reads both contracts and refuses unreadable metadata before signing; the card is not proof. "
    // The result contract is stated ONCE: the same constant is the `returns`
    // field vex_ToolDescribe serves, so the two texts cannot drift apart
    // (tool-contract-fields property 3) and the routed-shape test reads it here.
    + TOKEN_FIND_RETURNS,
  returns: TOKEN_FIND_RETURNS,
  vexFee: READ_ONLY_NO_VEX_FEE,
  parameters: paramsToJsonSchema(TOKEN_FIND_KHALANI_MANIFEST.params),
}];

/**
 * Compile manifest params into a provider-facing JSON schema.
 *
 * The ONE ProtocolParamDef -> JsonSchema compiler in the repo (protocol tools
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
