/**
 * `ToolSearch` select mode - make tools the model already knows the name of
 * callable again.
 *
 * WHAT IT REPLACES. This is the whole of the retired manifest-fetch tool, minus
 * its defining mistake. That tool answered with a FULL MANIFEST DUMP: the
 * complete param schema, the required list, the constraints and a worked
 * example, all of which were then re-materialized as the real injected function schema on the next
 * request. The model read the same schema twice, and only the second copy was
 * enforceable. Select answers with ACKNOWLEDGEMENT ROWS ONLY
 * (`tool-surface-spec/toolsearch-design.md` §2.2, §3.2); the schema arrives
 * exclusively through injection.
 *
 * WHY IT LIVES IN THE DISPATCHER LANE AND NOT IN `protocols/discovery.ts`.
 * Select resolves a MODEL-VISIBLE NAME, and the one authoritative name-to-
 * manifest resolver is `registry/injected-protocol-tools.ts`
 * (`resolveInjectedProtocolTool`), which the protocol layer must not depend on.
 * The three consumers that must agree about which manifest a name denotes - the
 * plan-acceptance gate, the injected-call route, and select - therefore all sit
 * on this side of the boundary and share that one resolver.
 *
 * GATING IS OFF THE RESOLVED MANIFEST, NEVER OFF THE NAME. A name is resolved
 * first, then the manifest is put through the SAME chain injection applies:
 * advertised namespace, lifecycle + env availability, and the pressure barrier.
 * Running a weaker chain here would make select a bypass that hands the model a
 * tool `buildInjectedProtocolTools` then silently declines to inject, or one
 * `executeProtocolTool` then hard-rejects.
 *
 * REJECTION NAMES THE REAL CAUSE. There is no hidden-tool set left to protect:
 * owner decision D4 retired the Uniswap and Relay reveal gates, so no advertised
 * manifest is invisible to a session that asks for it by name, and the no-leak
 * exception `toolsearch-design.md` §5 reserved for reveal-gated ids has no
 * subject in this tree. Should a session-scoped reveal ever return, it must be
 * added HERE as an explicit unknown-shaped answer rather than as a new reason
 * string.
 */

import {
  MAX_DISCOVERED_TOOLS_PER_SESSION,
  getDiscoveredToolIds,
  recordDiscoveredTools,
} from "../registry/discovered-tools.js";
import {
  passesPressureBarrier,
  resolveInjectedProtocolTool,
} from "../registry/injected-protocol-tools.js";
import {
  buildDisplacementWarning,
  describeManifestRejection,
  evaluateManifestDiscoverability,
} from "../protocols/discovery.js";
import type {
  ProtocolDiscoveryRequest,
  ToolSearchSelectResult,
  ToolSearchSelectRow,
} from "../protocols/types.js";

/** What select needs from the calling session. */
export interface ToolSearchSelectContext {
  sessionId?: string;
  contextUsageBand?: ProtocolDiscoveryRequest["contextUsageBand"];
  preparationBypassesBarrier?: boolean;
}

/**
 * The next-request statement, carried as the FIRST key of the envelope.
 *
 * It is a mechanical property of the Vex serving path, not something the model
 * can infer: the working set is written during dispatch of THIS call, and
 * `getOpenAITools` reads it while assembling the tools array for the NEXT
 * request. A model that tries to call a just-selected tool in the same
 * assistant turn gets an unknown-tool refusal, so the fact is stated rather
 * than assumed. This is NOT Anthropic's inline tool-definition expansion.
 */
const SELECT_NEXT_STEP =
  "These tools are now in your tool list with their full parameter schemas, "
  + "callable from your NEXT message - not from this one.";

/** One line: the first sentence of the manifest description, for a rejection that has none. */
function unknownNameReason(publicName: string): string {
  return (
    `"${publicName}" is not a callable tool name. Search for the capability you need `
    + "(ToolSearch with an intent phrase) or list the protocol's namespace, and select a name "
    + "exactly as it was returned."
  );
}

/**
 * Resolve, gate and record a select list.
 *
 * Duplicates are collapsed and REPORTED rather than silently deduplicated: the
 * model asked for N names and must be able to reconcile N against `count`.
 */
export function selectProtocolTools(
  publicNames: readonly string[],
  ctx: ToolSearchSelectContext,
): ToolSearchSelectResult {
  const warnings: string[] = [];

  const unique = [...new Set(publicNames)];
  if (unique.length !== publicNames.length) {
    const repeated = [
      ...new Set(publicNames.filter((name, i) => publicNames.indexOf(name) !== i)),
    ];
    warnings.push(
      `Requested ${publicNames.length} names but ${repeated.map((n) => `"${n}"`).join(", ")} `
      + `${repeated.length === 1 ? "was" : "were"} repeated - each tool is selected once.`,
    );
  }

  const rows: ToolSearchSelectRow[] = [];
  const accepted: string[] = [];

  for (const publicName of unique) {
    const manifest = resolveInjectedProtocolTool(publicName);
    if (!manifest) {
      rows.push({ publicName, status: "rejected", reason: unknownNameReason(publicName) });
      continue;
    }

    const discoverability = evaluateManifestDiscoverability(manifest);
    if (!discoverability.ok) {
      rows.push({
        publicName,
        status: "rejected",
        reason: describeManifestRejection(publicName, discoverability),
      });
      continue;
    }

    // The barrier check injection will apply. Recording a manifest that will not
    // be injected would promise a tool the next tools array does not contain.
    if (!passesPressureBarrier(manifest, {
      contextUsageBand: ctx.contextUsageBand ?? "normal",
      preparationBypassesBarrier: ctx.preparationBypassesBarrier === true,
    })) {
      rows.push({
        publicName,
        status: "rejected",
        reason:
          `"${publicName}" is mutating and context pressure is at the barrier - the dispatcher `
          + "would refuse it right now. Select a read-only or preview tool in the same protocol, "
          + "or select it again after the context is compacted.",
      });
      continue;
    }

    // The row states the OUTCOME, not the manifest. Recording below is what
    // makes the promise true; the schema arrives by injection.
    rows.push({ publicName: manifest.publicName, status: "callable_next_request" });
    accepted.push(manifest.toolId);
  }

  // Same call, same machinery as query mode, so the injected schema and the
  // displacement sentence are identical whichever mode produced the row.
  const displacement = buildDisplacementWarning(
    recordDiscoveredTools(ctx.sessionId, accepted),
  );
  if (displacement !== null) warnings.push(displacement);

  return {
    nextStep: SELECT_NEXT_STEP,
    // A partial batch is a SUCCESS with named losses; only a call where nothing
    // resolved is a failure.
    success: accepted.length > 0,
    count: accepted.length,
    tools: rows,
    warnings,
    sessionCapacity: {
      used: getDiscoveredToolIds(ctx.sessionId).length,
      max: MAX_DISCOVERED_TOOLS_PER_SESSION,
    },
  };
}
