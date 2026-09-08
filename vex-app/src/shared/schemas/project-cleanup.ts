import { z } from "zod";

/** Allowlisted causes only: native messages and absolute paths never cross IPC. */
export const projectTrashFailureSchema = z.enum([
  "busy", "nonlocal_volume", "aborted", "permission_denied", "invalid_path",
  "path_unresolved", "outside_root", "io_error",
]);
export type ProjectTrashFailure = z.infer<typeof projectTrashFailureSchema>;

export const PROJECT_TRASH_REMEDIATION: Readonly<Record<ProjectTrashFailure, string>> = {
  busy: "The folder is in use. Close terminals, agents and other programs using it, then retry cleanup.",
  nonlocal_volume: "The OS refused to trash a network or WSL folder. This location may not support the Recycle Bin. Move the folder yourself, or retry after closing programs using it.",
  aborted: "The OS aborted the trash operation. It may be unable to recycle this folder, or a program may still be using it. Close programs and retry; if it still fails, move the folder yourself.",
  permission_denied: "The OS denied permission to trash the folder. Check its permissions, then retry cleanup or move the folder yourself.",
  invalid_path: "The OS could not parse the folder path. Check the projects root in settings, then retry cleanup.",
  path_unresolved: "The folder could not be resolved. Check that the projects drive is connected and accessible, then retry cleanup.",
  outside_root: "The folder resolves outside the projects root. Check the folder and root in settings; Vex will not trash a different location.",
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
