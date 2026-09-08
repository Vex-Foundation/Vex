import { z } from "zod";

/** UTF-16 code units. Oversize text is refused whole, never shortened. */
export const TERMINAL_CLIPBOARD_MAX_LENGTH = 1_048_576;
export const TERMINAL_CLIPBOARD_TRANSPORT_MAX = 2_097_152;
export const TERMINAL_FILE_PATH_MAX_LENGTH = 32_768;

export const terminalClipboardRefusalSchema = z.enum([
  "terminal_clipboard_too_large",
  "terminal_clipboard_unavailable",
]);
export type TerminalClipboardRefusal = z.infer<typeof terminalClipboardRefusalSchema>;

const refusedSchema = z.object({
  kind: z.literal("refused"),
  reason: terminalClipboardRefusalSchema,
}).strict();

export const readClipboardContentInputSchema = z.object({}).strict();
export const readClipboardTextInputSchema = z.object({}).strict();
export const writeClipboardTextInputSchema = z.object({
  text: z.string().max(TERMINAL_CLIPBOARD_TRANSPORT_MAX),
}).strict();
export const triggerTerminalPasteInputSchema = z.object({}).strict();

export const readClipboardTextValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(TERMINAL_CLIPBOARD_MAX_LENGTH) }).strict(),
  refusedSchema,
]);
export const readClipboardContentValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(TERMINAL_CLIPBOARD_MAX_LENGTH) }).strict(),
  z.object({ kind: z.literal("files") }).strict(),
  z.object({ kind: z.literal("image") }).strict(),
  z.object({ kind: z.literal("empty") }).strict(),
  refusedSchema,
]);
export type ReadClipboardContentValue = z.infer<typeof readClipboardContentValueSchema>;

export const writeClipboardTextValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("written") }).strict(),
  refusedSchema,
]);
export const triggerTerminalPasteValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("triggered") }).strict(),
  refusedSchema,
]);
export type ReadClipboardTextValue = z.infer<typeof readClipboardTextValueSchema>;
export type WriteClipboardTextValue = z.infer<typeof writeClipboardTextValueSchema>;
export type TriggerTerminalPasteValue = z.infer<typeof triggerTerminalPasteValueSchema>;

export const terminalFilePathValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resolved"),
    path: z.string().min(1).max(TERMINAL_FILE_PATH_MAX_LENGTH),
  }).strict(),
  z.object({
    kind: z.literal("refused"),
    reason: z.enum(["terminal_file_path_unavailable", "terminal_file_path_too_long"]),
  }).strict(),
]);
export type TerminalFilePathValue = z.infer<typeof terminalFilePathValueSchema>;
