/**
 * Vex Studio project contracts (stage P).
 *
 * A project is a folder under the projects root plus ONE backing `sessions`
 * row (`mode = 'agent'`, `scope = 'vex_studio'`). This module is the single
 * shared vocabulary for that entity across renderer, preload, and main.
 *
 * Boundary rules encoded here:
 *
 *   - Every schema is `.strict()`. An unknown key is a rejected request, not a
 *     silently dropped field.
 *   - The renderer NEVER sends or receives a filesystem capability. `rootPath`
 *     is the project's path RELATIVE to the projects root (it equals the slug),
 *     and `displayPath` is display-only text for a settings screen. Neither is
 *     accepted as input, and neither can be used to reach the filesystem: main
 *     resolves the real root itself on every operation.
 *   - Wallet selection travels as inventory IDs only. Main resolves an id to
 *     its on-chain address; a renderer-supplied address is never trusted.
 *
 * `project_wallets` is authoritative for the wallet selection; the backing
 * session's wallet columns are a mirror written in the same transaction. See
 * migration `085_projects.sql`.
 */

import { z } from "zod";
import { STUDIO_AGENT_IDS } from "./studio-agent-ids.js";
import { sessionPermissionSchema } from "./sessions.js";
import {
  studioFilesStatusSchema,
  studioRenderOutcomeSchema,
} from "./studio-installer.js";

/** Backing-session scope marker. Agent-mode reads filter `vex_app`, so a
 *  project's backing session never appears in the session sidebar. */
export const VEX_STUDIO_SESSION_SCOPE = "vex_studio" as const;

export const PROJECT_NAME_MAX_LENGTH = 80;
export const PROJECT_SLUG_MAX_LENGTH = 64;

/**
 * Closed roster of coding agents a project may enable. Closed on purpose: the
 * ids are used to select instruction files and installer behaviour later in the
 * Studio arcs, so an unknown id must be a rejected input rather than a value
 * that silently does nothing.
 *
 * The list itself is not authored here either: it is re-exported from
 * `./studio-agent-ids.ts`, which explains why the shared layer holds a PINNED
 * COPY of the engine's canonical roster instead of importing `@vex-lib/*` (the
 * process-boundary check forbids a shared module from reaching into a runtime
 * package, and weakening that check is not an option). The two parity tests -
 * `src/__tests__/lib/studio-agent-ids.test.ts` on the engine side and
 * `./__tests__/projects.test.ts` here - pin the same ordered literal, so a
 * roster edit that reaches only one package fails.
 */
export { STUDIO_AGENT_IDS };

export const studioAgentIdSchema = z.enum(STUDIO_AGENT_IDS);
export type StudioAgentId = z.infer<typeof studioAgentIdSchema>;

/**
 * Agent roster for one project: a SET of agent ids, expressed as an array.
 *
 * Bounded by the closed id list itself, and the uniqueness refinement is what
 * makes that bound real: without it `["codex", "codex", ...]` would pass the
 * length cap while denoting a roster that cannot exist. A duplicate is rejected
 * by name rather than silently de-duplicated, because a caller that sent one is
 * working from a wrong model of the roster and should be told so.
 */
export const studioAgentsSchema = z
  .array(studioAgentIdSchema)
  .max(STUDIO_AGENT_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Each coding agent may appear at most once in a project roster.",
  });

/** User-entered project name. Trimmed and bounded like a session title. */
export const projectNameSchema = z
  .string()
  .trim()
  .min(1, "Project name is required.")
  .max(
    PROJECT_NAME_MAX_LENGTH,
    `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or less.`,
  );

/**
 * Filesystem-safe project slug, mirrored by the DB CHECK in migration 085.
 * The pattern is the confinement guarantee: no separator, no dot, no leading
 * hyphen, so a slug can never traverse out of the projects root or name a
 * relative path segment.
 */
export const projectSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    "Slug must be lower-case letters, digits and hyphens, starting with a letter or digit.",
  );

/** Wallet ids as they exist in the inventory (`evm_<uuid>` / `sol_<uuid>`). */
export const projectWalletIdSchema = z.string().min(1).max(128);

/** Resolved wallet selection for one family. `null` means "no selection". */
export const projectWalletRefSchema = z
  .object({
    id: projectWalletIdSchema,
    address: z.string().min(1).max(128),
  })
  .strict();
export type ProjectWalletRef = z.infer<typeof projectWalletRefSchema>;

export const projectWalletsSchema = z
  .object({
    evm: projectWalletRefSchema.nullable(),
    solana: projectWalletRefSchema.nullable(),
  })
  .strict();
export type ProjectWallets = z.infer<typeof projectWalletsSchema>;

/** Wallet selection as the renderer sends it: inventory ids, or null. */
export const projectWalletSelectionSchema = z
  .object({
    evm: projectWalletIdSchema.nullable(),
    solana: projectWalletIdSchema.nullable(),
  })
  .strict();
export type ProjectWalletSelection = z.infer<
  typeof projectWalletSelectionSchema
>;

/**
 * The project as every consumer sees it.
 *
 * `wallets` is projected from `project_wallets` (authoritative), verified
 * against the wallet inventory on read: a stored selection whose address no
 * longer matches its id fails the read with `projects.wallet_drift` rather than
 * reaching a consumer.
 */
export const projectDtoSchema = z
  .object({
    id: z.string().uuid(),
    name: projectNameSchema,
    slug: projectSlugSchema,
    /** Path relative to the projects root. Equals the slug and is immutable. */
    rootPath: projectSlugSchema,
    /**
     * Display-only rendering of where the project lives, e.g.
     * `~/Vex/projects/my-app`. It is TEXT FOR A LABEL, never a capability: no
     * handler accepts it back, and main resolves the real root itself.
     */
    displayPath: z.string().min(1).max(4096),
    permission: sessionPermissionSchema,
    agents: studioAgentsSchema,
    wallets: projectWalletsSchema,
    /** Monotonic optimistic-concurrency token for scope edits. Starts at 1. */
    scopeVersion: z.number().int().min(1),
    backingSessionId: z.string().uuid(),
    /**
     * Per-artifact state of the files Vex maintains in the project directory
     * (stage A5b). Read from disk on every project read: drift is a filesystem
     * fact, and a cached "clean" answer would be exactly the silent overwrite
     * the drift contract exists to prevent.
     */
    files: studioFilesStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProjectDto = z.infer<typeof projectDtoSchema>;

export const projectListSchema = z.array(projectDtoSchema);
export type ProjectList = z.infer<typeof projectListSchema>;

/**
 * `vex.projects.create`. The slug is DERIVED IN MAIN from the name - the
 * renderer cannot supply one, so it cannot choose the directory that gets
 * claimed under the projects root.
 */
export const projectCreateInputSchema = z
  .object({
    name: projectNameSchema,
    permission: sessionPermissionSchema,
    agents: studioAgentsSchema.default([]),
    wallets: projectWalletSelectionSchema.default({ evm: null, solana: null }),
  })
  .strict();
export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;

export const projectGetInputSchema = z
  .object({
    projectId: z.string().uuid(),
  })
  .strict();
export type ProjectGetInput = z.infer<typeof projectGetInputSchema>;

export const projectListInputSchema = z.object({}).strict();
export type ProjectListInput = z.infer<typeof projectListInputSchema>;

/**
 * `vex.projects.updateScope`. Optimistic concurrency is mandatory:
 * `expectedScopeVersion` must equal the row's current `scope_version` or the
 * update is refused with `projects.scope_conflict` and writes nothing.
 *
 * Every editable field is optional; an omitted field is left untouched. At
 * least one must be present, otherwise the call is a no-op that would still
 * burn a scope version.
 */
export const projectUpdateScopeInputSchema = z
  .object({
    projectId: z.string().uuid(),
    expectedScopeVersion: z.number().int().min(1),
    permission: sessionPermissionSchema.optional(),
    wallets: projectWalletSelectionSchema.optional(),
    agents: studioAgentsSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.permission !== undefined ||
      input.wallets !== undefined ||
      input.agents !== undefined,
    {
      message:
        "Provide at least one of permission, wallets or agents to update.",
    },
  );
export type ProjectUpdateScopeInput = z.infer<
  typeof projectUpdateScopeInputSchema
>;

/** `create` returns the full, freshly persisted project. */
export const projectCreateResultSchema = projectDtoSchema;
export type ProjectCreateResult = z.infer<typeof projectCreateResultSchema>;

/**
 * `updateScope` returns the persisted project AND what the file reconciliation
 * that the edit triggered actually did (stage A5b).
 *
 * ONE RESULT, TWO FACTS, on purpose. A scope edit rewrites the files in the
 * user's repository, and those writes can refuse: a foreign entry at the Vex
 * path, a drifted managed block, a malformed config. Returning only the row
 * would show a green "saved" while a config the user is relying on was left
 * untouched. `render` is never optional and never empty - a run that rendered
 * nothing says so with `trigger: "superseded"`.
 */
export const projectUpdateScopeResultSchema = z
  .object({
    project: projectDtoSchema,
    render: studioRenderOutcomeSchema,
  })
  .strict();
export type ProjectUpdateScopeResult = z.infer<
  typeof projectUpdateScopeResultSchema
>;

/**
 * `repairFiles` returns the same pair: the project as it now reads, and what
 * the reconciliation did. Repair is the ONLY path that overwrites a drifted
 * managed block, which is why it is an explicit user action with its own
 * channel rather than a retry of `updateScope`.
 */
export const projectRepairFilesResultSchema = projectUpdateScopeResultSchema;
export type ProjectRepairFilesResult = z.infer<
  typeof projectRepairFilesResultSchema
>;

export {
  projectRepairFilesInputSchema,
  studioArtifactKindSchema,
  studioArtifactOutcomeSchema,
  studioArtifactStatusSchema,
  studioFilesStatusSchema,
  studioInstallerWarningSchema,
  studioRefusalReasonSchema,
  studioRenderOutcomeSchema,
} from "./studio-installer.js";
export type {
  ProjectRepairFilesInput,
  StudioArtifactKind,
  StudioArtifactOutcome,
  StudioArtifactStatus,
  StudioFilesStatus,
  StudioInstallerWarning,
  StudioRefusalReason,
  StudioRenderOutcome,
} from "./studio-installer.js";

/** `get` returns null for an unknown id (the caller held a stale view). */
export const projectGetResultSchema = projectDtoSchema.nullable();
export type ProjectGetResult = z.infer<typeof projectGetResultSchema>;
