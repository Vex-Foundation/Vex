import type { Result } from "../../../ipc/result.js";
import type {
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectGetInput,
  ProjectGetResult,
  ProjectList,
  ProjectRepairFilesInput,
  ProjectRepairFilesResult,
  ProjectUpdateScopeInput,
  ProjectUpdateScopeResult,
} from "../../../schemas/projects.js";

/**
 * Vex Studio projects (stage P). A project is a folder under the projects root
 * plus one backing `sessions` row.
 *
 * The renderer holds NO filesystem authority through this surface: it sends a
 * project name and main derives the folder name and resolves the root itself.
 * The DTO's `rootPath` is root-relative and `displayPath` is label text; neither
 * is accepted back as input by any method here.
 */
export interface ProjectsBridge {
  /**
   * Create a project. Not idempotent and never auto-retried: each successful
   * call claims a new directory and writes a new backing session. A name whose
   * folder is already taken is refused by name (`projects.slug_taken`) with
   * nothing created.
   */
  readonly create: (
    input: ProjectCreateInput
  ) => Promise<Result<ProjectCreateResult>>;
  /** Read one project. `null` when the id is unknown (stale renderer cache). */
  readonly get: (input: ProjectGetInput) => Promise<Result<ProjectGetResult>>;
  /** Every project, newest first. */
  readonly list: () => Promise<Result<ProjectList>>;
  /**
   * Edit permission, wallet selection and agent roster under optimistic
   * concurrency. `expectedScopeVersion` must match the project's current
   * `scopeVersion`; a mismatch returns `projects.scope_conflict` and writes
   * nothing, so the caller re-reads and re-applies rather than retrying blind.
   */
  readonly updateScope: (
    input: ProjectUpdateScopeInput
  ) => Promise<Result<ProjectUpdateScopeResult>>;
  /**
   * Reconcile every file Vex maintains in the project folder, drift included.
   *
   * The ONLY path that overwrites an artifact a human edited after Vex wrote
   * it, which is why it is an explicit user action rather than a retry of
   * `updateScope`. It changes no authority and takes no expected version.
   * A5 never deletes files: the strongest thing this does is replace Vex's own
   * region inside a file that stays.
   */
  readonly repairFiles: (
    input: ProjectRepairFilesInput
  ) => Promise<Result<ProjectRepairFilesResult>>;
}
