/**
 * Discovered protocol tools → real OpenAI function schemas.
 *
 * Owner decision 2026-08-03 (SPEC §7 Q1, `reports/model-research.md` R1):
 * after `discover_tools` returns a ranked row, that manifest is appended to
 * the NEXT request's `tools` array as a genuine function definition, so the
 * provider enforces `required` instead of the model having to re-read a JSON
 * blob from a prior tool result. This is now THE calling path: `execute_tool`
 * is withheld from the model-visible surface (`./visibility.ts`), while its
 * dispatch route stays alive so an already-approved intent still resumes.
 *
 * NAME MAPPING. OpenAI function names must match `^[a-zA-Z0-9_-]{1,64}$`, so
 * the dotted toolId cannot be sent verbatim. `.` → `__` (double underscore),
 * which is bijective over this catalog: no toolId contains `__` and no dotted
 * segment starts or ends with `_`. Both facts are asserted over the WHOLE
 * catalog by `injected-protocol-tools.test.ts`, which is the guard that keeps
 * a future manifest from breaking the reverse map.
 *
 * GATING. Injection is a VISIBILITY decision only. Which manifests may be
 * shown is decided here (lifecycle + `requiresEnv` + advertised namespace +
 * the Uniswap reveal + the pressure barrier); whether a call may RUN is
 * decided, unchanged, by `executeProtocolTool` off the RESOLVED MANIFEST —
 * never off the function name. See `dispatcher/protocol-route.ts`.
 */

import type { OpenAITool } from "../types.js";
import type { ProtocolToolManifest } from "../protocols/types.js";
import {
  getProtocolManifest,
  isAdvertisedProtocolNamespace,
  isProtocolToolAvailable,
} from "../protocols/catalog.js";
import { paramsToJsonSchema } from "./khalani.js";
import { getDiscoveredToolIds } from "./discovered-tools.js";
import { isUniswapPairRevealed } from "./uniswap-reveal.js";
import type { ToolVisibilityContext } from "./visibility.js";

/** OpenAI function-name grammar. Exported so the catalog-wide test asserts the real constraint. */
export const OPENAI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** The separator dots map to. Chosen because no toolId contains it (asserted catalog-wide). */
const NAME_SEPARATOR = "__";

/**
 * Third mirror of the canonical hidden Uniswap swap toolIds
 * (`protocols/discovery.ts`, `protocols/runtime.ts`). Discovery already hides
 * them from an unrevealed session, but a reveal can EXPIRE after the ids were
 * recorded, so injection re-checks rather than trusting the recorded set.
 */
const REVEAL_GATED_UNISWAP_TOOL_IDS: ReadonlySet<string> = new Set([
  "uniswap.swap.quote",
  "uniswap.swap.execute",
]);

/** `kyberswap.swap.quote` → `kyberswap__swap__quote`. */
export function toInjectedToolName(toolId: string): string {
  return toolId.split(".").join(NAME_SEPARATOR);
}

/** `kyberswap__swap__quote` → `kyberswap.swap.quote`. Inverse of {@link toInjectedToolName}. */
export function fromInjectedToolName(name: string): string {
  return name.split(NAME_SEPARATOR).join(".");
}

/**
 * Resolve an injected function name back to its manifest, or `undefined` when
 * the name is not an injected protocol tool (an internal tool, a typo, or a
 * hallucinated id). Callers MUST use the returned manifest — not the name —
 * for every gating decision.
 */
export function resolveInjectedProtocolTool(name: string): ProtocolToolManifest | undefined {
  if (!isInjectedToolNameShape(name)) return undefined;
  return getProtocolManifest(fromInjectedToolName(name));
}

/**
 * True for a name in the injected namespace — i.e. one carrying the `__`
 * separator. No internal tool name or protocol alias contains it (asserted in
 * `injected-protocol-tools.test.ts`), so this shape test cleanly separates
 * "the model aimed at a protocol tool" from "unknown internal tool", and lets
 * the dispatcher answer a stale injected name by name instead of with the
 * generic unknown-tool line.
 */
export function isInjectedToolNameShape(name: string): boolean {
  return name.includes(NAME_SEPARATOR);
}

/**
 * Build the injected function schemas for a session, in discovery order
 * (oldest first). Empty when nothing was discovered — the tools array is then
 * byte-identical to today's.
 */
export function buildInjectedProtocolTools(ctx: ToolVisibilityContext): OpenAITool[] {
  const uniswapRevealed = isUniswapPairRevealed(ctx.sessionId);
  const injected: OpenAITool[] = [];

  for (const toolId of getDiscoveredToolIds(ctx.sessionId)) {
    const manifest = getProtocolManifest(toolId);
    if (!manifest) continue;
    if (!isProtocolToolAvailable(manifest)) continue;
    if (!isAdvertisedProtocolNamespace(manifest.namespace)) continue;
    if (REVEAL_GATED_UNISWAP_TOOL_IDS.has(toolId) && !uniswapRevealed) continue;
    if (!passesPressureBarrier(manifest, ctx)) continue;

    injected.push({
      type: "function",
      function: {
        name: toInjectedToolName(toolId),
        description: manifest.description,
        parameters: paramsToJsonSchema(manifest.params),
      },
    });
  }

  return injected;
}

/**
 * Mirror of `visibility.ts`'s `passesPressureSafety` for protocol manifests:
 * at barrier/critical a mutating manifest is dropped from the catalog, unless
 * a live compaction preparation bypasses the barrier (contract C8).
 *
 * Deliberately conservative on preview/dryRun: `executeProtocolTool` treats a
 * preview call as a read and lets it through at barrier, but previewness is a
 * property of the ARGUMENTS, which do not exist at catalog time. Dropping the
 * whole manifest matches what `discover_tools` already tells the model
 * (`unavailable_at_pressure: true`): the model is steered to the read-only or
 * preview tool in the same namespace, which is injected normally.
 */
function passesPressureBarrier(
  manifest: ProtocolToolManifest,
  ctx: ToolVisibilityContext,
): boolean {
  if (!manifest.mutating) return true;
  const atBarrier = ctx.contextUsageBand === "barrier" || ctx.contextUsageBand === "critical";
  if (!atBarrier) return true;
  return ctx.preparationBypassesBarrier && ctx.contextUsageBand === "barrier";
}
