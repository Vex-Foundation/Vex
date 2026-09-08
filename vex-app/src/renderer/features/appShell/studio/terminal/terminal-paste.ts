/** Paste policy is independent of the clipboard transport and dialog. */
export type TerminalPasteDecision =
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "confirm"; readonly text: string; readonly lineCount: number };

export function decideTerminalPaste(
  text: string,
  bracketedPaste: boolean,
  warn: boolean,
): TerminalPasteDecision {
  if (bracketedPaste) return { kind: "paste", text };
  // Strip one final line ending even when warnings are disabled. The user can
  // still press Enter after reviewing the inserted command.
  const prepared = text.replace(/(?:\r\n|\r|\n)$/, "");
  const lineCount = prepared.split(/\r\n|\r|\n/).length;
  return warn && lineCount > 1
    ? { kind: "confirm", text: prepared, lineCount }
    : { kind: "paste", text: prepared };
}

export function terminalPasteAsOneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

export function terminalPastePreview(text: string): {
  readonly lines: readonly string[];
  readonly omittedLines: number;
  readonly shortenedLines: number;
} {
  const all = text.split(/\r\n|\r|\n/);
  const visible = all.slice(0, 3);
  return {
    lines: visible.map((line) => [...line].slice(0, 30).join("")),
    omittedLines: Math.max(0, all.length - 3),
    shortenedLines: visible.filter((line) => [...line].length > 30).length,
  };
}
