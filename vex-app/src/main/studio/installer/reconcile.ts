/**
 * RECONCILIATION: bring every artifact of one project to the state its scope
 * implies, and report per artifact what actually happened.
 *
 * The order of checks per artifact is the safety contract, and it is the same
 * for every artifact:
 *
 *   1. CONFINE the path (`paths.ts`): no traversal, no symlinked component, no
 *      non-regular target, no oversized file, no ambiguous `.json`/`.jsonc`
 *      twin.
 *   2. READ the existing bytes as strict UTF-8 (`confined-fs.ts`).
 *   3. PROVE OWNERSHIP before touching anything. Something already at the Vex
 *      path is rewritten ONLY when the durable provenance digest matches what
 *      is there. Otherwise it is a COLLISION: the bytes stay, and the user is
 *      told which file and which entry.
 *   4. REJECT UNKNOWN KEYS BY NAME inside a proven Vex entry. A key Vex never
 *      writes appearing inside our own entry means somebody added something -
 *      possibly authority - to a region we are about to overwrite. Naming it is
 *      the difference between a report and a silent deletion.
 *   5. RENDER through the pure renderers, which merge and never clobber.
 *   6. REPLACE atomically, with the source digest verified immediately before
 *      the rename.
 *   7. COMMIT THAT ARTIFACT'S PROVENANCE IMMEDIATELY. A run that dies after the
 *      third file leaves three proven artifacts, and Repair finishes the rest.
 *      This is why provenance is not one transaction around the whole run.
 *
 * DRIFT IS NEVER OVERWRITTEN OUTSIDE A REPAIR. A managed block whose body no
 * longer hashes to the value in its own marker was edited by a human. An
 * ordinary scope update reports it and moves on; only `trigger: "repair"` -
 * an explicit user action on its own channel - replaces it.
 *
 * NOTHING IS DELETED. A deselected agent has its ENTRY removed from a file that
 * remains on disk with all of the user's other content in it.
 */

import {
  STUDIO_AGENTS_MD_PATH,
  claudeMdImportsAgents,
  inspectStudioManagedBlock,
  mergeClaudeMdImport,
  mergeStudioAgentConfig,
  mergeStudioManagedBlock,
  readStudioOwnedRegion,
  removeStudioAgentConfig,
  renderFreshClaudeMd,
  renderStudioAgentConfig,
  renderStudioManagedBlock,
  studioManagedBodyHash,
  type StudioProjectBrief,
  type StudioProjectFacts,
  type StudioRenderResult,
} from "@vex-agent/studio/installer/render/index.js";
import { renderStudioProtocolsDoc } from "@vex-agent/studio/instructions/protocols-doc.js";
import type {
  StudioArtifactOutcome,
  StudioInstallerWarning,
  StudioRefusalReason,
} from "@shared/schemas/studio-installer.js";
import { log } from "../../logger/index.js";
import {
  hashText,
  readConfinedFile,
  replaceConfinedFile,
  type ConfinedWrite,
} from "./confined-fs.js";
import { findAmbiguousTwin, resolveArtifactPath } from "./paths.js";
import type { StudioArtifactPlan, StudioPlan } from "./plan.js";
import { collectStudioWarnings, detectForeignAuthority } from "./warnings.js";

/** What a completed artifact leaves in the durable store. */
export interface ArtifactProvenanceWrite {
  readonly artifactKey: string;
  readonly relativePath: string;
  readonly entryHash: string | null;
  readonly contentHash: string;
}

/**
 * The filesystem and provenance seam.
 *
 * Injected so tests can drive the real renderers, the real confinement checks
 * and the real ordering while making the Nth write fail - which is the only way
 * to prove that per-file provenance actually survives a mid-run failure rather
 * than being assumed to.
 */
export interface ReconcileIo {
  readonly replaceFile: (options: {
    readonly projectDirectory: string;
    readonly absolutePath: string;
    readonly relativeLabel: string;
    readonly text: string;
    readonly expectedHash: string | null;
    readonly mode: number | null;
  }) => Promise<ConfinedWrite>;
  /** Persist one artifact's provenance. Called immediately after a write. */
  readonly commitProvenance: (record: ArtifactProvenanceWrite) => Promise<void>;
  /** Forget one artifact's provenance, after its entry was removed. */
  readonly clearProvenance: (artifactKey: string) => Promise<void>;
}

export interface ReconcileOptions {
  readonly projectDirectory: string;
  readonly plan: StudioPlan;
  readonly facts: StudioProjectFacts;
  readonly brief: StudioProjectBrief;
  /** Artifact key -> the digest of the Vex region Vex last wrote there. */
  readonly provenance: ReadonlyMap<string, { entryHash: string | null; contentHash: string }>;
  /** Repair is the only trigger that overwrites a drifted artifact. */
  readonly repair: boolean;
  readonly io: ReconcileIo;
}

export interface ReconcileResult {
  readonly artifacts: readonly StudioArtifactOutcome[];
  readonly warnings: readonly StudioInstallerWarning[];
  /** True only when no artifact ended in a refusal or a blocked drift. */
  readonly completed: boolean;
}

/** Run the plan. Sequential: two artifacts can share a file, and order matters. */
export async function reconcileStudioArtifacts(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const artifacts: StudioArtifactOutcome[] = [];
  // Filled while files are read: a foreign authority statement is only visible
  // in the bytes, so it cannot come from the plan alone.
  const discovered: StudioInstallerWarning[] = [];

  for (const item of options.plan.unsupported) {
    artifacts.push({
      status: "unsupported",
      kind: "agent-config",
      agentId: item.agentId,
      path: null,
      reason: item.reason,
      supportReturnsWhen: item.supportReturnsWhen,
    });
  }

  for (const artifact of options.plan.artifacts) {
    artifacts.push(await reconcileOne(artifact, options, discovered));
  }

  const completed = artifacts.every(
    (outcome) =>
      outcome.status === "written"
      || outcome.status === "unchanged"
      || outcome.status === "removed"
      || outcome.status === "unsupported",
  );

  return {
    artifacts,
    warnings: collectStudioWarnings(options.plan, artifacts, discovered),
    completed,
  };
}

async function reconcileOne(
  artifact: StudioArtifactPlan,
  options: ReconcileOptions,
  discovered: StudioInstallerWarning[],
): Promise<StudioArtifactOutcome> {
  const label = artifact.relativePath;

  const resolution = await resolveArtifactPath(options.projectDirectory, label);
  if (resolution.kind === "refused") {
    return refusal(artifact, resolution.reason, resolution.detail);
  }

  // The twin check applies only where a client documents reading both
  // spellings. `alsoReads` carries those paths; anything else in it is a
  // DIFFERENT file the client also reads, not an ambiguous twin.
  if (artifact.kind === "agent-config" && artifact.agent.configMode === "project") {
    const twin = await findAmbiguousTwin(
      options.projectDirectory,
      label,
      artifact.agent.alsoReads,
    );
    if (twin !== null) return refusal(artifact, twin.reason, twin.detail);
  }

  const existing = await readConfinedFile(resolution.absolutePath, label, resolution.mode);
  if (existing.kind === "refused") {
    return refusal(artifact, existing.reason, existing.detail);
  }
  const existingText = existing.kind === "file" ? existing.text : null;
  const existingHash = existing.kind === "file" ? existing.hash : null;

  if (existingText !== null && artifact.kind === "agent-config") {
    const foreign = detectForeignAuthority(existingText, artifact.agent);
    if (foreign !== null) discovered.push(foreign);
  }

  const decision = decideDesiredText(artifact, existingText, options);
  if (decision.kind === "refused") {
    return refusal(artifact, decision.reason, decision.detail);
  }
  if (decision.kind === "drift_blocked") {
    return {
      status: "drift_blocked",
      kind: artifact.kind,
      agentId: artifact.agentId,
      path: label,
      detail: decision.detail,
    };
  }
  if (decision.kind === "unchanged") {
    // Even a no-op refreshes provenance when the store has no record of an
    // artifact that is already correct. Without it, a project whose files were
    // restored from a backup would refuse its own entries as collisions.
    if (existingText !== null && !options.provenance.has(artifact.key)) {
      await options.io.commitProvenance({
        artifactKey: artifact.key,
        relativePath: label,
        entryHash: decision.entryHash,
        contentHash: hashText(existingText),
      });
    }
    return {
      status: "unchanged",
      kind: artifact.kind,
      agentId: artifact.agentId,
      path: label,
    };
  }

  const write = await options.io.replaceFile({
    projectDirectory: options.projectDirectory,
    absolutePath: resolution.absolutePath,
    relativeLabel: label,
    text: decision.text,
    expectedHash: existingHash,
    mode: existing.kind === "file" ? existing.mode : null,
  });
  if (write.kind === "refused") {
    return refusal(artifact, write.reason, write.detail);
  }

  if (artifact.operation === "remove") {
    await options.io.clearProvenance(artifact.key);
    return {
      status: "removed",
      kind: artifact.kind,
      agentId: artifact.agentId,
      path: label,
    };
  }

  await options.io.commitProvenance({
    artifactKey: artifact.key,
    relativePath: label,
    entryHash: decision.entryHash,
    contentHash: write.hash,
  });

  return {
    status: "written",
    kind: artifact.kind,
    agentId: artifact.agentId,
    path: label,
    change: existingText === null ? "created" : "updated",
  };
}

type Decision =
  | { readonly kind: "write"; readonly text: string; readonly entryHash: string | null }
  | { readonly kind: "unchanged"; readonly entryHash: string | null }
  | { readonly kind: "drift_blocked"; readonly detail: string }
  | {
    readonly kind: "refused";
    readonly reason: StudioRefusalReason;
    readonly detail: string;
  };

function decideDesiredText(
  artifact: StudioArtifactPlan,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  switch (artifact.kind) {
    case "agent-config":
      return decideAgentConfig(artifact, existing, options);
    case "agents-md":
      return decideAgentsMd(existing, options);
    case "claude-md":
      return decideClaudeMd(artifact, existing, options);
    case "protocols-doc":
      return decideProtocolsDoc(artifact, existing, options);
  }
}

function decideAgentConfig(
  artifact: Extract<StudioArtifactPlan, { kind: "agent-config" }>,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  const { agent } = artifact;
  const recorded = options.provenance.get(artifact.key);

  if (existing === null) {
    if (artifact.operation === "remove") return { kind: "unchanged", entryHash: null };
    return fromRender(
      renderStudioAgentConfig(agent, options.facts),
      entryHashFor(artifact, options),
    );
  }

  // OWNERSHIP. Anything at our path must be provably ours before we touch it.
  const region = readStudioOwnedRegion(existing, agent);
  if (region.kind === "unreadable") {
    // The pure renderer names the same condition precisely (malformed JSON, a
    // TOML multi-line string); ask it rather than guessing a reason here.
    return fromRender(
      artifact.operation === "remove"
        ? removeStudioAgentConfig(existing, agent, options.facts)
        : mergeStudioAgentConfig(existing, agent, options.facts),
      null,
    );
  }

  if (region.kind === "present") {
    if (recorded?.entryHash === undefined || recorded.entryHash === null) {
      return {
        kind: "refused",
        reason: "provenance_collision",
        detail:
          `"${artifact.relativePath}" already has a server entry named "vex" that Vex `
          + "did not write. Vex will not replace an entry it does not own; rename or "
          + "remove that entry and try again.",
      };
    }
    if (recorded.entryHash !== region.hash) {
      return artifact.operation === "remove"
        ? {
          kind: "refused",
          reason: "provenance_collision",
          detail:
            `The Vex entry in "${artifact.relativePath}" was changed after Vex wrote it, `
            + "so Vex left it alone instead of removing an edit that is not its own. "
            + "Remove the entry by hand if you no longer want it.",
        }
        : {
          kind: "refused",
          reason: "provenance_collision",
          detail:
            `The Vex entry in "${artifact.relativePath}" was changed after Vex wrote it. `
            + "Vex will not overwrite that edit; run Repair to replace it with the "
            + "generated entry.",
        };
    }
    if (region.unknownKeys.length > 0) {
      return {
        kind: "refused",
        reason: "unknown_keys_in_vex_entry",
        detail:
          `The Vex entry in "${artifact.relativePath}" has fields Vex never writes: `
          + `${region.unknownKeys.join(", ")}. Vex will not silently delete them. `
          + "Remove them, or run Repair to replace the entry with the generated one.",
      };
    }
  }

  return fromRender(
    artifact.operation === "remove"
      ? removeStudioAgentConfig(existing, agent, options.facts)
      : mergeStudioAgentConfig(existing, agent, options.facts),
    artifact.operation === "remove" ? null : entryHashFor(artifact, options),
  );
}

/**
 * The entry digest Vex will be able to prove ownership with NEXT time.
 *
 * Computed from the text the renderer is about to produce, through the same
 * normalizing reader that will read it back, so a formatter run between the two
 * cannot turn our own entry into a collision.
 */
function entryHashFor(
  artifact: Extract<StudioArtifactPlan, { kind: "agent-config" }>,
  options: ReconcileOptions,
): string | null {
  const fresh = renderStudioAgentConfig(artifact.agent, options.facts);
  if (fresh.status !== "rendered") return null;
  const region = readStudioOwnedRegion(fresh.text, artifact.agent);
  return region.kind === "present" ? region.hash : null;
}

function decideAgentsMd(existing: string | null, options: ReconcileOptions): Decision {
  const block = renderStudioManagedBlock(options.brief);
  const bodyHash = studioManagedBodyHash(managedBodyOf(block));

  if (existing === null) {
    return { kind: "write", text: block, entryHash: bodyHash };
  }

  const state = inspectStudioManagedBlock(existing, options.brief);
  if (state.kind === "malformed") {
    return { kind: "refused", reason: "malformed_managed_block", detail: state.detail };
  }
  if (state.kind === "drifted" && !options.repair) {
    return {
      kind: "drift_blocked",
      detail:
        `The Vex section in "${STUDIO_AGENTS_MD_PATH}" was edited after Vex wrote it, so `
        + "Vex left it exactly as it is. Run Repair to replace it with the generated "
        + "section; everything outside the markers is yours either way.",
    };
  }
  return fromRender(
    mergeStudioManagedBlock(existing, options.brief, { overwriteDrift: options.repair }),
    bodyHash,
  );
}

function decideClaudeMd(
  artifact: StudioArtifactPlan,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  if (existing === null) return fromRender(renderFreshClaudeMd(), null);

  if (claudeMdImportsAgents(existing)) return { kind: "unchanged", entryHash: null };

  // The import is gone. If Vex never wrote it, this is a first install. If Vex
  // DID write it, the user (or a tool) removed it, and re-adding it on every
  // scope edit would be Vex overruling a deliberate deletion - so it is drift,
  // and only Repair puts it back.
  if (options.provenance.has(artifact.key) && !options.repair) {
    return {
      kind: "drift_blocked",
      detail:
        `The "@${STUDIO_AGENTS_MD_PATH}" import Vex added to "${artifact.relativePath}" `
        + "is gone, so Claude Code no longer reads this project's Vex section. Run "
        + "Repair to put the line back.",
    };
  }
  return fromRender(mergeClaudeMdImport(existing), null);
}

function decideProtocolsDoc(
  artifact: StudioArtifactPlan,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  const desired = renderStudioProtocolsDoc();
  if (existing === null) return { kind: "write", text: desired, entryHash: null };
  if (existing === desired) return { kind: "unchanged", entryHash: null };

  // A GENERATED file Vex owns whole. An edit to it is still an edit: it says
  // "GENERATED FILE. Do not edit by hand." at the top, and someone who did
  // anyway gets told rather than overwritten.
  const recorded = options.provenance.get(artifact.key);
  if (
    recorded !== undefined
    && recorded.contentHash !== hashText(existing)
    && !options.repair
  ) {
    return {
      kind: "drift_blocked",
      detail:
        `"${artifact.relativePath}" was edited after Vex generated it. Run Repair to `
        + "regenerate it from the live tool inventory.",
    };
  }
  return { kind: "write", text: desired, entryHash: null };
}

/** The body between the markers of a freshly rendered block. */
function managedBodyOf(block: string): string {
  const firstNewline = block.indexOf("\n");
  const endMarker = block.lastIndexOf("<!-- vex:studio:end -->");
  // Structural slicing of known delimiters: it extracts the region, it does not
  // hide any of it.
  return block.slice(firstNewline + 1, Math.max(firstNewline + 1, endMarker - 1));
}

function fromRender(result: StudioRenderResult, entryHash: string | null): Decision {
  switch (result.status) {
    case "rendered":
      return { kind: "write", text: result.text, entryHash };
    case "unchanged":
      return { kind: "unchanged", entryHash };
    case "refused":
      return { kind: "refused", reason: result.reason, detail: result.detail };
  }
}

function refusal(
  artifact: StudioArtifactPlan,
  reason: StudioRefusalReason,
  detail: string,
): StudioArtifactOutcome {
  log.info(
    `[studio:installer] refused artifact=${artifact.key} reason=${reason}`,
  );
  return {
    status: "refused",
    kind: artifact.kind,
    agentId: artifact.agentId,
    path: artifact.relativePath,
    reason,
    detail,
  };
}
