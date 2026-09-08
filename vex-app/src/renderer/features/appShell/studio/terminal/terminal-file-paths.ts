import type { StudioPlatform } from "../keybindings-labels.js";

export const TERMINAL_DROP_MAX_FILES = 32;
const MAX_INSERT_LENGTH = 32_768;

export type TerminalFilePathsResult =
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "refused"; readonly message: string };

/** Multiple paths are inserted together, space separated, with no Enter. */
export function quoteTerminalFilePaths(
  paths: readonly string[],
  platform: StudioPlatform,
): TerminalFilePathsResult {
  if (paths.length === 0 || paths.length > TERMINAL_DROP_MAX_FILES) {
    return { kind: "refused", message: `Choose between 1 and ${TERMINAL_DROP_MAX_FILES} files. No paths were inserted.` };
  }
  const quoted: string[] = [];
  for (const path of paths) {
    if (path === "" || /[\x00-\x1f\x7f]/.test(path)) {
      return { kind: "refused", message: "A file path contains a control character. No paths were inserted." };
    }
    if (platform === "win32") {
      // The pane has no authoritative live shell type. These characters expand
      // differently in cmd and PowerShell even inside double quotes. Refuse
      // the batch rather than rewrite a filename or invent a shell dialect.
      if (/["%!$`]/.test(path) || path.endsWith("\\")) {
        return { kind: "refused", message: "This Windows path needs shell-specific quoting. Type it using your shell's quoting rules. No paths were inserted." };
      }
      quoted.push(`"${path}"`);
    } else {
      quoted.push(`'${path.replace(/'/g, "'\\''")}'`);
    }
  }
  const text = quoted.join(" ");
  if (text.length > MAX_INSERT_LENGTH) {
    return { kind: "refused", message: "The file paths are too large to insert together. Drop fewer files. No paths were inserted." };
  }
  return { kind: "ready", text };
}
