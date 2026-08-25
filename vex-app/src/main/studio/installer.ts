/**
 * THE PUBLIC GATE of the Vex Studio installer (stage A5b).
 *
 * One entry point to render a project's files, one to inspect them. Everything
 * else in `installer/` is private to this module's contract.
 *
 * THE SHAPE OF ONE RUN, and why it is in this order:
 *
 *   1. ENQUEUE per project. Two renders of one project never overlap, and an
 *      update that a newer update overtook while waiting reports `superseded`
 *      and touches nothing.
 *   2. RELOAD the latest committed scope. The caller's scope is not used - by
 *      the time a job runs, it may not be the truth any more.
 *   3. RESOLVE the project directory from the ANCHORED projects root. The root
 *      is proved unchanged first: `root_path` is relative to the recorded root,
 *      so a moved root would send every write somewhere else.
 *   4. LOCATE the bridge binary. Configs name it verbatim; a config pointing at
 *      a binary that is not there is worse than no config, so an unavailable
 *      bridge stops the run with a named reason.
 *   5. BUILD the brief from the reloaded scope, the LIVE tool inventory and the
 *      durable change-note log.
 *   6. RECONCILE every artifact, committing each one's provenance as it lands.
 *   7. ADVANCE the completion marker ONLY on a complete run whose scope version
 *      is still current, and append ONE change note when anything changed.
 *
 * NOTHING HERE DELETES A FILE. The strongest write is a replacement, and the
 * strongest removal is taking Vex's own entry back out of a file that stays.
 */

import { realpath } from "node:fs/promises";
import { app } from "electron";

import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import type {
  StudioArtifactStatus,
  StudioFilesStatus,
  StudioRenderOutcome,
} from "@shared/schemas/studio-installer.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import {
  boundStudioChangeNotes,
  claudeMdImportsAgents,
  inspectStudioManagedBlock,
  readStudioOwnedRegion,
  type StudioProjectBrief,
  type StudioProjectFacts,
} from "@vex-agent/studio/installer/render/index.js";
import { renderStudioProtocolsDoc } from "@vex-agent/studio/instructions/protocols-doc.js";
import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import { STUDIO_AGENTS } from "@vex-agent/studio/agents.js";
import {
  appendChangeNote,
  clearArtifactProvenance,
  commitArtifactProvenance,
  readArtifactProvenance,
  readChangeNotes,
  recordCompleteRender,
} from "../database/projects/installer-provenance.js";
import {
  readProjectRenderScope,
  type ProjectRenderScope,
} from "../database/projects/render-scope.js";
import { log } from "../logger/index.js";
import { projectNotFoundError } from "./project-errors.js";
import {
  resolveProjectDirectory,
  resolveProjectsRoot,
} from "./projects-root.js";
import { hashText, readConfinedFile, replaceConfinedFile } from "./installer/confined-fs.js";
import { locateStudioBridge } from "./installer/bridge-path.js";
import { resolveArtifactPath } from "./installer/paths.js";
import {
  buildStudioPlan,
  studioGeneratorFingerprint,
  type StudioArtifactPlan,
} from "./installer/plan.js";
import { enqueueStudioRender } from "./installer/queue.js";
import { reconcileStudioArtifacts } from "./installer/reconcile.js";

export { __resetStudioRenderQueuesForTests } from "./installer/queue.js";

/** Why a render is running. `repair` is the only trigger that overwrites drift. */
export type StudioRenderTrigger = "scope_update" | "repair";

/**
 * Render (or repair) one project's files.
 *
 * Always resolves with an outcome. A run that could not start at all - no such
 * project, an unusable projects root - returns a `VexError`, because there is
 * nothing per-artifact to report; everything else is reported per artifact.
 */
export async function renderProjectFiles(
  projectId: string,
  trigger: StudioRenderTrigger,
  correlationId: string,
): Promise<Result<StudioRenderOutcome, VexError>> {
  return enqueueStudioRender<Result<StudioRenderOutcome, VexError>>({
    projectId,
    kind: trigger === "repair" ? "repair" : "update",
    run: () => runRender(projectId, trigger, correlationId),
    whenSuperseded: () =>
      ok({
        // A superseded job never read a scope, so it reports the one fact it
        // has: it did nothing, and the newer job owns the result.
        scopeVersion: 1,
        completed: false,
        trigger: "superseded",
        artifacts: [],
        warnings: [],
      }),
  });
}

async function runRender(
  projectId: string,
  trigger: StudioRenderTrigger,
  correlationId: string,
): Promise<Result<StudioRenderOutcome, VexError>> {
  const scopeOutcome = await readProjectRenderScope(projectId);
  if (!scopeOutcome.ok) return scopeOutcome;
  const scope = scopeOutcome.data;
  if (scope === null) return err(projectNotFoundError(correlationId));

  const directory = await resolveProjectDirectoryPath(scope, correlationId);
  if (!directory.ok) return directory;

  const bridge = await locateStudioBridge();
  if (bridge.kind === "unavailable") {
    return ok({
      scopeVersion: scope.scopeVersion,
      completed: false,
      trigger: trigger === "repair" ? "repair" : "scope_update",
      artifacts: [],
      warnings: [
        { kind: "launch_required", agentId: null, detail: bridge.detail },
      ],
    });
  }

  const provenanceOutcome = await readArtifactProvenance(projectId);
  if (!provenanceOutcome.ok) return provenanceOutcome;
  const provenance = provenanceOutcome.data;

  const notesOutcome = await readChangeNotes(projectId);
  if (!notesOutcome.ok) return notesOutcome;

  const facts: StudioProjectFacts = {
    projectId: scope.projectId,
    bridgeCommand: bridge.command,
  };
  const brief = buildProjectBrief(scope, notesOutcome.data);
  const plan = buildStudioPlan({
    selectedAgentIds: scope.agents,
    previouslyWritten: new Set(provenance.keys()),
  });

  const result = await reconcileStudioArtifacts({
    projectDirectory: directory.data,
    plan,
    facts,
    brief,
    provenance,
    repair: trigger === "repair",
    io: {
      replaceFile: replaceConfinedFile,
      commitProvenance: async (record) => {
        const committed = await commitArtifactProvenance(projectId, record);
        if (!committed.ok) {
          // The file IS written. Losing its provenance means the next run sees
          // an entry it cannot prove and refuses it as a collision - visible and
          // safe, never a silent overwrite - so this is logged, not thrown.
          log.error(
            `[studio:installer] provenance for ${record.artifactKey} was not persisted `
              + `projectId=${projectId} correlationId=${correlationId}`,
          );
        }
      },
      clearProvenance: async (artifactKey) => {
        const cleared = await clearArtifactProvenance(projectId, artifactKey);
        if (!cleared.ok) {
          log.error(
            `[studio:installer] provenance for ${artifactKey} was not cleared `
              + `projectId=${projectId} correlationId=${correlationId}`,
          );
        }
      },
    },
  });

  const changed = result.artifacts.some(
    (outcome) => outcome.status === "written" || outcome.status === "removed",
  );

  if (result.completed) {
    // Guarded on the scope version: a scope edit that committed while the files
    // were being written means this run rendered an older authority, and
    // claiming it would mark the project up to date when it is not.
    const advanced = await recordCompleteRender(
      projectId,
      scope.scopeVersion,
      studioGeneratorFingerprint(appVersion()),
    );
    if (!advanced.ok) return advanced;
  }

  if (changed) {
    const note = await appendChangeNote(projectId, {
      version: appVersion(),
      date: isoDate(new Date()),
      summary: summarizeRun(result.artifacts, trigger),
    });
    if (!note.ok) {
      log.warn(
        `[studio:installer] a change note was not recorded projectId=${projectId}`,
      );
    }
  }

  return ok({
    scopeVersion: scope.scopeVersion,
    completed: result.completed,
    trigger: trigger === "repair" ? "repair" : "scope_update",
    artifacts: [...result.artifacts],
    warnings: [...result.warnings],
  });
}

/**
 * The DISK half of a project's file status, for the DTO.
 *
 * Read fresh on every project read. Drift is a filesystem fact and a cached
 * "clean" answer is exactly the silent overwrite the drift contract exists to
 * prevent, so this is not memoized.
 */
export async function enrichProjectFiles(
  project: ProjectDto,
  correlationId: string,
): Promise<StudioFilesStatus> {
  const scopeOutcome = await readProjectRenderScope(project.id);
  if (!scopeOutcome.ok || scopeOutcome.data === null) return project.files;
  const scope = scopeOutcome.data;

  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return project.files;
  const directory = resolveProjectDirectory(rootOutcome.data, scope.slug);
  if (directory === null) return project.files;

  const provenanceOutcome = await readArtifactProvenance(project.id);
  const provenance = provenanceOutcome.ok
    ? provenanceOutcome.data
    : new Map<string, { entryHash: string | null; contentHash: string }>();

  const notesOutcome = await readChangeNotes(project.id);
  const brief = buildProjectBrief(scope, notesOutcome.ok ? notesOutcome.data : []);

  const plan = buildStudioPlan({
    selectedAgentIds: scope.agents,
    previouslyWritten: new Set(provenance.keys()),
  });

  const artifacts: StudioArtifactStatus[] = plan.unsupported.map((item) => ({
    kind: "agent-config" as const,
    agentId: item.agentId,
    path: null,
    state: "unsupported" as const,
    detail: item.reason,
  }));

  for (const artifact of plan.artifacts) {
    if (artifact.operation === "remove") continue;
    artifacts.push(await inspectArtifact(directory, artifact, brief, provenance));
  }

  return {
    lastRenderedScopeVersion: project.files.lastRenderedScopeVersion,
    generatorFingerprint: project.files.generatorFingerprint,
    artifacts,
  };
}

async function inspectArtifact(
  projectDirectory: string,
  artifact: StudioArtifactPlan,
  brief: StudioProjectBrief,
  provenance: ReadonlyMap<string, { entryHash: string | null; contentHash: string }>,
): Promise<StudioArtifactStatus> {
  const base = {
    kind: artifact.kind,
    agentId: artifact.agentId,
    path: artifact.relativePath,
  };

  const resolution = await resolveArtifactPath(projectDirectory, artifact.relativePath);
  if (resolution.kind === "refused") {
    return { ...base, state: "unreadable", detail: resolution.detail };
  }
  if (!resolution.exists) {
    return { ...base, state: "missing", detail: null };
  }

  const read = await readConfinedFile(
    resolution.absolutePath,
    artifact.relativePath,
    resolution.mode,
  );
  if (read.kind === "refused") return { ...base, state: "unreadable", detail: read.detail };
  if (read.kind === "absent") return { ...base, state: "missing", detail: null };

  const recorded = provenance.get(artifact.key);

  switch (artifact.kind) {
    case "agent-config": {
      const region = readStudioOwnedRegion(read.text, artifact.agent);
      if (region.kind === "unreadable") {
        return { ...base, state: "unreadable", detail: region.detail };
      }
      if (region.kind === "absent") return { ...base, state: "missing", detail: null };
      if (recorded?.entryHash === undefined || recorded.entryHash === null) {
        return {
          ...base,
          state: "drifted",
          detail: "an entry named \"vex\" is present that Vex did not write",
        };
      }
      if (recorded.entryHash !== region.hash) {
        return { ...base, state: "drifted", detail: "the Vex entry was edited" };
      }
      return { ...base, state: "current", detail: null };
    }
    case "agents-md": {
      const state = inspectStudioManagedBlock(read.text, brief);
      switch (state.kind) {
        case "absent":
          return { ...base, state: "missing", detail: null };
        case "malformed":
          return { ...base, state: "unreadable", detail: state.detail };
        case "drifted":
          return { ...base, state: "drifted", detail: "the Vex section was edited" };
        case "intact":
          return state.upToDate
            ? { ...base, state: "current", detail: null }
            : {
              ...base,
              state: "stale",
              detail: "the Vex section predates this project's current settings",
            };
      }
      break;
    }
    case "claude-md":
      return claudeMdImportsAgents(read.text)
        ? { ...base, state: "current", detail: null }
        : recorded === undefined
          ? { ...base, state: "missing", detail: null }
          : {
            ...base,
            state: "drifted",
            detail: "the @AGENTS.md import Vex added is gone",
          };
    case "protocols-doc": {
      if (read.text === renderStudioProtocolsDoc()) {
        return { ...base, state: "current", detail: null };
      }
      return recorded !== undefined && recorded.contentHash !== hashText(read.text)
        ? { ...base, state: "drifted", detail: "the generated file was edited" }
        : { ...base, state: "stale", detail: "the tool inventory has changed since" };
    }
  }

  return { ...base, state: "unreadable", detail: "the artifact kind is unknown" };
}

/** Resolve `<anchored root>/<slug>` as a realpath, failing closed. */
async function resolveProjectDirectoryPath(
  scope: ProjectRenderScope,
  correlationId: string,
): Promise<Result<string, VexError>> {
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return rootOutcome;

  const directory = resolveProjectDirectory(rootOutcome.data, scope.slug);
  if (directory === null) return err(projectNotFoundError(correlationId));

  try {
    // The REALPATH is what every confinement comparison uses, so it is resolved
    // once here rather than re-derived from the configured string per artifact.
    return ok(await realpath(directory));
  } catch (cause) {
    log.warn(
      `[studio:installer] the project folder could not be resolved correlationId=${correlationId}`,
      cause,
    );
    return err(projectNotFoundError(correlationId));
  }
}

/** The brief the managed block renders from. Live inventory, never a pinned count. */
function buildProjectBrief(
  scope: ProjectRenderScope,
  changeNotes: readonly { version: string; date: string; summary: string }[],
): StudioProjectBrief {
  const inventory = buildStudioInventory();
  const internal = inventory.filter((tool) => tool.kind === "internal");
  const protocol = inventory.filter((tool) => tool.kind === "protocol");

  // Per-protocol counts, in inventory order, counted LIVE. A pinned table would
  // be wrong the first time a protocol lands, and an agent that believes a
  // wrong count stops searching for tools that exist.
  const byNamespace = new Map<string, number>();
  for (const tool of protocol) {
    const namespace = tool.namespace ?? "";
    byNamespace.set(namespace, (byNamespace.get(namespace) ?? 0) + 1);
  }

  return {
    projectName: scope.name,
    projectId: scope.projectId,
    vexVersion: appVersion(),
    permission: scope.permission === "full" ? "full" : "restricted",
    wallets: scope.wallets.map((wallet) => ({
      family: wallet.family,
      address: wallet.address,
    })),
    createdOn: isoDate(scope.createdAt),
    scopeUpdatedOn: isoDate(scope.updatedAt),
    agentNames: scope.agents.map((id) => STUDIO_AGENTS[id].displayName),
    inventory: {
      alwaysLoadedCount: internal.length,
      searchableCount: protocol.length,
      protocols: [...byNamespace].map(([name, toolCount]) => ({ name, toolCount })),
    },
    changeNotes: boundStudioChangeNotes(changeNotes),
  };
}

/**
 * One line naming what this run changed, for the change-note log.
 *
 * Names the FILES, because that is what a reader of `AGENTS.md` can go and
 * look at. Bounded by construction: the artifact list is bounded by the closed
 * agent roster, and the summary column is 400 characters, so the paths are
 * counted rather than listed once there are more than a handful.
 */
function summarizeRun(
  artifacts: readonly { status: string; path: string | null }[],
  trigger: StudioRenderTrigger,
): string {
  const touched = artifacts
    .filter((outcome) => outcome.status === "written" || outcome.status === "removed")
    .map((outcome) => outcome.path)
    .filter((path): path is string => path !== null);

  const prefix = trigger === "repair" ? "repaired" : "updated";
  if (touched.length === 0) return `${prefix} this project's Vex files`;
  if (touched.length <= 4) return `${prefix} ${touched.join(", ")}`;
  return `${prefix} ${touched.slice(0, 4).join(", ")} and ${String(touched.length - 4)} more file(s)`;
}

function isoDate(value: Date): string {
  // `YYYY-MM-DD` from an ISO timestamp: a fixed-width field extraction, not a
  // hidden cut. The full timestamp stays on the project row.
  return value.toISOString().slice(0, 10);
}

function appVersion(): string {
  try {
    return app.getVersion();
  } catch {
    // Outside an Electron runtime (unit tests). The fingerprint still has its
    // revision half, so it is never an empty string.
    return "0.0.0-dev";
  }
}
