export const TERMINAL_DROP_MAX_FILES = 32;
const MAX_INSERT_LENGTH = 32_768;

export type TerminalFilePathsResult =
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Multiple paths form literal arguments, space separated, with no Enter.
 * launchShellName comes from the host's resolved executable, never an OSC title
 * or the operating system. Missing or unsupported launch metadata fails closed.
 */
export function quoteTerminalFilePaths(
  paths: readonly string[],
  launchShellName: string | null | undefined,
): TerminalFilePathsResult {
  const shell = launchShellName?.toLowerCase().replace(/\.exe$/, "");
  if (!["bash", "zsh", "sh", "fish", "pwsh", "powershell", "cmd"].includes(shell ?? "")) {
    return { kind: "refused", message: "The terminal's launched shell is unknown or unsupported for file quoting. No paths were inserted." };
  }
  if (paths.length === 0 || paths.length > TERMINAL_DROP_MAX_FILES) {
    return { kind: "refused", message: `Choose between 1 and ${TERMINAL_DROP_MAX_FILES} files. No paths were inserted.` };
  }
  const quoted: string[] = [];
  for (const path of paths) {
    if (path === "" || /[\x00-\x1f\x7f]/.test(path)) {
      return { kind: "refused", message: "A file path contains a control character. No paths were inserted." };
    }
    if (shell === "pwsh" || shell === "powershell") {
      // PowerShell recognizes typographic quotes as string delimiters too.
      if (/[\u2018-\u201e]/.test(path)) {
        return { kind: "refused", message: "A file path contains a quote character PowerShell treats as a delimiter. No paths were inserted." };
      }
      quoted.push(`'${path.replace(/'/g, "''")}'`);
    } else if (shell === "cmd") {
      // Delayed expansion can be enabled in an existing cmd session, so ! is
      // refused alongside metacharacters and percent expansion in every mode.
      if (/["%^&|<>!]/.test(path)) {
        return { kind: "refused", message: "A file path contains a quote or expansion character cmd cannot safely insert. No paths were inserted." };
      }
      quoted.push(`"${path}"`);
    } else {
      // fish interprets escaped backslashes even within single quotes.
      const literal = shell === "fish" ? path.replace(/\\/g, "\\\\") : path;
      quoted.push(`'${literal.replace(/'/g, "'\\''")}'`);
    }
  }
  const text = quoted.join(" ");
  if (text.length > MAX_INSERT_LENGTH) {
    return { kind: "refused", message: "The file paths are too large to insert together. Drop fewer files. No paths were inserted." };
  }
  return { kind: "ready", text };
}
