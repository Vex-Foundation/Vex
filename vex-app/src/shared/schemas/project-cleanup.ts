import { z } from "zod";

/** Allowlisted causes. Paths are diagnostic display values and never accepted as action input. */
export const projectTrashReasonSchema = z.enum([
  "busy", "nonlocal_volume", "aborted", "permission_denied", "invalid_path",
  "path_unresolved", "outside_root", "io_error", "restore_failed",
]);
export type ProjectTrashReason = z.infer<typeof projectTrashReasonSchema>;
export const projectTrashHolderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("external") }).strict(),
  z.object({ kind: z.enum(["vex_terminal", "vex_orphaned_terminal"]),
    pid: z.number().int().positive(), project: z.string().optional(),
    projectId: z.string().uuid().optional(),
  }).strict(),
]);
export type ProjectTrashHolder = z.infer<typeof projectTrashHolderSchema>;
export const projectTrashFailureSchema = z.union([projectTrashReasonSchema, z.object({
  reason: projectTrashReasonSchema,
  folder: z.string().min(1),
  holders: z.array(projectTrashHolderSchema).optional(),
  recoveryPath: z.string().min(1).optional(),
}).strict()]);
export function trashReason(failure: ProjectTrashFailure): ProjectTrashReason {
  return typeof failure === "string" ? failure : failure.reason;
}
export function trashRemediation(failure: ProjectTrashFailure): string {
  if (typeof failure !== "string") {
    if (failure.reason === "busy" && !failure.holders?.length) return "The folder is in use. Its holder could not be identified. Close programs using it and retry cleanup.";
    if (failure.reason === "restore_failed") return `The folder was renamed but could not be restored. Recover it from ${failure.recoveryPath} to ${failure.folder} before retrying.`;
    if (failure.holders?.some((holder) => holder.kind === "vex_orphaned_terminal")) return "A Vex terminal from a previous session still uses this folder. Close it and retry.";
    if (failure.holders?.some((holder) => holder.kind === "vex_terminal")) return "A Vex terminal still uses this folder. Close it and retry.";
  }
  return PROJECT_TRASH_REMEDIATION[trashReason(failure)];
}
export type ProjectTrashFailure = z.infer<typeof projectTrashFailureSchema>;

const PROJECT_TRASH_REMEDIATION: Readonly<Record<ProjectTrashReason, string>> = {
  busy: "Another program is using this folder. Close it, then retry cleanup.",
  nonlocal_volume: "The OS refused to trash a network or WSL folder. This location may not support the Recycle Bin. Move the folder yourself, or retry after closing programs using it.",
  aborted: "The OS could not recycle this folder. Move the folder yourself, or retry cleanup.",
  permission_denied: "The OS denied permission to trash the folder. Check its permissions, then retry cleanup or move the folder yourself.",
  invalid_path: "The OS could not parse the folder path. Check the projects root in settings, then retry cleanup.",
  path_unresolved: "The folder could not be resolved. Check that the projects drive is connected and accessible, then retry cleanup.",
  outside_root: "The folder resolves outside the projects root. Check the folder and root in settings; Vex will not trash a different location.",
  restore_failed: "The folder was renamed but could not be restored. Recover the folder from the reported temporary path before retrying.",
  io_error: "The OS could not move the folder to the trash and supplied no recognized cause. Close programs using it and retry, or move the folder yourself.",
};

export const projectPendingCleanupsInputSchema = z.object({
  offset: z.number().int().nonnegative().max(1_000_000).default(0),
}).strict();
export type ProjectPendingCleanupsInput = z.input<typeof projectPendingCleanupsInputSchema>;

export const projectPendingCleanupSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(200),
  folder: z.string().min(1).max(200),
  trashRequested: z.boolean(),
  attempts: z.number().int().nonnegative(),
  trashFailure: projectTrashFailureSchema.nullable(),
}).strict();
export type ProjectPendingCleanup = z.infer<typeof projectPendingCleanupSchema>;
export const projectPendingCleanupsSchema = z.object({
  items: z.array(projectPendingCleanupSchema).max(50),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
export type ProjectPendingCleanups = z.infer<typeof projectPendingCleanupsSchema>;

/** Legacy reason-only rows remain readable; stored native messages remain private. */
export function parseStoredTrashFailure(stored: string | null): ProjectTrashFailure | null {
  if (stored === null || !stored.startsWith("trash:")) return null;
  const payload = stored.replace(/^trash:/, "");
  let value: unknown = payload;
  if (payload.startsWith("{")) {
    try { value = JSON.parse(payload); } catch { return null; }
  }
  const parsed = projectTrashFailureSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
