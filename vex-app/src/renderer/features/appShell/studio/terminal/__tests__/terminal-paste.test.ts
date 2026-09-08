import { describe, expect, it } from "vitest";
import { decideTerminalPaste, terminalPasteAsOneLine, terminalPastePreview } from "../terminal-paste.js";

describe("terminal text paste policy", () => {
  it.each(["\n", "\r\n", "\r"])("strips one trailing %j without disabling interior warnings", (ending) => {
    expect(decideTerminalPaste(`echo safe${ending}`, false, true)).toEqual({ kind: "paste", text: "echo safe" });
    expect(decideTerminalPaste(`first${ending}second${ending}`, false, true)).toEqual({ kind: "confirm", text: `first${ending}second`, lineCount: 2 });
    expect(decideTerminalPaste(`echo safe${ending}`, false, false)).toEqual({ kind: "paste", text: "echo safe" });
  });
  it("leaves bracketed paste content intact and suppresses the warning", () => {
    expect(decideTerminalPaste("first\nsecond\n", true, true)).toEqual({ kind: "paste", text: "first\nsecond\n" });
  });
  it("separates words when converting line endings", () => {
    expect(terminalPasteAsOneLine("first\r\nsecond\rthird\nfourth")).toBe("first second third fourth");
  });
  it("bounds preview by Unicode characters and reports omitted content", () => {
    expect(terminalPastePreview(`${"😀".repeat(35)}\na\nb\nc`)).toEqual({ lines: ["😀".repeat(30), "a", "b"], omittedLines: 1, shortenedLines: 1 });
  });
});
