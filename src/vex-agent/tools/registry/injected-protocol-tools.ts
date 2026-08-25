/**
 * Selected protocol tools → real OpenAI function schemas.
 *
 * Owner decision 2026-08-03 (SPEC §7 Q1, `reports/model-research.md` R1):
 * after `ToolSearch` returns a ranked or selected row, that manifest is appended to
 * the NEXT request's `tools` array as a genuine function definition, so the
 * provider enforces `required` instead of the model having to re-read a JSON
 * blob from a prior tool result. This is now THE calling path: the `execute_tool`
 * ToolDef is retired (`./protocol.ts`), while its dispatch route stays alive so
 * an already-approved intent still resumes.
 *
 * NAME MAPPING. OpenAI function names must match `^[a-zA-Z0-9_-]{1,64}$`, so
 * the dotted toolId cannot be sent verbatim. The projected name is the
 * manifest's authored `publicName` (`protocols/types.ts`), a REVIEWED naming
 * decision carried in `tool-surface-spec/mappings/*.json` — not a string
 * transform of the toolId.
 *
 * WHY A TABLE AND NOT A TRANSFORM. The old projection mangled `.` → `__`
 * mechanically, which was invertible only because every dot became a separator.
 * Under the target grammar there is EXACTLY ONE `__`, at the namespace
 * boundary, so inversion is lossy: `kyberswap__swap_quote` would invert to
 * `kyberswap.swap_quote` rather than the immutable `kyberswap.swap.quote`, and
 * a fund-moving call would resolve onto a different tool or onto none. Both
 * directions are therefore CATALOG LOOKUPS, built once from the manifests, and
 * `protocols/public-name-gate.ts` owns the grammar plus the uniqueness that
 * makes the reverse map a bijection. `injected-protocol-tools.test.ts` asserts
 * it catalog-wide.
 *
 * STALE NAMES FROM BEFORE THE RENAME. No protocol alias entries were added for
 * the old mechanically-mangled spellings. Owner decision D5 governs: the
 * product is a production preview, aliases exist to keep in-flight state safe
 * rather than to guarantee indefinite compatibility, and the owner accepts that
 * a durable artifact (an old accepted plan, a re-read transcript) may emit a
 * retired spelling. Such a call is not silently misrouted — it fails the
 * catalog lookup, and `dispatcher/protocol-route.ts` answers by NAME with a
 * ToolSearch instruction, which re-teaches the current name. The alias table
 * (`./name-resolution.ts`) stays wired for the entries that do need it.
 *
 * GATING. Injection is a VISIBILITY decision only. Which manifests may be
 * shown is decided here (lifecycle + `requiresEnv` + advertised namespace +
 * the pressure barrier); whether a call may RUN is decided, unchanged, by
 * `executeProtocolTool` off the RESOLVED MANIFEST — never off the function
 * name. See `dispatcher/protocol-route.ts`.
 */

import type { OpenAITool } from "../types.js";
import type { ProtocolToolManifest } from "../protocols/types.js";
import {
  PROTOCOL_TOOLS,
  getProtocolManifest,
  isAdvertisedProtocolNamespace,
  isProtocolToolAvailable,
} from "../protocols/catalog.js";
import { paramsToJsonSchema } from "./khalani.js";
import { describeParamGroupConstraints } from "../protocols/runtime/params.js";
import { getDiscoveredToolIds } from "./discovered-tools.js";
import { resolveDeprecatedProtocolToolId } from "./name-resolution.js";
import type { ToolVisibilityContext } from "./visibility.js";

/** OpenAI function-name grammar. Exported so the catalog-wide test asserts the real constraint. */
export const OPENAI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** The namespace boundary marker. A publicName carries EXACTLY one. */
const NAME_SEPARATOR = "__";

/**
 * `publicName` → `toolId`, built once from the catalog.
 *
 * Module-level and eager because `PROTOCOL_TOOLS` is itself a module-load
 * constant and `catalog.ts` already throws at load on a duplicate toolId. A
 * duplicate publicName cannot be thrown on here without turning a naming
 * mistake into an app that will not boot, so the gate
 * (`protocols/public-name-gate.ts`, asserted by the G2 suite) owns that
 * failure and this map keeps the FIRST claimant deterministically.
 */
const TOOL_ID_BY_PUBLIC_NAME: ReadonlyMap<string, string> = new Map(
  PROTOCOL_TOOLS.map((manifest) => [manifest.publicName, manifest.toolId] as const),
);

/**
 * Namespaces whose every tool is injected into EVERY session's tools array
 * without a ToolSearch discovery round (owner decision D-DS9, 2026-08-25):
 * the agent must see the market-research surface from its first token instead
 * of paying discovery latency. Measured at the decision: 18 manifests,
 * ~265 KB of schema, ~66k tokens of tools-array occupancy, amortized by
 * prompt caching. Reversal is deleting the namespace from this set; dialing
 * back to a curated subset is a per-tool list here instead of a namespace.
 * Every visibility gate below still applies (availability, advertised
 * namespace, pressure barrier) - this constant widens WHICH manifests are
 * considered, never WHETHER one may be shown.
 */
const ALWAYS_INJECTED_NAMESPACES: ReadonlySet<string> = new Set(["dexscreener"]);

/**
 * Whether a namespace's tools are always injected (D-DS9). Exported for the
 * system-prompt Protocols layer: the prompt must tell the model these tools
 * are already in its tools array, or the model pays a ToolSearch round the
 * injection made unnecessary. One owner for the set; the prompt derives.
 */
export function isAlwaysInjectedNamespace(namespace: string): boolean {
  return ALWAYS_INJECTED_NAMESPACES.has(namespace);
}

/**
 * The session's injection id list: always-injected namespaces first, in
 * catalog order, then the session's discovered working set minus duplicates.
 * Catalog order is deterministic (module-load constant), so the tools array
 * stays byte-stable across requests - the property prompt caching needs.
 */
function injectionToolIds(sessionId: string | undefined): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const manifest of PROTOCOL_TOOLS) {
    if (!ALWAYS_INJECTED_NAMESPACES.has(manifest.namespace)) continue;
    ids.push(manifest.toolId);
    seen.add(manifest.toolId);
  }
  for (const toolId of getDiscoveredToolIds(sessionId)) {
    if (seen.has(toolId)) continue;
    ids.push(toolId);
    seen.add(toolId);
  }
  return ids;
}

/**
 * `kyberswap.swap.quote` → `kyberswap__swap_quote`.
 *
 * A catalog lookup, not a transform. Throws on an unregistered toolId: every
 * caller projects a manifest it already resolved, so an unknown id is a
 * programming error, and returning the dotted id unchanged would put a name
 * that cannot be called back into a provider `tools` array.
 */
export function toInjectedToolName(toolId: string): string {
  const manifest = getProtocolManifest(toolId);
  if (!manifest) {
    throw new Error(`toInjectedToolName: no protocol manifest registered for toolId "${toolId}"`);
  }
  return manifest.publicName;
}

/**
 * `kyberswap__swap_quote` → `kyberswap.swap.quote`, or `undefined` when no live
 * manifest claims the name.
 *
 * Table-driven, and deliberately PARTIAL: under the one-separator grammar an
 * unknown injected-shaped name has no derivable toolId, and inventing one by
 * string surgery is exactly the failure this table exists to prevent. Callers
 * that need something to show a user or a model must handle `undefined`.
 */
export function fromInjectedToolName(name: string): string | undefined {
  return TOOL_ID_BY_PUBLIC_NAME.get(name);
}

/**
 * Resolve an injected function name back to its manifest, or `undefined` when
 * the name is not an injected protocol tool (an internal tool, a typo, or a
 * hallucinated id). Callers MUST use the returned manifest — not the name —
 * for every gating decision.
 *
 * CATALOG-SELECTION BOUNDARY (approved plan section 5.5). This is the ONE
 * name-to-manifest resolver, so every consumer reaches the SAME manifest
 * whichever spelling it was handed: the plan-acceptance gate,
 * `dispatchTargetIsMutating`, the approval preview, the approval envelope, and
 * ToolSearch `select:` mode.
 *
 * A RETIRED name is answered from the alias table, which STATES the immutable
 * dotted toolId. It is never answered by inverting the name — inversion is not
 * defined under the one-separator grammar (see the module doc). The alias
 * branch is consulted FIRST-AFTER-CANONICAL in effect: `fromInjectedToolName`
 * only ever returns a LIVE publicName's id, so an alias can never shadow a live
 * tool (`identity-and-migration.md` section 2).
 */
export function resolveInjectedProtocolTool(name: string): ProtocolToolManifest | undefined {
  const aliasedToolId = resolveDeprecatedProtocolToolId(name);
  if (aliasedToolId !== undefined) return getProtocolManifest(aliasedToolId);
  const toolId = fromInjectedToolName(name);
  if (toolId === undefined) return undefined;
  return getProtocolManifest(toolId);
}

/**
 * True for a name in the injected NAMESPACE — one that is shaped like a
 * publicName, whether or not a live tool claims it.
 *
 * Deliberately a shape test rather than a catalog hit: its whole job is to
 * classify a name the catalog does NOT know, so the dispatcher can answer a
 * stale or misspelled protocol name by name instead of with the generic
 * unknown-internal-tool line. Under the target grammar the shape is EXACTLY one
 * double underscore with a non-empty half on each side, which no internal tool
 * name matches (asserted in `injected-protocol-tools.test.ts`).
 */
export function isInjectedToolNameShape(name: string): boolean {
  const halves = name.split(NAME_SEPARATOR);
  return halves.length === 2 && halves[0]!.length > 0 && halves[1]!.length > 0;
}

/**
 * Build the injected function schemas for a session: the always-injected
 * namespaces (D-DS9) in catalog order, then the discovery working set (oldest
 * first). With no always-injected namespace configured and nothing discovered
 * the array is empty and the tools array is byte-identical to the pre-D-DS9
 * behaviour.
 */
export function buildInjectedProtocolTools(ctx: ToolVisibilityContext): OpenAITool[] {
  const injected: OpenAITool[] = [];

  for (const toolId of injectionToolIds(ctx.sessionId)) {
    const manifest = getProtocolManifest(toolId);
    if (!manifest) continue;
    if (!isProtocolToolAvailable(manifest)) continue;
    if (!isAdvertisedProtocolNamespace(manifest.namespace)) continue;
    if (!passesPressureBarrier(manifest, ctx)) continue;

    injected.push({
      type: "function",
      function: {
        name: manifest.publicName,
        description: injectedDescription(manifest),
        parameters: paramsToJsonSchema(manifest.params),
      },
    });
  }

  return injected;
}

/**
 * The manifest description plus its cross-param group rules.
 *
 * A group rule is a fact about the CALL, not about one property, and JSON
 * Schema's ways of saying it (`oneOf`, `anyOf` over required sets) are exactly
 * the constructs provider function-schema validators narrow or reject. The
 * description is the channel every provider carries verbatim — and it is the
 * same sentence `ToolSearch` puts on the `constraints` row and the runtime
 * rejects with, so the model never sees the rule stated two ways.
 *
 * Appended, never substituted: a manifest with no groups keeps a byte-identical
 * description.
 */
function injectedDescription(manifest: ProtocolToolManifest): string {
  const constraints = describeParamGroupConstraints(manifest);
  if (constraints.length === 0) return manifest.description;
  return `${manifest.description} ${constraints.join(" ")}`;
}

/**
 * Exported so `ToolSearch` select mode runs the IDENTICAL barrier check this
 * projection runs. If select recorded a manifest injection would then drop, the
 * model would be told a tool is callable and find it missing from the very next
 * tools array — the silent loss the whole displacement-warning machinery exists
 * to prevent.
 *
 * Mirror of `visibility.ts`'s `passesPressureSafety` for protocol manifests:
 * at barrier/critical a mutating manifest is dropped from the catalog, unless
 * a live compaction preparation bypasses the barrier (contract C8).
 *
 * Deliberately conservative on preview/dryRun: `executeProtocolTool` treats a
 * preview call as a read and lets it through at barrier, but previewness is a
 * property of the ARGUMENTS, which do not exist at catalog time. Dropping the
 * whole manifest matches what `ToolSearch` already tells the model
 * (`unavailable_at_pressure: true`): the model is steered to the read-only or
 * preview tool in the same namespace, which is injected normally.
 */
export function passesPressureBarrier(
  manifest: ProtocolToolManifest,
  ctx: Pick<ToolVisibilityContext, "contextUsageBand" | "preparationBypassesBarrier">,
): boolean {
  if (!manifest.mutating) return true;
  const atBarrier = ctx.contextUsageBand === "barrier" || ctx.contextUsageBand === "critical";
  if (!atBarrier) return true;
  return ctx.preparationBypassesBarrier && ctx.contextUsageBand === "barrier";
}
