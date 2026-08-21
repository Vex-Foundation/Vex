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
 * GATES ARE MEASURED, NOT READ. A visibility gate need not be declared on
 * `ToolDef.visibility` to exist, so reading declarations alone would miss
 * exactly the gate with no declaration to read. Every gate below is therefore
 * recorded as a BEHAVIORAL observation: the tool's presence in
 * `getVisibleToolDefs` is compared across scenarios that differ in exactly one
 * axis. Deleting any of those gates flips a recorded boolean and fails the
 * snapshot.
 *
 * THREE MEASURED AXES WERE DELETED, not set to false. Owner decision D4 retired
 * the Uniswap-pair and Relay-route reveals; D2 and the ToolSearch merge retired
 * the manifest-fetch reveal along with the tool it hid. None of the three can
 * measure anything any more: there is no scenario that can differ on an axis
 * that does not exist, and a permanently `false` boolean would read as "the
 * gate is there and open" rather than "the gate is gone". Removing the keys
 * makes the change visible in every affected snapshot diff, which is the honest
 * record.
 *
 * THE MODEL-WITHHELD SET IS ALSO GONE. `execute_tool` was the only name in it
 * and its `ToolDef` is now deleted outright, so `withheldFromModelSurface` has
 * no subject either. A retired tool cannot rejoin the surface by having a
 * filter removed; the registry itself is the record.
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
import { PROTOCOL_TOOLS, isAdvertisedProtocolNamespace } from "@vex-agent/tools/protocols/catalog.js";
import { normalizeToolSchemaForProvider } from "@vex-agent/inference/schema-normalizer.js";

import type { JsonValue } from "./snapshot-file.js";

/** Base session identity; each scenario appends its own suffix so sessions stay independent. */
const SCENARIO_SESSION = "toolsnaps-scenario";

/** Human-readable baseline label recorded in the catalog artifact. */
export const MAXIMAL_SCENARIO = "mission session, active run, permission=full, plan mode on, "
  + "session memory present, compaction summary ready, contextUsageBand=normal, "
  + "all requiresEnv variables present";

/**
 * Dummy value written into every gate variable. Deliberately not a credential,
 * and never written into a snapshot: it only flips `requiresEnv` gates open so
 * an env-gated tool snapshots its contract.
 */
const GATE_ENV_VALUE = "toolsnaps-scenario-value";

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
  readonly withoutEnvGates: ReadonlySet<string>;
  readonly missionSetup: ReadonlySet<string>;
}

/**
 * Project the whole catalog. Mutates `process.env` for the derived gate
 * variables for the duration of the build and restores them before
 * returning, so the harness leaves no state behind for other suites.
 */
export function buildToolContracts(): ToolContractSet {
  const requiresEnvGates = deriveRequiresEnvGates();
  const restoreEnv = openEnvGates(requiresEnvGates);
  const sessions = scenarioSessions();

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
}

/**
 * One session. Every session-scoped REVEAL is retired (D4, D2), so no scenario
 * needs a second identity any more; the id remains because the visibility
 * context still carries one and the injected-tool projection keys on it.
 */
function scenarioSessions(): ScenarioSessions {
  return { baseline: `${SCENARIO_SESSION}-baseline` };
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
            hiddenWithoutEnvGates: inBaseline && !visibility.withoutEnvGates.has(tool.name),
            visibleInMissionSetup: inMissionSetup,
          },
        },
        /** Absent from the baseline scenario's visible catalog. */
        withheld: !inBaseline,
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
        // The reverse lookup is table-driven and PARTIAL since publicName
        // landed. It cannot miss here — every injected name came from a live
        // manifest one line earlier — so a miss is a broken projection, not a
        // snapshot to write with a fabricated key.
        const toolId = fromInjectedToolName(injected.function.name);
        if (toolId === undefined) {
          throw new Error(
            `injected name "${injected.function.name}" resolves to no manifest - `
            + "the publicName projection and its reverse map disagree",
          );
        }
        byToolId.set(toolId, injected);
      }
    } finally {
      clearDiscoveredTools(sessionId);
    }
  }

  return byToolId;
}
