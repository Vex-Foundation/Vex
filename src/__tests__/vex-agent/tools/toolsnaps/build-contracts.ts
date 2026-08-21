/**
 * Builds the FINAL model-visible tool contract for every registered tool, which
 * is what `../toolsnaps.test.ts` snapshots.
 *
 * "Final" means the END of the projection pipeline, not the authored manifest:
 *
 *   internal tool  -> `toOpenAITools` (registry projection)
 *                  -> `normalizeToolSchemaForProvider` (inference layer)
 *   protocol tool  -> `buildInjectedProtocolTools` (injection, which APPENDS
 *                     cross-parameter group constraints to the description)
 *                  -> `normalizeToolSchemaForProvider`
 *
 * Nothing here re-implements a projection step; every definition is produced by
 * the production functions the provider request itself uses.
 *
 * THE BASELINE SCENARIO. Snapshots must be deterministic, so definitions are
 * projected under one named context (`MAXIMAL_SCENARIO`, documented in
 * `src/vex-agent/tools/__toolsnaps__/README.md`):
 *
 *   - mission session with an ACTIVE run, `permission: "full"`, plan mode on,
 *     session memory present, a prepared compaction summary ready;
 *   - `contextUsageBand: "normal"`, so no pressure-safety drop applies;
 *   - the three session-scoped reveals (Uniswap pair, `describe_tools`, a Relay
 *     route) all granted to the scenario session;
 *   - every `requiresEnv` variable the LIVE catalogs declare set to a dummy
 *     value for the duration of the build, so env-gated tools snapshot their
 *     real contract instead of vanishing.
 *
 * No single context can be maximal: `requiresMissionSetup` and
 * `requiresMissionRun` are mutually exclusive by construction. The baseline
 * chooses the ACTIVE RUN, so `mission_draft_update` is invisible under it. The
 * definition is still snapshotted, because withholding is a visibility decision
 * and not a change to the contract.
 *
 * GATES ARE MEASURED, NOT READ. Two of the visibility gates are NOT declared on
 * `ToolDef.visibility` at all: the Relay alias pair is filtered by a hard-coded
 * name set (`registry/relay-reveal.ts`'s `RELAY_REVEAL_GATED_ALIAS_NAMES`), and
 * the model-withheld set is another hard-coded name list inside
 * `registry/visibility.ts`. Reading declarations would therefore miss exactly
 * the gates with no declaration to read. So every gate below is recorded as a
 * BEHAVIORAL observation: the tool's presence in `getVisibleToolDefs` is
 * compared across scenarios that differ in exactly one axis. Deleting any of
 * those gates flips a recorded boolean and fails the snapshot.
 */

import type { ToolDef, OpenAITool, JsonSchema } from "@vex-agent/tools/types.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

import { toOpenAITools } from "@vex-agent/tools/types.js";
import { getAllTools, getVisibleToolDefs, defaultVisibilityContext } from "@vex-agent/tools/registry.js";
import type { ToolVisibilityContext } from "@vex-agent/tools/registry.js";
import {
  buildInjectedProtocolTools,
  toInjectedToolName,
  fromInjectedToolName,
} from "@vex-agent/tools/registry/injected-protocol-tools.js";
import {
  MAX_DISCOVERED_TOOLS_PER_SESSION,
  recordDiscoveredTools,
  clearDiscoveredTools,
} from "@vex-agent/tools/registry/discovered-tools.js";
import { revealUniswapPair, clearUniswapPairReveal } from "@vex-agent/tools/registry/uniswap-reveal.js";
import { revealDescribeTools, clearDescribeToolsReveal } from "@vex-agent/tools/registry/describe-tools-reveal.js";
import { revealRelayRoute, resolveRelayRevealRoute } from "@vex-agent/tools/registry/relay-reveal.js";
import { PROTOCOL_TOOLS, isAdvertisedProtocolNamespace } from "@vex-agent/tools/protocols/catalog.js";
import { normalizeToolSchemaForProvider } from "@vex-agent/inference/schema-normalizer.js";

import type { JsonValue } from "./snapshot-file.js";

/** Base session identity; each scenario appends its own suffix so reveals stay independent. */
const SCENARIO_SESSION = "toolsnaps-scenario";

/** Human-readable baseline label recorded in the catalog artifact. */
export const MAXIMAL_SCENARIO = "mission session, active run, permission=full, plan mode on, "
  + "session memory present, compaction summary ready, contextUsageBand=normal, "
  + "Uniswap/describe_tools/Relay reveals granted, all requiresEnv variables present";

/**
 * Dummy value written into every gate variable. Deliberately not a credential,
 * and never written into a snapshot: it only flips `requiresEnv` gates open so
 * an env-gated tool snapshots its contract.
 */
const GATE_ENV_VALUE = "toolsnaps-scenario-value";

/** The relay route revealed for the reveal-bearing scenarios (numeric chain ids, no network resolution). */
const SCENARIO_RELAY_ROUTE_PARAMS: Record<string, unknown> = {
  fromChain: "8453",
  fromToken: "native",
  toChain: "10",
  toToken: "native",
  amount: "1000000000000000",
};

/** One tool's snapshot payload: the final provider definition plus honest per-kind metadata. */
export interface ToolContract {
  /** Snapshot file basename (without `.json`) and the tool's stable identity in this harness. */
  readonly key: string;
  readonly payload: JsonValue;
}

export interface ToolContractSet {
  readonly contracts: readonly ToolContract[];
  readonly catalog: JsonValue;
  /** The internal block in the order the model sees it under the baseline scenario. */
  readonly internalVisibleOrder: readonly string[];
  /** Env variables the LIVE catalogs gate on, derived rather than hand-maintained. */
  readonly requiresEnvGates: readonly string[];
}

/**
 * Which axis of the baseline a scenario drops. Each scenario differs from the
 * baseline in EXACTLY ONE axis, so a visibility difference names its own cause.
 */
interface ScenarioVisibility {
  readonly baseline: ReadonlySet<string>;
  readonly withoutUniswapReveal: ReadonlySet<string>;
  readonly withoutDescribeToolsReveal: ReadonlySet<string>;
  readonly withoutRelayRouteReveal: ReadonlySet<string>;
  readonly withoutEnvGates: ReadonlySet<string>;
  readonly missionSetup: ReadonlySet<string>;
}

/**
 * Project the whole catalog. Mutates `process.env` for the derived gate
 * variables and the scenario sessions' reveal state, and restores both before
 * returning, so the harness leaves no state behind for other suites.
 */
export function buildToolContracts(): ToolContractSet {
  const requiresEnvGates = deriveRequiresEnvGates();
  const restoreEnv = openEnvGates(requiresEnvGates);
  const sessions = grantScenarioReveals();

  try {
    const visibility = measureScenarioVisibility(sessions, requiresEnvGates);
    const internalVisibleOrder = getVisibleToolDefs(
      scenarioContext({ sessionId: sessions.baseline }),
    ).map((tool) => tool.name);

    const internal = getAllTools().map((tool) => internalContract(tool, visibility));
    const injectedByToolId = projectInjectedProtocolTools();
    const protocol = [...PROTOCOL_TOOLS]
      .sort((a, b) => a.toolId.localeCompare(b.toolId))
      .map((manifest) => protocolContract(manifest, injectedByToolId.get(manifest.toolId)));

    const catalog: JsonValue = {
      scenario: MAXIMAL_SCENARIO,
      // ARRAY ORDER IS CONTRACT: this is the order the model sees the internal
      // block in, straight out of the visibility filter over `TOOLS`.
      internalVisibleOrder,
      internalRegisteredCount: internal.length,
      // Derived from the live registry + manifests. A new env gate anywhere in
      // the catalog appears here as a reviewed catalog diff.
      requiresEnvGates,
      maxDiscoveredToolsPerSession: MAX_DISCOVERED_TOOLS_PER_SESSION,
      maxSimultaneousModelVisibleTools: internalVisibleOrder.length + MAX_DISCOVERED_TOOLS_PER_SESSION,
      protocolToolIds: [...PROTOCOL_TOOLS].map((m) => m.toolId).sort(),
    };

    return { contracts: [...internal, ...protocol], catalog, internalVisibleOrder, requiresEnvGates };
  } finally {
    releaseScenarioReveals(sessions);
    restoreEnv();
  }
}

// ── Env gates ────────────────────────────────────────────────────

/**
 * The env variables the LIVE catalogs gate visibility on, collected from
 * `ToolDef.requiresEnv` and `ProtocolToolManifest.requiresEnv`. Derived on every
 * run rather than hand-listed, so a newly env-gated tool cannot quietly snapshot
 * as absent.
 *
 * `showOnlyWhenEnvMissing` is the INVERSE gate: setting such a variable would
 * HIDE its tool. Any overlap between the two sets would make "open all gates"
 * self-contradictory, so it throws here instead of silently choosing a side.
 */
function deriveRequiresEnvGates(): readonly string[] {
  const required = new Set<string>();
  const inverse = new Set<string>();

  for (const tool of getAllTools()) {
    if (tool.requiresEnv) required.add(tool.requiresEnv);
    if (tool.showOnlyWhenEnvMissing) inverse.add(tool.showOnlyWhenEnvMissing);
  }
  for (const manifest of PROTOCOL_TOOLS) {
    if (manifest.requiresEnv) required.add(manifest.requiresEnv);
  }

  const conflicting = [...required].filter((name) => inverse.has(name)).sort();
  if (conflicting.length > 0) {
    throw new Error(
      "toolsnaps: env var is both a requiresEnv gate and a showOnlyWhenEnvMissing gate "
      + `(${conflicting.join(", ")}); the snapshot scenario cannot open both. `
      + "Decide which surface the scenario should capture and record it explicitly",
    );
  }

  return [...required].sort();
}

/**
 * Set every derived gate variable, returning a restore function that puts
 * `process.env` back exactly as it was, including "was not set at all".
 */
function openEnvGates(gates: readonly string[]): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of gates) {
    previous.set(key, process.env[key]);
    process.env[key] = GATE_ENV_VALUE;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// ── Scenario sessions and visibility measurement ─────────────────

interface ScenarioSessions {
  readonly baseline: string;
  readonly noUniswapReveal: string;
  readonly noDescribeToolsReveal: string;
  readonly noRelayRouteReveal: string;
}

/**
 * Four sessions, each holding all reveals except the one it is named for.
 * A Relay reveal has no clear API in this module's direction, so the "no relay"
 * session simply never receives one; the other two are cleared on teardown.
 */
function grantScenarioReveals(): ScenarioSessions {
  const sessions: ScenarioSessions = {
    baseline: `${SCENARIO_SESSION}-baseline`,
    noUniswapReveal: `${SCENARIO_SESSION}-no-uniswap-reveal`,
    noDescribeToolsReveal: `${SCENARIO_SESSION}-no-describe-reveal`,
    noRelayRouteReveal: `${SCENARIO_SESSION}-no-relay-reveal`,
  };

  const route = resolveRelayRevealRoute(SCENARIO_RELAY_ROUTE_PARAMS);
  if (!route) throw new Error("toolsnaps: scenario relay route failed to resolve");

  for (const sessionId of [sessions.baseline, sessions.noDescribeToolsReveal, sessions.noRelayRouteReveal]) {
    revealUniswapPair(sessionId);
  }
  for (const sessionId of [sessions.baseline, sessions.noUniswapReveal, sessions.noRelayRouteReveal]) {
    revealDescribeTools(sessionId);
  }
  for (const sessionId of [sessions.baseline, sessions.noUniswapReveal, sessions.noDescribeToolsReveal]) {
    revealRelayRoute(sessionId, route);
  }

  return sessions;
}

function releaseScenarioReveals(sessions: ScenarioSessions): void {
  for (const sessionId of Object.values(sessions)) {
    clearUniswapPairReveal(sessionId);
    clearDescribeToolsReveal(sessionId);
  }
}

function measureScenarioVisibility(
  sessions: ScenarioSessions,
  gates: readonly string[],
): ScenarioVisibility {
  const visible = (ctx: ToolVisibilityContext): ReadonlySet<string> =>
    new Set(getVisibleToolDefs(ctx).map((tool) => tool.name));

  const restoreEnv = () => {
    for (const key of gates) process.env[key] = GATE_ENV_VALUE;
  };
  const closeEnv = () => {
    for (const key of gates) delete process.env[key];
  };

  closeEnv();
  const withoutEnvGates = visible(scenarioContext({ sessionId: sessions.baseline }));
  restoreEnv();

  return {
    baseline: visible(scenarioContext({ sessionId: sessions.baseline })),
    withoutUniswapReveal: visible(scenarioContext({ sessionId: sessions.noUniswapReveal })),
    withoutDescribeToolsReveal: visible(scenarioContext({ sessionId: sessions.noDescribeToolsReveal })),
    withoutRelayRouteReveal: visible(scenarioContext({ sessionId: sessions.noRelayRouteReveal })),
    withoutEnvGates,
    // The one axis the baseline cannot hold at the same time as an active run.
    missionSetup: visible(scenarioContext({ sessionId: sessions.baseline, missionRunActive: false })),
  };
}

function scenarioContext(overrides: Partial<ToolVisibilityContext>): ToolVisibilityContext {
  return defaultVisibilityContext({
    permission: "full",
    sessionKind: "mission",
    missionRunActive: true,
    planMode: true,
    contextUsageBand: "normal",
    hasSessionMemory: true,
    hasCompactionSummaryReady: true,
    preparationBypassesBarrier: false,
    ...overrides,
  });
}

// ── Per-tool contracts ───────────────────────────────────────────

function internalContract(tool: ToolDef, visibility: ScenarioVisibility): ToolContract {
  const projected = toOpenAITools([tool])[0];
  if (!projected) throw new Error(`toolsnaps: registry projection produced nothing for ${tool.name}`);

  const inBaseline = visibility.baseline.has(tool.name);
  const inMissionSetup = visibility.missionSetup.has(tool.name);

  return {
    key: tool.name,
    payload: {
      definition: definitionPayload(projected, normalizeToolSchemaForProvider(projected.function.parameters)),
      metadata: {
        kind: "internal",
        mutating: tool.mutating,
        pressureSafety: tool.pressureSafety,
        actionKind: tool.actionKind,
        gates: {
          proactive: tool.proactive ?? false,
          requiresEnv: tool.requiresEnv ?? null,
          showOnlyWhenEnvMissing: tool.showOnlyWhenEnvMissing ?? null,
          /** Declared `ToolDef.visibility` axes, verbatim. */
          declaredVisibility: declaredVisibilityGates(tool),
          /**
           * Measured gates. Each is "visible in the baseline but NOT in the
           * scenario that drops exactly this axis", so it stays true only while
           * the gate really filters this tool, whether or not it is declared.
           */
          measured: {
            hiddenWithoutUniswapReveal: inBaseline && !visibility.withoutUniswapReveal.has(tool.name),
            hiddenWithoutDescribeToolsReveal:
              inBaseline && !visibility.withoutDescribeToolsReveal.has(tool.name),
            // The Relay alias pair is gated by a hard-coded NAME SET rather than
            // a `ToolDef.visibility` flag, so this measurement is the only thing
            // that can notice the gate disappearing.
            hiddenWithoutRelayRouteReveal:
              inBaseline && !visibility.withoutRelayRouteReveal.has(tool.name),
            hiddenWithoutEnvGates: inBaseline && !visibility.withoutEnvGates.has(tool.name),
            visibleInMissionSetup: inMissionSetup,
          },
        },
        /** Absent from the baseline scenario's visible catalog. */
        withheld: !inBaseline,
        /**
         * Absent from BOTH mission-axis scenarios while every other gate is
         * satisfied, which is what the hard-coded model-withheld name set in
         * `registry/visibility.ts` produces. Removing that set flips this to
         * false and fails the snapshot, which is the point: `execute_tool` must
         * not silently rejoin the model-facing surface.
         */
        withheldFromModelSurface: !inBaseline && !inMissionSetup,
      },
    },
  };
}

function declaredVisibilityGates(tool: ToolDef): JsonValue {
  const visibility = tool.visibility;
  if (!visibility) return {};
  const gates: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(visibility)) {
    if (typeof value === "boolean" || typeof value === "string") gates[key] = value;
  }
  return gates;
}

function protocolContract(
  manifest: ProtocolToolManifest,
  injected: OpenAITool | undefined,
): ToolContract {
  return {
    key: toInjectedToolName(manifest.toolId),
    payload: {
      // `null` for a manifest the injection pipeline never emits (a
      // non-advertised namespace). Honest by construction: such a manifest has
      // NO model-visible definition, and fabricating one here would snapshot a
      // contract the model is never shown.
      definition: injected
        ? definitionPayload(injected, normalizeToolSchemaForProvider(injected.function.parameters))
        : null,
      metadata: {
        kind: "protocol",
        toolId: manifest.toolId,
        namespace: manifest.namespace,
        mutating: manifest.mutating,
        actionKind: manifest.actionKind,
        advertised: isAdvertisedProtocolNamespace(manifest.namespace),
        // The two halves of `isProtocolToolAvailable`. Protocol manifests carry
        // no `pressureSafety` field, so none is recorded for them.
        lifecycle: manifest.lifecycle,
        requiresEnv: manifest.requiresEnv ?? null,
      },
    },
  };
}

function definitionPayload(tool: OpenAITool, parameters: JsonSchema): JsonValue {
  return {
    type: tool.type,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: parameters as unknown as JsonValue,
    },
  };
}

/**
 * Run `buildInjectedProtocolTools` over the whole catalog.
 *
 * A session's discovered set is capped at `MAX_DISCOVERED_TOOLS_PER_SESSION`
 * by design, so the catalog is projected in batches under throwaway session ids
 * and merged by toolId. Batching changes nothing about a single definition:
 * injection reads only the manifest and the per-session gates, which are
 * identical across batches.
 */
function projectInjectedProtocolTools(): Map<string, OpenAITool> {
  const byToolId = new Map<string, OpenAITool>();
  const toolIds = [...PROTOCOL_TOOLS].map((m) => m.toolId).sort();

  for (let start = 0; start < toolIds.length; start += MAX_DISCOVERED_TOOLS_PER_SESSION) {
    const batch = toolIds.slice(start, start + MAX_DISCOVERED_TOOLS_PER_SESSION);
    const sessionId = `${SCENARIO_SESSION}-injection-batch-${start}`;
    try {
      recordDiscoveredTools(sessionId, batch);
      for (const injected of buildInjectedProtocolTools(defaultVisibilityContext({ sessionId }))) {
        byToolId.set(fromInjectedToolName(injected.function.name), injected);
      }
    } finally {
      clearDiscoveredTools(sessionId);
    }
  }

  return byToolId;
}
