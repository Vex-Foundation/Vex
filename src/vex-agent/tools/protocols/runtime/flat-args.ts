/**
 * `execute_tool` ENVELOPE resolution — turn the model's raw tool-call arguments
 * into the params bag the protocol runtime validates.
 *
 * WHY THIS EXISTS. `execute_tool` takes a two-level envelope
 * (`{toolId, params:{…}}`). A live session (2026-07-30) showed a weaker model
 * sending the params FLAT — `{toolId, query, limit, chainIds}` — six times in a
 * row, because the answer it got each time was
 * `Missing required parameter "query" for dexscreener.search`, which reads as
 * false to a model that can see `query` in the call it just made. The envelope
 * mistake was never named, so it was never corrected.
 *
 * THE TOLERANCE IS MANIFEST-DRIVEN, AND THAT IS THE POINT. A top-level key is
 * lifted only when the resolved manifest DECLARES it (or it is a runtime
 * control key). Nothing is invented, no undeclared key is smuggled past the
 * strict unknown-key gate, and every lifted value still faces the unchanged
 * `validateProtocolParams` boundary — required-missing, wrong type, and unit
 * contracts all still reject. This widens what the boundary UNDERSTANDS, never
 * what it permits.
 *
 * Pure apart from the manifest lookup and one observability log.
 */

import { getProtocolManifest } from "../catalog.js";
import { RESERVED_RUNTIME_PARAM_KEYS } from "./params.js";
import logger from "@utils/logger.js";

/**
 * Keys the `execute_tool` envelope owns. They are never lifted into params —
 * a manifest that happened to declare a `params` key would otherwise receive
 * the envelope's own field.
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["toolId", "params"]);

export type ExecuteToolParamsResolution =
  | {
      readonly ok: true;
      readonly params: Record<string, unknown>;
      readonly liftedKeys: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

function isPlainParamsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the params bag for an `execute_tool` call.
 *
 *  1. `params` is a plain object → used verbatim; nothing is lifted. Stray
 *     top-level keys beside a real envelope are the model's own noise and are
 *     ignored exactly as before.
 *  2. `params` is absent (or not a plain object) and at least one top-level key
 *     is a DECLARED param of the resolved manifest → those keys are lifted.
 *  3. `params` is absent and top-level keys exist but NONE is declared → reject
 *     with the envelope explanation, not with a per-parameter message.
 *  4. `params` is absent and there are no other top-level keys → an empty bag;
 *     a genuinely param-less tool must still be callable, and a tool with a
 *     required param still gets its ordinary "missing required" rejection.
 *
 * An unresolvable `toolId` lifts nothing: `executeProtocolTool`'s unknown-tool
 * error is the honest answer and must not be pre-empted by an envelope
 * complaint.
 */
export function resolveExecuteToolParams(
  toolId: string,
  args: Record<string, unknown>,
): ExecuteToolParamsResolution {
  const declaredParams = args.params;
  if (isPlainParamsObject(declaredParams)) {
    return { ok: true, params: declaredParams, liftedKeys: [] };
  }

  const flatKeys = Object.keys(args).filter((key) => !ENVELOPE_KEYS.has(key));
  if (flatKeys.length === 0) {
    return { ok: true, params: {}, liftedKeys: [] };
  }

  const manifest = getProtocolManifest(toolId);
  if (!manifest) {
    return { ok: true, params: {}, liftedKeys: [] };
  }

  const declaredKeys = new Set(manifest.params.map((param) => param.key));
  const liftedKeys = flatKeys.filter(
    (key) => declaredKeys.has(key) || RESERVED_RUNTIME_PARAM_KEYS.has(key),
  );

  if (liftedKeys.length === 0) {
    return { ok: false, reason: envelopeRejection(manifest.toolId, flatKeys, declaredKeys) };
  }

  const params: Record<string, unknown> = {};
  for (const key of liftedKeys) params[key] = args[key];

  logger.info("protocol.params.flat_args_lifted", { toolId: manifest.toolId, liftedKeys });

  return { ok: true, params, liftedKeys };
}

/**
 * The message that replaces `Missing required parameter "…"` when the model
 * sent no envelope AND nothing it sent is a parameter of this tool. It names
 * the actual mistake, echoes the KEYS it received (never their values — those
 * are untrusted and may carry sensitive text), and shows the shape to send.
 */
function envelopeRejection(
  toolId: string,
  receivedKeys: readonly string[],
  declaredKeys: ReadonlySet<string>,
): string {
  const example = [...declaredKeys][0] ?? "…";
  return (
    `execute_tool arguments must carry tool parameters inside "params": { … }. `
    + `Received top-level keys: [${receivedKeys.join(", ")}], none of which is a parameter of `
    + `${toolId}. Allowed parameters: ${[...declaredKeys].join(", ") || "(none)"}. `
    + `Example: {"toolId":"${toolId}","params":{"${example}":"…"}}`
  );
}
