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
import { acquireProjectLease } from "./project-lifecycle-gate.js";
import { app } from "electron";

import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import type {
  StudioArtifactOutcome,
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
import { projectDeletingError, projectNotFoundError } from "./project-errors.js";
import {
  resolveProjectDirectory,
  resolveProjectsRoot,
} from "./projects-root.js";
import {
  describeIoFailure,
  hashText,
  readConfinedFile,
  replaceConfinedFile,
} from "./installer/confined-fs.js";
import { locateStudioBridge } from "./installer/bridge-path.js";
import { resolveArtifactPath } from "./installer/paths.js";
import {
  STUDIO_AGENTS_MD_RELATIVE_PATH,
  buildStudioPlan,
  studioGeneratorFingerprint,
  type StudioArtifactPlan,
  type StudioPlan,
} from "./installer/plan.js";
import { enqueueStudioRender } from "./installer/queue.js";
import {
  reconcileStudioArtifacts,
  type ArtifactProvenanceWrite,
  type ReconcileResult,
} from "./installer/reconcile.js";

export { __resetStudioRenderQueuesForTests } from "./installer/queue.js";

/**
 * Why a render is running. `repair` is the only trigger that overwrites drift.
 *
 * `superseded` is deliberately NOT a member: it is an ANSWER a run can give,
 * never a reason a caller can ask for one.
 */
export type StudioRenderTrigger = "create" | "scope_update" | "repair";

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
        // has: it did nothing, and the newer job owns the result. That is not a
        // FAILURE - the work is being done by the job that overtook this one -
        // so `runFailure` stays null and `trigger` carries the answer.
        scopeVersion: 1,
        completed: false,
        trigger: "superseded",
        artifacts: [],
        warnings: [],
        runFailure: null,
      }),
  });
}

async function runRender(
  projectId: string,
  trigger: StudioRenderTrigger,
  correlationId: string,
): Promise<Result<StudioRenderOutcome, VexError>> {
  // A RENDER LEASE, before the first await. A render writes into the project's
  // folder, so a delete has to be able to both refuse new ones and know this
  // one is running. The teardown that runs during a delete holds the
  // administrative token and is admitted through the same gate.
  const admission = acquireProjectLease(projectId, "render");
  if (!admission.ok) return err(projectDeletingError(correlationId));
  try {
    return await runRenderAdmitted(projectId, trigger, correlationId);
  } finally {
    admission.lease.release();
  }
}

async function runRenderAdmitted(
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
    // A RUN FAILURE, not a warning. This used to report itself as a
    // `launch_required` warning with a null agent, which put "Vex reconciled
    // this project's files" and "Select a coding agent to get one" above a
    // footnote saying the opposite. Nothing was written and nothing CAN be
    // written until the binary is there, so that is the headline.
    return ok({
      scopeVersion: scope.scopeVersion,
      completed: false,
      trigger,
      artifacts: [],
      warnings: [],
      runFailure: { kind: "bridge_unavailable", detail: bridge.detail },
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
  const plan = buildStudioPlan({
    selectedAgentIds: scope.agents,
    previouslyWritten: new Set(provenance.keys()),
  });

  const io = {
    replaceFile: replaceConfinedFile,
    // Both REPORT the failure to the reconciler instead of swallowing it. The
    // log line stays for the operator; the boolean is what stops the run from
    // claiming a result it cannot prove.
    commitProvenance: async (record: ArtifactProvenanceWrite) => {
      const committed = await commitArtifactProvenance(projectId, record);
      if (!committed.ok) {
        log.error(
          `[studio:installer] provenance for ${record.artifactKey} was not persisted `
            + `projectId=${projectId} correlationId=${correlationId}`,
        );
      }
      return committed.ok;
    },
    clearProvenance: async (artifactKey: string) => {
      const cleared = await clearArtifactProvenance(projectId, artifactKey);
      if (!cleared.ok) {
        log.error(
          `[studio:installer] provenance for ${artifactKey} was not cleared `
            + `projectId=${projectId} correlationId=${correlationId}`,
        );
      }
      return cleared.ok;
    },
  };

  // TWO PASSES, AND `AGENTS.md` IS THE SECOND ONE.
  //
  // The managed block PROMISES its reader, in `renderStudioChangeLog`, that
  // "every regeneration that changed anything adds a line here". With one pass
  // that was false by construction: the brief was built before reconciliation
  // and the note was appended after it, so the line describing a run only ever
  // appeared in the NEXT run's file. A reader comparing the change log against
  // what had just happened to their repo saw the previous change, which is
  // exactly the "silent rewrite" the section exists to rule out.
  //
  // So every other artifact is reconciled first, THIS run's note is composed
  // from what those artifacts actually did, and `AGENTS.md` is rendered last
  // from a brief that already carries it.
  const firstPass = await reconcileStudioArtifacts({
    projectDirectory: directory.data,
    plan: {
      artifacts: plan.artifacts.filter((artifact) => artifact.kind !== "agents-md"),
      unsupported: plan.unsupported,
    },
    facts,
    brief: buildProjectBrief(scope, notesOutcome.data),
    provenance,
    repair: trigger === "repair",
    io,
  });

  // The note is composed ONLY when the first pass changed something. Injecting
  // one unconditionally would change the block on every run, which would write
  // `AGENTS.md`, which would justify the note: a self-fulfilling loop that
  // rewrites a user's file forever. `AGENTS.md` is named in the summary because
  // a note that lands in the block is itself a change to the block.
  const firstPassChanged = firstPass.artifacts.some(
    (outcome) => outcome.status === "written" || outcome.status === "removed",
  );
  const pendingNote = firstPassChanged
    ? {
      version: appVersion(),
      date: isoDate(new Date()),
      summary: summarizeRun(
        [
          ...firstPass.artifacts,
          { status: "written", path: STUDIO_AGENTS_MD_RELATIVE_PATH },
        ],
        trigger,
      ),
    }
    : null;

  const secondPass = await reconcileStudioArtifacts({
    projectDirectory: directory.data,
    plan: {
      artifacts: plan.artifacts.filter((artifact) => artifact.kind === "agents-md"),
      unsupported: [],
    },
    facts,
    brief: buildProjectBrief(
      scope,
      pendingNote === null ? notesOutcome.data : [pendingNote, ...notesOutcome.data],
    ),
    provenance,
    repair: trigger === "repair",
    io,
  });

  const result: ReconcileResult = {
    // Restored to the PLAN's order, so the outcome list a caller reads does not
    // depend on the internal two-pass split.
    artifacts: orderByPlan(plan, [...firstPass.artifacts, ...secondPass.artifacts]),
    warnings: [...firstPass.warnings, ...secondPass.warnings],
    completed: firstPass.completed && secondPass.completed,
  };

  const changed = result.artifacts.some(
    (outcome) => outcome.status === "written" || outcome.status === "removed",
  );

  // THE REPORTED FLAG IS THE MARKER'S, NOT THE RECONCILER'S.
  //
  // `recordCompleteRender` is guarded on the scope version: a scope edit that
  // committed while the files were being written means this run rendered an
  // older authority, so the UPDATE matches no row and the marker stays where it
  // was. That refusal is the whole point of the guard, and reporting
  // `completed: true` over it would tell the user their project is up to date
  // while the durable record says a reconciliation is still owed - the exact
  // disagreement the marker exists to prevent.
  let completed = result.completed;
  if (result.completed) {
    const advanced = await recordCompleteRender(
      projectId,
      scope.scopeVersion,
      studioGeneratorFingerprint(appVersion()),
    );
    if (!advanced.ok) return advanced;
    if (!advanced.data) {
      completed = false;
      log.info(
        `[studio:installer] the render marker was not advanced: the scope moved during the run `
          + `projectId=${projectId} scopeVersion=${String(scope.scopeVersion)} `
          + `correlationId=${correlationId}`,
      );
    }
  }

  if (changed) {
    // Persisted from the ACTUAL outcomes, not from `pendingNote`. The two agree
    // whenever `AGENTS.md` was written, which is the case where the file and
    // the store both carry the line. If the block refused (a half-open fence,
    // say), the file was not rewritten at all, so the store keeps the honest
    // record of what the run really did and the next render shows it.
    const note = await appendChangeNote(projectId, {
      version: pendingNote?.version ?? appVersion(),
      date: pendingNote?.date ?? isoDate(new Date()),
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
    completed,
    trigger,
    artifacts: [...result.artifacts],
    warnings: [...result.warnings],
    runFailure: null,
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
      `[studio:installer] the project folder could not be resolved `
        + `correlationId=${correlationId} ${describeIoFailure(cause)}`,
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
      // NAMED, not described. The block used to call this set "the core wallet
      // tools", which stopped being true once swap, bridge, chain-read, token,
      // research and social tools joined the hot set.
      alwaysLoadedNames: internal.map((tool) => tool.publicName),
      searchableCount: protocol.length,
      protocols: [...byNamespace].map(([name, toolCount]) => ({ name, toolCount })),
    },
    changeNotes: boundStudioChangeNotes(changeNotes),
  };
}

/**
 * One line naming what this run changed, for the change-note log.
 *
 * Names EVERY file, because that is what a reader of `AGENTS.md` can go and
 * look at, and because a change note that says "and 9 more file(s)" points at
 * no retrieval path: the note IS the record, so a name it drops is a name
 * nobody can recover.
 *
 * Listing all of them is safe by construction, not by luck. The artifact roster
 * is CLOSED - one config path per agent in the registry plus `AGENTS.md`,
 * `CLAUDE.md` and `.vex/protocols.md` - and the longest possible line, every
 * artifact of the full roster written in one run, is 296 characters against the
 * 400-character `project_change_notes.summary` CHECK (migration 089).
 * `studio-change-note-bound.test.ts` re-measures that against the live registry
 * so a future agent whose path pushes the worst case over the column bound
 * fails a test here rather than an INSERT in front of a user.
 */
function summarizeRun(
  artifacts: readonly { status: string; path: string | null }[],
  trigger: StudioRenderTrigger,
): string {
  const touched = artifacts
    .filter((outcome) => outcome.status === "written" || outcome.status === "removed")
    .map((outcome) => outcome.path)
    .filter((path): path is string => path !== null);

  // One word per trigger. `created` is no longer than the `repaired` that
  // `studio-change-note-bound.test.ts` already measures the worst case against,
  // so the new trigger cannot push a line past the column's CHECK.
  const prefix =
    trigger === "repair" ? "repaired" : trigger === "create" ? "created" : "updated";
  if (touched.length === 0) return `${prefix} this project's Vex files`;
  return `${prefix} ${touched.join(", ")}`;
}

/**
 * Put the two passes' outcomes back into the plan's own order.
 *
 * The split between "everything else" and "`AGENTS.md`" is an ordering
 * requirement of the change log, not a change to the report. Unsupported
 * selections have no plan artifact and keep their leading position.
 */
function orderByPlan(
  plan: StudioPlan,
  outcomes: readonly StudioArtifactOutcome[],
): readonly StudioArtifactOutcome[] {
  const position = new Map<string, number>();
  plan.artifacts.forEach((artifact, index) => {
    position.set(`${artifact.kind}:${artifact.relativePath}`, index);
  });
  const rank = (outcome: StudioArtifactOutcome): number =>
    outcome.path === null
      ? -1
      : position.get(`${outcome.kind}:${outcome.path}`) ?? Number.MAX_SAFE_INTEGER;
  return [...outcomes].sort((left, right) => rank(left) - rank(right));
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
