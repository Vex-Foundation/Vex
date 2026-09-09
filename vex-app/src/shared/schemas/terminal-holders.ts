import { z } from "zod";

export const terminalFolderRequestSchema = z.object({
  kind: z.literal("folderHolders"),
  directory: z.string().min(1),
  close: z.boolean(),
}).strict();
export const terminalFolderHoldersSchema = z.array(z.object({
  kind: z.literal("vex_terminal"), pid: z.number().int().positive(),
  project: z.string(), projectId: z.string().uuid(),
}).strict()).max(24);
export type TerminalFolderHolder = z.infer<typeof terminalFolderHoldersSchema>[number];
