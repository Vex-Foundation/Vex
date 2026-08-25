/**
 * The Vex Studio installer's PUBLIC contract (stage A5b).
 *
 * The installer writes real files into a user's repository. Every one of those
 * writes can succeed, do nothing, or refuse - and a refusal is a fact the user
 * must see, never a silent skip. This module is the single shared vocabulary
 * for that per-artifact outcome across main, preload and renderer.
 *
 * THREE PROPERTIES THIS SHAPE ENCODES.
 *
 *   1. PER ARTIFACT, ALWAYS. There is no aggregate "install succeeded". Each
 *      artifact reports its own outcome, so "we wrote Codex's config, refused
 *      Grok's because someone else owns the entry, and Cline has no file at
 *      all" is representable and is exactly what the user is shown.
 *   2. UNSUPPORTED IS AN OUTCOME, NOT SILENCE. A selected agent Vex cannot
 *      integrate produces an explicit `unsupported` result carrying the reason
 *      and the condition under which support returns. A stored selection is the
 *      user's durable intent and never disappears from the report.
 *   3. NO PATH IS A CAPABILITY. `path` is repo-relative POSIX text for a label
 *      (`.codex/config.toml`). No handler accepts it back; main derives every
 *      real path from the project id and the registry.
 *
 * `completed` on the run is the flag the durable fingerprint depends on: the
 * last-rendered scope version is advanced only after a run that reconciled
 * EVERY artifact of the current scope. A partial run leaves the marker where it
 * was, so the next Repair knows there is work left.
 */

import { z } from "zod";
import { STUDIO_AGENT_IDS } from "./studio-agent-ids.js";

/**
 * Built from the roster module rather than imported from `./projects.js`: the
 * project DTO carries a `files` status built from THIS module, so importing the
 * other way would close a cycle between two schema files. Both enums read the
 * same roster constant, so they cannot disagree.
 */
const studioAgentIdSchema = z.enum(STUDIO_AGENT_IDS);

/** Which artifact an outcome is about. */
export const studioArtifactKindSchema = z.enum([
  /** One coding agent's MCP config file. */
  "agent-config",
  /** The `AGENTS.md` managed block. */
  "agents-md",
  /** The `@AGENTS.md` import inside `CLAUDE.md`. */
  "claude-md",
  /** The generated `.vex/protocols.md` tool reference. */
  "protocols-doc",
]);
export type StudioArtifactKind = z.infer<typeof studioArtifactKindSchema>;

/**
 * Why the installer would not touch a file.
 *
 * CLOSED SET, and each member names a DIFFERENT situation with a different
 * remedy. Collapsing them would be exactly the "unexpected error" this
 * repository forbids: "someone else owns this entry" and "this file is 40 MB"
 * are not the same problem and do not have the same fix.
 */
export const studioRefusalReasonSchema = z.enum([
  // ── from the pure renderers ────────────────────────────────────────────
  "malformed_json",
  "malformed_toml",
  /** A section-level TOML rewrite cannot safely edit a file with `"""` strings. */
  "toml_multiline_string",
  /** `AGENTS.md` has a begin marker with no end, or the reverse. */
  "malformed_managed_block",
  // ── from the confined filesystem contract ──────────────────────────────
  /** An entry already sits at the Vex path and provenance does not prove it is ours. */
  "provenance_collision",
  /** A provenance-proven Vex entry grew keys Vex never writes. */
  "unknown_keys_in_vex_entry",
  /** The target, or a directory on the way to it, is a symbolic link. */
  "symlinked_path",
  /** The target exists but is not a regular file. */
  "not_a_regular_file",
  /** The existing file is larger than the installer's size bound. */
  "too_large",
  /** The existing bytes are not valid UTF-8. */
  "invalid_utf8",
  /** Both `x.json` and `x.jsonc` exist and Vex cannot tell which the client reads. */
  "ambiguous_twin",
  /** The file changed on disk between the read and the replacement. */
  "source_changed",
  /** The resolved path left the project directory. */
  "path_escape",
  /** The write itself failed (permissions, disk, a vanished directory). */
  "io_error",
]);
export type StudioRefusalReason = z.infer<typeof studioRefusalReasonSchema>;

/** Repo-relative POSIX path text. Display only. */
const artifactPathSchema = z.string().min(1).max(512);

/** What happened to ONE artifact in one reconciliation run. */
export const studioArtifactOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("written"),
      kind: studioArtifactKindSchema,
      agentId: studioAgentIdSchema.nullable(),
      path: artifactPathSchema,
      /** `created` when the file did not exist, `updated` when it did. */
      change: z.enum(["created", "updated"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("unchanged"),
      kind: studioArtifactKindSchema,
      agentId: studioAgentIdSchema.nullable(),
      path: artifactPathSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("removed"),
      kind: studioArtifactKindSchema,
      agentId: studioAgentIdSchema.nullable(),
      path: artifactPathSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      kind: studioArtifactKindSchema,
      agentId: studioAgentIdSchema.nullable(),
      path: artifactPathSchema,
      reason: studioRefusalReasonSchema,
      /** Sanitized, user-facing explanation. Never a raw path or provider payload. */
      detail: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      status: z.literal("drift_blocked"),
      kind: studioArtifactKindSchema,
      agentId: studioAgentIdSchema.nullable(),
      path: artifactPathSchema,
      /** What was edited, in words the user can act on. */
      detail: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      status: z.literal("unsupported"),
      kind: z.literal("agent-config"),
      agentId: studioAgentIdSchema,
      /** No file exists for an unsupported agent, so there is no path to show. */
      path: z.null(),
      reason: z.string().min(1).max(1024),
      supportReturnsWhen: z.string().min(1).max(512),
    })
    .strict(),
]);
export type StudioArtifactOutcome = z.infer<typeof studioArtifactOutcomeSchema>;

/**
 * Something true about a written artifact that the write itself cannot fix.
 *
 * A correct config that a client will not load until the user trusts the
 * folder, a launch flag the user must type, a timeout only a user-global file
 * can raise, or a foreign authority statement sitting beside our entry. All of
 * them make "the file was written" an incomplete answer, so they travel with
 * the outcome instead of being discovered by the user when nothing works.
 */
export const studioInstallerWarningSchema = z
  .object({
    kind: z.enum([
      /** The client ignores the config until an out-of-band gate is passed. */
      "inert_until",
      /** The user must launch the client with a flag pointing at the file. */
      "launch_required",
      /** The only timeout mechanism is a user-global file a project cannot reach. */
      "user_global_timeout",
      /** A foreign authority section (`[permission]`, allow rules) sits in the file. */
      "foreign_authority_section",
      /** No documented tool-call timeout: the wait may be cut short. */
      "timeout_unverified",
    ]),
    agentId: studioAgentIdSchema.nullable(),
    detail: z.string().min(1).max(1024),
  })
  .strict();
export type StudioInstallerWarning = z.infer<typeof studioInstallerWarningSchema>;

/** The result of ONE reconciliation run over a project. */
export const studioRenderOutcomeSchema = z
  .object({
    /** The scope version the run actually reconciled (reloaded at execution). */
    scopeVersion: z.number().int().min(1),
    /**
     * True only when EVERY artifact of that scope was reconciled without a
     * hard failure. The durable last-rendered marker advances on this flag
     * alone, so an interrupted run cannot claim the project is up to date.
     */
    completed: z.boolean(),
    /**
     * Why the run was started. `superseded` means a newer scope version was
     * already queued when this job reached the front, so nothing was rendered
     * and the newer job owns the result.
     */
    trigger: z.enum(["scope_update", "repair", "superseded"]),
    artifacts: z.array(studioArtifactOutcomeSchema).max(64),
    warnings: z.array(studioInstallerWarningSchema).max(64),
  })
  .strict();
export type StudioRenderOutcome = z.infer<typeof studioRenderOutcomeSchema>;

/** One artifact's CURRENT state on disk, as reported on the project DTO. */
export const studioArtifactStatusSchema = z
  .object({
    kind: studioArtifactKindSchema,
    agentId: studioAgentIdSchema.nullable(),
    path: artifactPathSchema.nullable(),
    /**
     * `current` - present and byte-identical to what Vex would write now.
     * `drifted` - present but edited since Vex wrote it (a Repair overwrites it).
     * `missing` - the project selects it and it is not on disk.
     * `stale` - present, unedited, but not what the current scope wants.
     * `unsupported` - the agent has no artifact at all, by design.
     * `unreadable` - the file could not be inspected; the detail says why.
     */
    state: z.enum(["current", "drifted", "missing", "stale", "unsupported", "unreadable"]),
    detail: z.string().min(1).max(1024).nullable(),
  })
  .strict();
export type StudioArtifactStatus = z.infer<typeof studioArtifactStatusSchema>;

/** Every artifact's state, plus what the durable record says was last rendered. */
export const studioFilesStatusSchema = z
  .object({
    /**
     * The scope version the last COMPLETE reconciliation covered, or null when
     * the project's files have never been fully rendered.
     */
    lastRenderedScopeVersion: z.number().int().min(1).nullable(),
    /**
     * The generator fingerprint of that run (Vex version plus the renderer
     * revision). A different fingerprint means the files predate this build and
     * a regeneration is owed even if the scope never changed.
     */
    generatorFingerprint: z.string().min(1).max(128).nullable(),
    artifacts: z.array(studioArtifactStatusSchema).max(64),
  })
  .strict();
export type StudioFilesStatus = z.infer<typeof studioFilesStatusSchema>;

/** `vex.projects.repairFiles` input. */
export const projectRepairFilesInputSchema = z
  .object({
    projectId: z.string().uuid(),
  })
  .strict();
export type ProjectRepairFilesInput = z.infer<typeof projectRepairFilesInputSchema>;
