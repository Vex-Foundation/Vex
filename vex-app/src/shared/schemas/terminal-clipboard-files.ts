import { z } from "zod";
import { TERMINAL_FILE_PATH_MAX_LENGTH } from "./terminal-input.js";

export const readClipboardFilesInputSchema = z.object({}).strict();
export const clipboardFilePathsSchema = z.array(z.string().min(1).max(TERMINAL_FILE_PATH_MAX_LENGTH)).min(1).max(32);
export const readClipboardFilesValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("files"), paths: clipboardFilePathsSchema }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("refused"), reason: z.enum([
    "terminal_clipboard_files_unavailable", "terminal_clipboard_files_busy",
  ]) }).strict(),
]);
export type ReadClipboardFilesValue = z.infer<typeof readClipboardFilesValueSchema>;

/** Internal decoder messages are bound to both request ID and decoder webContents. */
export const clipboardFileReplyInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), requestId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("files"), requestId: z.string().uuid(), paths: clipboardFilePathsSchema }).strict(),
  z.object({ kind: z.literal("unavailable"), requestId: z.string().uuid() }).strict(),
]);
export const clipboardFileReplyValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted") }).strict(),
  z.object({ kind: z.literal("refused"), reason: z.enum([
    "terminal_clipboard_request_unknown", "terminal_clipboard_other_window", "terminal_clipboard_already_dispatched", "terminal_clipboard_not_dispatched",
  ]) }).strict(),
]);
export type ClipboardFileReplyValue = z.infer<typeof clipboardFileReplyValueSchema>;
