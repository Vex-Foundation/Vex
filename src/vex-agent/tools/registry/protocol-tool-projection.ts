/**
 * The CANONICAL model-visible projection of a protocol manifest: the
 * description an external caller reads and the JSON Schema its arguments are
 * checked against.
 *
 * Extracted from `injected-protocol-tools.ts` (move only, no behaviour change)
 * when the Vex Studio MCP inventory needed the SAME projection. Two projections
 * would be two contracts: the in-app provider `tools` array would state a
 * cross-field rule that the MCP `tools/list` did not, and a model that read one
 * and called through the other would be told a rule after the call that it
 * could have read before it.
 *
 * The projection is therefore ONE function pair with one owner, and both
 * consumers call it:
 *
 *   - `registry/injected-protocol-tools.ts` builds the provider `tools` array
 *     from the session's discovered manifests;
 *   - `mcp/inventory/` builds the static `tools/list` the Studio MCP server
 *     exports.
 *
 * Nothing here decides VISIBILITY or authority. Which manifests may be shown is
 * the caller's question (lifecycle, `requiresEnv`, advertised namespace, the
 * pressure barrier for the in-app lane; the export-scope predicate for MCP),
 * and whether a call may RUN is decided by `executeProtocolTool` off the
 * RESOLVED manifest, never off a projected name or schema.
 */

import type { JsonSchema } from "../types.js";
import type { ProtocolToolManifest } from "../protocols/types.js";
import { paramsToJsonSchema } from "./khalani.js";
import { describeParamGroupConstraints } from "../protocols/runtime/params.js";

/**
 * The manifest description plus its cross-param group rules.
 *
 * A group rule is a fact about the CALL, not about one property, and JSON
 * Schema's ways of saying it (`oneOf`, `anyOf` over required sets) are exactly
 * the constructs provider function-schema validators narrow or reject. The
 * description is the channel every provider carries verbatim - and it is the
 * same sentence `ToolSearch` puts on the `constraints` row and the runtime
 * rejects with, so the model never sees the rule stated two ways.
 *
 * Appended, never substituted: a manifest with no groups keeps a byte-identical
 * description.
 */
export function protocolToolDescription(manifest: ProtocolToolManifest): string {
  const constraints = describeParamGroupConstraints(manifest);
  if (constraints.length === 0) return manifest.description;
  return `${manifest.description} ${constraints.join(" ")}`;
}

/**
 * The manifest's params as JSON Schema.
 *
 * A thin named alias over `paramsToJsonSchema` so both consumers reach the
 * projection through this module rather than one of them binding directly to
 * the params encoder. That is what makes a future change to the encoding one
 * edit instead of two, and what makes "the MCP schema and the provider schema
 * are the same object" checkable by reading one file.
 */
export function protocolToolInputSchema(manifest: ProtocolToolManifest): JsonSchema {
  return paramsToJsonSchema(manifest.params);
}
