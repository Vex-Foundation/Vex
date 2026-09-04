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
 * NOTHING IS DELETED ON AN INSTALL OR A SCOPE UPDATE. A deselected agent has its
 * ENTRY removed from a file that remains on disk with all of the user's other
 * content in it.
 *
 * THE ONE EXCEPTION IS THE B0 TEARDOWN, and it is narrow on purpose. A plan
 * whose artifacts are all `operation: "remove"` runs when a PROJECT IS DELETED,
 * and it may remove a whole FILE - but only where every byte of it was provably
 * Vex's own output: `.vex/protocols.md`, which is wholly generated, and an
 * `AGENTS.md` whose managed block was the entire file and whose content digest
 * still matches what provenance recorded. Anything else is written back with
 * Vex's region taken out and the file left in place. A teardown removes a
 * recorded artifact only where provenance says Vex WROTE those bytes (origin
 * `written`); bytes Vex merely ADOPTED because they already existed are the
 * user's and are kept. Drift, an unproven entry, unknown keys inside our entry,
 * and an adopted artifact are all KEPT and REPORTED, never deleted, and a
 * teardown deliberately runs with `repair: false` so no takeover can override
 * that.
 */

import {
  STUDIO_AGENTS_MD_PATH,
  STUDIO_CLAUDE_MD_IMPORTS,
  STUDIO_VEX_GUIDE_PATH,
  claudeMdMissingStudioImports,
  studioClaudeMdDeletedImports,
  inspectStudioManagedBlock,
  inspectStudioVexGuide,
  studioClaudeMdImportSetHash,
  studioManagedBlockOwnership,
  removeStudioManagedBlock,
  mergeClaudeMdImports,
  removeClaudeMdImports,
  mergeStudioAgentConfig,
  mergeStudioManagedBlock,
  mergeStudioVexGuide,
  readStudioOwnedRegion,
  removeStudioAgentConfig,
  renderFreshClaudeMd,
  renderStudioAgentConfig,
  renderStudioManagedBlock,
  renderStudioVexGuide,
  studioManagedBodyHash,
  type StudioManagedBlockState,
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
import type { ArtifactProvenanceOrigin } from "../../database/projects/installer-provenance.js";
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

/**
 * What a completed artifact leaves in the durable store.
 *
 * The `origin` union is imported TYPE-ONLY from the repository that owns the
 * column, so the two cannot drift into different vocabularies; the value seam
 * itself stays injected (`ReconcileIo`), so this module still has no runtime
 * dependency on the database.
 */
export interface ArtifactProvenanceWrite {
  readonly artifactKey: string;
  readonly relativePath: string;
  readonly entryHash: string | null;
  readonly contentHash: string;
  /**
   * `written` when Vex REPLACED these bytes; `adopted` when they were already
   * on disk and identical to a fresh render. Only `written` is authorship
   * proof - see the teardown gate in `decideDesiredText`.
   */
  readonly origin: ArtifactProvenanceOrigin;
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
  /**
   * Persist one artifact's provenance. Called immediately after a write.
   *
   * Returns whether the record actually landed. It used to return `void` and
   * the production adapter logged and swallowed the failure - so a run whose
   * database write failed still reported the artifact `written`, still reported
   * `completed`, and still advanced the completion marker. The project then
   * looked up to date while holding an entry Vex could no longer prove it
   * owned, and the NEXT run refused that entry as a collision. The user's first
   * news of the failure was a refusal on a file they had been told was fine.
   */
  readonly commitProvenance: (record: ArtifactProvenanceWrite) => Promise<boolean>;
  /** Forget one artifact's provenance, after its entry was removed. */
  readonly clearProvenance: (artifactKey: string) => Promise<boolean>;
  /**
   * Remove a file Vex owns whole (B0 teardown). Optional: only a teardown plan
   * can produce a `delete` decision, so the install paths never supply it, and
   * a plan that needs it without one is refused rather than silently skipped.
   */
  readonly deleteFile?: (options: {
    readonly projectDirectory: string;
    readonly absolutePath: string;
    readonly relativeLabel: string;
    readonly expectedHash: string | null;
  }) => Promise<ConfinedWrite>;
}

export interface ReconcileOptions {
  readonly projectDirectory: string;
  readonly plan: StudioPlan;
  readonly facts: StudioProjectFacts;
  /**
   * The managed-block brief.
   *
   * NULL is permitted for a TEARDOWN plan only - one whose artifacts are all
   * `remove` operations, which never render a fenced document.
   * `decideFencedDocument` is the one consumer, and it refuses loudly rather
   * than rendering from an empty brief,
   * so a plan that needs a brief and was handed `null` fails visibly instead of
   * writing a stripped file into a user's repository.
   */
  readonly brief: StudioProjectBrief | null;
  /**
   * Artifact key -> what the durable store records about that artifact: the
   * digest of the Vex-owned region, the digest of the whole file, and whether
   * Vex WROTE those bytes or merely ADOPTED bytes that were already there.
   */
  readonly provenance: ReadonlyMap<
    string,
    {
      entryHash: string | null;
      contentHash: string;
      origin: ArtifactProvenanceOrigin;
    }
  >;
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

/**
 * Did this artifact reach the state its plan asked for?
 *
 * The definition of `completed`, named so that a caller which has to reason
 * about the NON-reconciled outcomes (the teardown, which classifies them) reads
 * the same list rather than re-typing it and drifting from it.
 */
export function isReconciledArtifact(outcome: StudioArtifactOutcome): boolean {
  return (
    outcome.status === "written"
    || outcome.status === "unchanged"
    || outcome.status === "removed"
    || outcome.status === "unsupported"
  );
}

/**
 * The refusal reasons that mean "these bytes are not provably Vex's".
 *
 * MEMBERSHIP IS DECIDED HERE, EXPLICITLY, over the closed set in
 * `@shared/schemas/studio-installer.js`, because a caller that pattern-matched
 * on reason strings would silently reclassify the next member somebody adds.
 *
 *   - `provenance_collision`      something sits at the Vex path that Vex
 *                                 cannot show it wrote, or a proven Vex entry
 *                                 was edited after Vex wrote it. Either way the
 *                                 bytes are somebody else's.
 *   - `unknown_keys_in_vex_entry` a proven Vex entry grew fields Vex never
 *                                 writes. The entry is ours, the added fields
 *                                 are not, and Vex will not delete them. This IS
 *                                 reachable from a teardown: a teardown runs
 *                                 with `repair: false`, so the provenance-proven
 *                                 takeover does not fire and the unknown-key
 *                                 check is reached. A delete therefore keeps
 *                                 those fields, reports them, and discharges.
 *
 * EVERYTHING ELSE IS NOT AN OWNERSHIP ANSWER and is deliberately absent:
 * `malformed_json`, `malformed_toml`, `toml_multiline_string` and
 * `malformed_managed_block` say Vex cannot safely PARSE the file, not that the
 * region is not ours; `symlinked_path`, `not_a_regular_file`, `too_large`,
 * `invalid_utf8`, `ambiguous_twin`, `path_escape` and `io_error` are conditions
 * of the path or the filesystem; and `source_changed` is a race a retry
 * genuinely resolves - the next run re-reads the bytes and either proves
 * ownership or refuses on it.
 */
const OWNERSHIP_REFUSAL_REASONS: ReadonlySet<StudioRefusalReason> = new Set<
  StudioRefusalReason
>(["provenance_collision", "unknown_keys_in_vex_entry"]);

/**
 * Is this outcome Vex declining to touch bytes it cannot prove it owns?
 *
 * `drift_blocked` is always one: a managed block whose body no longer hashes to
 * the value in its own marker, a generated file that was edited, or a block that
 * is not the one provenance recorded. The refused outcomes are the reasons in
 * `OWNERSHIP_REFUSAL_REASONS`.
 *
 * The teardown is the consumer, and the distinction matters there because the
 * two classes owe different things: an ownership refusal is a FINAL, correct
 * answer that will be identical on every retry, while a transient failure is
 * work that still needs doing.
 */
export function isOwnershipRefusal(outcome: StudioArtifactOutcome): boolean {
  if (outcome.status === "drift_blocked") return true;
  return outcome.status === "refused" && OWNERSHIP_REFUSAL_REASONS.has(outcome.reason);
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

  const completed = artifacts.every(isReconciledArtifact);

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
    if (artifact.operation === "remove") {
      // A REMOVAL WHOSE WORK IS ALREADY DONE. The entry, the import line or the
      // file is not there, so the obligation this artifact carries is
      // SATISFIED - and the provenance row's only purpose was to prove
      // ownership of bytes that no longer exist. Leaving it behind kept a
      // deleted project's cleanup owing a record it could never discharge, and
      // made the next teardown plan an artifact with nothing to plan.
      //
      // Cleared unconditionally of whether the store has the key: `clear` is a
      // guarded DELETE, so the no-row case is a no-op rather than an error.
      const forgotten = await options.io.clearProvenance(artifact.key);
      if (!forgotten) return provenanceNotRecorded(artifact, label, false);
      return {
        status: "unchanged",
        kind: artifact.kind,
        agentId: artifact.agentId,
        path: label,
      };
    }
    // Even a no-op refreshes provenance when the store has no record of an
    // artifact that is already correct. Without it, a project whose files were
    // restored from a backup would refuse its own entries as collisions.
    //
    // `adopted`, ALWAYS, and that is the whole point of the column: these bytes
    // were on disk before this run touched anything, and nothing here can tell
    // a Vex write whose record was lost from a user who wrote exactly the same
    // thing. The record therefore says only what is provable - "these bytes are
    // not a collision" - and never "Vex authored them".
    if (existingText !== null && !options.provenance.has(artifact.key)) {
      const recorded = await options.io.commitProvenance({
        artifactKey: artifact.key,
        relativePath: label,
        entryHash: decision.entryHash,
        contentHash: hashText(existingText),
        origin: "adopted",
      });
      if (!recorded) return provenanceNotRecorded(artifact, label, false);
    }
    return {
      status: "unchanged",
      kind: artifact.kind,
      agentId: artifact.agentId,
      path: label,
    };
  }

  if (decision.kind === "delete") {
    const remove = options.io.deleteFile;
    if (remove === undefined) {
      return refusal(
        artifact,
        "io_error",
        `Vex was not able to remove "${label}" because this run has no delete `
          + "capability. Nothing was changed.",
      );
    }
    const removed = await remove({
      projectDirectory: options.projectDirectory,
      absolutePath: resolution.absolutePath,
      relativeLabel: label,
      expectedHash: decision.expectedHash,
    });
    if (removed.kind === "refused") {
      return refusal(artifact, removed.reason, removed.detail);
    }
    const forgotten = await options.io.clearProvenance(artifact.key);
    if (!forgotten) return provenanceNotRecorded(artifact, label, true);
    return {
      status: "removed",
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
    const cleared = await options.io.clearProvenance(artifact.key);
    if (!cleared) return provenanceNotRecorded(artifact, label, true);
    return {
      status: "removed",
      kind: artifact.kind,
      agentId: artifact.agentId,
      path: label,
    };
  }

  // `written`: this run rendered the text and replaced the bytes on disk, so
  // Vex can prove authorship of them. This is the ONLY place that records it.
  const recorded = await options.io.commitProvenance({
    artifactKey: artifact.key,
    relativePath: label,
    entryHash: decision.entryHash,
    contentHash: write.hash,
    origin: "written",
  });
  if (!recorded) return provenanceNotRecorded(artifact, label, true);

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
  /**
   * REMOVE THE FILE ITSELF (B0 teardown). Reachable only for an artifact Vex
   * owns whole - a generated doc, or a file left empty once Vex's own region
   * came out of it. `expectedHash` is the digest of the bytes ownership was
   * proved against, and the delete refuses if the file no longer matches it.
   */
  | { readonly kind: "delete"; readonly expectedHash: string }
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
  // THE ADOPTION GATE, and it is the FIRST thing a removal is asked.
  //
  // A teardown treats a provenance row as authorship proof and removes what it
  // names. But a row whose origin is `adopted` proves only that the bytes were
  // already identical to a fresh render when Vex first looked - which is
  // exactly what a user who wrote a `vex` MCP entry, or an `@AGENTS.md` import
  // line, BEFORE ever installing Vex leaves behind. Deleting their project then
  // deleted their own content. So a removal may only proceed against bytes Vex
  // recorded WRITING.
  //
  // It is gated here, once, rather than in each of the four deciders, because
  // it is one policy and four copies of it would be four places to forget it.
  // The answer is `provenance_collision`, which is the existing member of the
  // CLOSED refusal set whose meaning is precisely this - "something is at the
  // Vex path that Vex cannot show it wrote" - and which
  // `OWNERSHIP_REFUSAL_REASONS` already classifies as an ownership answer, so
  // the delete's cleanup DISCHARGES on it instead of retrying forever.
  if (artifact.operation === "remove" && existing !== null) {
    const record = options.provenance.get(artifact.key);
    if (record !== undefined && record.origin !== "written") {
      return {
        kind: "refused",
        reason: "provenance_collision",
        detail:
          `Vex left "${artifact.relativePath}" exactly as it is. What Vex recorded `
          + "there was already on disk, byte for byte, before Vex first wrote "
          + "anything, so Vex cannot show the content is its own and will not "
          + "delete it. Remove it by hand if you no longer want it.",
      };
    }
  }
  switch (artifact.kind) {
    case "agent-config":
      return decideAgentConfig(artifact, existing, options);
    case "agents-md":
      return artifact.operation === "remove"
        ? decideFencedTeardown(artifact, existing, options)
        : decideFencedDocument(AGENTS_MD_DOCUMENT, existing, options);
    case "vex-guide":
      return artifact.operation === "remove"
        ? decideFencedTeardown(artifact, existing, options)
        : decideFencedDocument(VEX_GUIDE_DOCUMENT, existing, options);
    case "claude-md":
      return artifact.operation === "remove"
        ? decideClaudeMdTeardown(artifact, existing, options)
        : decideClaudeMd(artifact, existing, options);
    case "protocols-doc":
      return artifact.operation === "remove"
        ? decideProtocolsDocTeardown(artifact, existing, options)
        : decideProtocolsDoc(artifact, existing, options);
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
    // FINALIZE WHAT THE DISK ALREADY PROVES.
    //
    // An entry whose content is byte-for-byte what a fresh render produces is
    // Vex's own output, whether or not the store remembers writing it. That is
    // exactly the state left behind when a file replacement succeeded and its
    // provenance commit did not - a crash, or a database that was briefly
    // unreachable - and without this branch the next run refused that entry as
    // a collision FOREVER, with no remedy but the user deleting it by hand.
    //
    // Adopting it is safe because it is a no-op on the bytes: the alternative
    // is rendering the identical text. If a third party wrote an identical
    // entry, we would have written the same thing anyway.
    //
    // The three states, kept distinct: matches DESIRED -> finalize (here);
    // matches what the store RECORDED but not desired -> a normal update, or
    // drift, handled below; any THIRD state -> refused as a collision.
    if (region.hash === entryHashFor(artifact, options) && artifact.operation !== "remove") {
      return { kind: "unchanged", entryHash: region.hash };
    }

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
    // REPAIR TAKEOVER. The refusals below tell the user "run Repair to replace
    // it with the generated entry", and until this branch existed that sentence
    // was false: `options.repair` was never consulted here, so Repair produced
    // the same refusal and the promised remedy did not exist. Repair is the
    // explicit user action on its own channel, which is exactly the semantic
    // "drift is overwritten only by explicit Repair" names.
    //
    // The takeover is PROVENANCE-PROVEN, and that is the whole boundary: it
    // applies only where `recorded.entryHash` is a real digest, i.e. where Vex
    // can show this entry is one it wrote. The `entryHash === null` case below
    // is an entry Vex NEVER wrote, and no trigger takes that over - Repair is
    // permission to replace our own edited entry, never permission to seize
    // somebody else's. That refusal keeps its manual-remediation copy.
    if (options.repair && recorded.entryHash !== null) {
      return fromRender(
        artifact.operation === "remove"
          ? removeStudioAgentConfig(existing, agent, options.facts)
          : mergeStudioAgentConfig(existing, agent, options.facts),
        artifact.operation === "remove" ? null : entryHashFor(artifact, options),
      );
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

/**
 * THE TWO FENCED DOCUMENTS, and the one policy that governs both.
 *
 * `AGENTS.md` carries the authority core; `.vex/vex-guide.md` carries the
 * sections Codex's 32 KiB `project_doc_max_bytes` budget will not let the block
 * hold (`@vex-agent/studio/installer/render/vex-guide.ts`). They are managed
 * identically - same markers, same digest, same drift rule, same repair-only
 * overwrite - so the deciders below take the document rather than being written
 * twice. Two copies of this policy would be two places to forget that a drifted
 * body is never silently replaced.
 */
interface FencedDocument {
  /** For the user-facing detail lines. */
  readonly relativePath: string;
  readonly render: (brief: StudioProjectBrief) => string;
  readonly merge: (
    existing: string,
    brief: StudioProjectBrief,
    options: { readonly overwriteDrift: boolean },
  ) => StudioRenderResult;
  readonly inspect: (
    existing: string,
    brief: StudioProjectBrief,
  ) => StudioManagedBlockState;
}

const AGENTS_MD_DOCUMENT: FencedDocument = {
  relativePath: STUDIO_AGENTS_MD_PATH,
  render: renderStudioManagedBlock,
  merge: mergeStudioManagedBlock,
  inspect: inspectStudioManagedBlock,
};

const VEX_GUIDE_DOCUMENT: FencedDocument = {
  relativePath: STUDIO_VEX_GUIDE_PATH,
  // The environment is omitted on every call here: in production the LIVE
  // provider keys are the truth, and only a test states them.
  render: (brief) => renderStudioVexGuide(brief),
  merge: (existing, brief, options) => mergeStudioVexGuide(existing, brief, options),
  inspect: (existing, brief) => inspectStudioVexGuide(existing, brief),
};

/**
 * TEARDOWN of a fenced managed document (B0).
 *
 * The block claims live authority - it tells the next coding agent that this
 * repository is connected to Vex and which wallets it may spend - so a deleted
 * project must not leave one behind. But everything OUTSIDE the markers is the
 * user's file, and a block the user edited is not ours to delete.
 *
 * Ownership is proved twice, and deliberately so: the block's body must still
 * hash to the value recorded in its own marker (that is `drifted` if it does
 * not), AND, when provenance holds an entry hash for it, that hash must agree.
 * The first check catches a hand edit; the second catches a block written by
 * something other than this project's own install.
 *
 * The file is REMOVED only when nothing of the user's is left in it: the text
 * after removal is blank, and the whole file still hashes to what provenance
 * recorded, so every byte in it was Vex's. Any other outcome writes the
 * remainder back and leaves the file in place.
 */
function decideFencedTeardown(
  artifact: StudioArtifactPlan,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  if (existing === null) return { kind: "unchanged", entryHash: null };

  const ownership = studioManagedBlockOwnership(existing);
  if (ownership.kind === "absent") return { kind: "unchanged", entryHash: null };
  if (ownership.kind === "malformed") {
    return {
      kind: "refused",
      reason: "malformed_managed_block",
      detail: ownership.detail,
    };
  }
  if (ownership.kind === "drifted") {
    return {
      kind: "drift_blocked",
      detail:
        `The Vex section in "${artifact.relativePath}" was edited after Vex wrote it, so `
        + "Vex left the file exactly as it is. Delete that section by hand if you no "
        + "longer want it; everything outside the markers is yours either way.",
    };
  }

  const recorded = options.provenance.get(artifact.key);
  if (recorded?.entryHash != null && recorded.entryHash !== ownership.bodyHash) {
    return {
      kind: "drift_blocked",
      detail:
        `The Vex section in "${artifact.relativePath}" is not the one Vex recorded `
        + "writing, so Vex left it alone. Remove it by hand if you no longer want it.",
    };
  }

  const removal = removeStudioManagedBlock(existing);
  if (removal.status === "refused") {
    return { kind: "refused", reason: removal.reason, detail: removal.detail };
  }
  if (removal.status === "unchanged") return { kind: "unchanged", entryHash: null };

  // NOTHING OF THE USER'S LEFT, and the whole file was provably ours.
  const wholeFileWasOurs = recorded?.contentHash === hashText(existing);
  if (removal.text.trim() === "" && wholeFileWasOurs) {
    return { kind: "delete", expectedHash: hashText(existing) };
  }
  return { kind: "write", text: removal.text, entryHash: null };
}

function decideFencedDocument(
  document: FencedDocument,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  const brief = options.brief;
  if (brief === null) {
    // Only a teardown plan may omit the brief, and a teardown never plans this
    // artifact. Reaching here means a caller built a plan whose brief it did
    // not supply; refusing is the only safe answer, because the alternative is
    // rendering the managed block from nothing.
    return {
      kind: "refused",
      reason: "malformed_managed_block",
      detail:
        "Vex did not have the project summary it needs to write this file, so it "
        + "left the file alone.",
    };
  }
  const block = document.render(brief);
  const bodyHash = studioManagedBodyHash(managedBodyOf(block));

  if (existing === null) {
    return { kind: "write", text: block, entryHash: bodyHash };
  }

  const state = document.inspect(existing, brief);
  if (state.kind === "malformed") {
    return { kind: "refused", reason: "malformed_managed_block", detail: state.detail };
  }
  if (state.kind === "drifted" && !options.repair) {
    return {
      kind: "drift_blocked",
      detail:
        `The Vex section in "${document.relativePath}" was edited after Vex wrote it, so `
        + "Vex left it exactly as it is. Run Repair to replace it with the generated "
        + "section; everything outside the markers is yours either way.",
    };
  }
  return fromRender(
    document.merge(existing, brief, { overwriteDrift: options.repair }),
    bodyHash,
  );
}

/**
 * TEARDOWN of the `CLAUDE.md` import lines (B0).
 *
 * Only Vex's own import lines are ever Vex's here: `@AGENTS.md` and
 * `@.vex/vex-guide.md`. Everything else in the file is the user's, so the
 * teardown removes those lines through the same
 * merge discipline the install used and leaves the rest of the file untouched -
 * INCLUDING an empty remainder. Unlike `AGENTS.md`, this file is not removed
 * even when nothing is left in it: the coordinator's teardown semantics say the
 * rest of the file stays, and a `CLAUDE.md` is a file a user is likely to
 * reach for again.
 */
function decideClaudeMdTeardown(
  artifact: StudioArtifactPlan,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  if (existing === null) return { kind: "unchanged", entryHash: null };
  if (
    claudeMdMissingStudioImports(existing).length === STUDIO_CLAUDE_MD_IMPORTS.length
  ) {
    // Not one of Vex's lines is in the file: there is nothing of ours to take
    // out, whatever the store remembers.
    return { kind: "unchanged", entryHash: null };
  }

  // Provenance is the ownership proof: the line is only removed where the store
  // says Vex put it there.
  //
  // A user who wrote the same import by hand DOES keep it, but not because of
  // this check - an install adopts their line and writes a provenance row for
  // it, so `has(...)` is true for them too and this branch never fires. What
  // keeps it is the ADOPTION GATE in `decideDesiredText`, which refuses the
  // removal because that row's origin is `adopted` rather than `written`. This
  // check remains as the answer for a key with NO row at all, which the
  // teardown planner does not currently produce and which must still not be
  // read as permission to delete.
  if (!options.provenance.has(artifact.key)) {
    return { kind: "unchanged", entryHash: null };
  }

  const removal = removeClaudeMdImports(existing);
  if (removal.status === "refused") {
    return { kind: "refused", reason: removal.reason, detail: removal.detail };
  }
  if (removal.status === "unchanged") return { kind: "unchanged", entryHash: null };
  return { kind: "write", text: removal.text, entryHash: null };
}

/**
 * `CLAUDE.md`: both of Vex's imports present, and only the ones Vex wrote
 * treated as deletable.
 *
 * THE THREE STATES A MISSING LINE CAN BE IN, and they have different answers:
 *
 *   1. Vex never wrote here at all -> first install, add both lines.
 *   2. Vex wrote THIS line and it is gone -> the user (or a tool) removed it,
 *      and re-adding it on every scope edit would be Vex overruling a
 *      deliberate deletion. That is drift, and only Repair puts it back.
 *   3. Vex wrote here, but never wrote THIS line -> the import set GREW (the
 *      guide arrived in 0.2.7). Nobody deleted anything, so the line is simply
 *      added, the way the first one was.
 *
 * State 3 is why the artifact records an entry hash at all: without it a
 * project installed before `.vex/vex-guide.md` existed would have its missing
 * guide import reported as a user deletion, and every such project would be
 * told to run Repair for a line that had never been there.
 * `studioClaudeMdImportSetHash` digests the set Vex wrote; a row with NO hash
 * predates the guide and means exactly `[@AGENTS.md]`.
 */
function decideClaudeMd(
  artifact: StudioArtifactPlan,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  const desiredHash = studioClaudeMdImportSetHash();
  if (existing === null) return fromRender(renderFreshClaudeMd(), desiredHash);

  const missing = claudeMdMissingStudioImports(existing);
  if (missing.length === 0) return { kind: "unchanged", entryHash: desiredHash };

  const recorded = options.provenance.get(artifact.key);
  const deleted = studioClaudeMdDeletedImports(
    existing,
    recorded === undefined ? undefined : recorded.entryHash,
  );

  if (deleted.length > 0 && !options.repair) {
    return {
      kind: "drift_blocked",
      detail:
        `The ${deleted.map((line) => `"${line}"`).join(" and ")} import Vex added to `
        + `"${artifact.relativePath}" is gone, so Claude Code no longer reads all of `
        + "this project's Vex instructions. Run Repair to put the line back.",
    };
  }
  return fromRender(mergeClaudeMdImports(existing), desiredHash);
}

/**
 * TEARDOWN of `.vex/protocols.md` (B0).
 *
 * Wholly generated and wholly Vex's, so the whole FILE goes - but only after
 * the same drift check every other artifact gets. The file says "GENERATED
 * FILE. Do not edit by hand." at the top, and someone who edited it anyway is
 * told rather than having their edit deleted.
 */
function decideProtocolsDocTeardown(
  artifact: StudioArtifactPlan,
  existing: string | null,
  options: ReconcileOptions,
): Decision {
  if (existing === null) return { kind: "unchanged", entryHash: null };

  const actualHash = hashText(existing);
  const recorded = options.provenance.get(artifact.key);

  // Ours if the store recorded these exact bytes, or if it is byte-for-byte
  // what the generator produces right now (the same finalize-what-the-disk-
  // proves reasoning the agent-config path uses for a lost provenance commit).
  const matchesRecorded = recorded?.contentHash === actualHash;
  const matchesGenerator = existing === renderStudioProtocolsDoc();
  if (!matchesRecorded && !matchesGenerator) {
    return {
      kind: "drift_blocked",
      detail:
        `"${artifact.relativePath}" was edited after Vex generated it, so Vex left it `
        + "in place. Delete it by hand if you no longer want it.",
    };
  }
  return { kind: "delete", expectedHash: actualHash };
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

/**
 * The durable record did not land. FAIL CLOSED, and say which side failed.
 *
 * `refused` is deliberate even when `fileTouched` is true and the bytes ARE on
 * disk. The alternative - reporting `written` - is what produced the original
 * defect: a green run, an advanced completion marker, and a collision refusal
 * on the next render. A refusal keeps `completed` false, so
 * `recordCompleteRender` never runs and the project stays visibly owing a
 * render until Repair reconciles it.
 *
 * `io_error` is the closest member of the CLOSED refusal set in
 * `@shared/schemas/studio-installer.js`, which this module may not extend. It
 * is honest as far as it goes - a durable write failed - but it cannot say
 * "the file changed and its record did not", so the DETAIL carries that. A
 * dedicated `provenance_not_recorded` reason belongs in that schema; see the
 * handoff note.
 */
function provenanceNotRecorded(
  artifact: StudioArtifactPlan,
  label: string,
  fileTouched: boolean,
): StudioArtifactOutcome {
  return refusal(
    artifact,
    "io_error",
    fileTouched
      ? `"${label}" was changed on disk, but Vex could not record that it owns that `
        + "change. Vex has stopped rather than report a result it cannot prove; run "
        + "Repair once the database is reachable and it will reconcile the file."
      : `Vex could not record its ownership of "${label}", so this run is not `
        + "complete. Run Repair once the database is reachable.",
  );
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
