import { describe, expect, it } from "vitest";
import { decideTerminalPaste, terminalPasteAsOneLine, terminalPastePreview } from "../terminal-paste.js";
import { quoteTerminalFilePaths } from "../terminal-file-paths.js";

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

describe("terminal file path insertion", () => {
  it.each(["linux", "darwin"] as const)("quotes every path literally on %s without adding Enter", (platform) => {
    expect(quoteTerminalFilePaths(["/tmp/a b", "/tmp/it's $(touch nope);.png"], platform)).toEqual({ kind: "ready", text: "'/tmp/a b' '/tmp/it'\\''s $(touch nope);.png'" });
  });
  it("quotes ordinary Windows paths without running them", () => {
    expect(quoteTerminalFilePaths(["C:\\my files\\shot.png", "C:\\work\\a&b.txt"], "win32")).toEqual({ kind: "ready", text: '"C:\\my files\\shot.png" "C:\\work\\a&b.txt"' });
  });
  it.each(["C:\\%HOME%", "C:\\$HOME", "C:\\!PATH!", "C:\\`whoami`", "C:\\a\"b", "C:\\folder\\"])("refuses ambiguous Windows expansion in %s", (path) => {
    expect(quoteTerminalFilePaths(["C:\\safe", path], "win32").kind).toBe("refused");
  });
  it.each([[], [""], ["/tmp/a\nb"], ["/tmp/a\u0000b"], Array.from({ length: 33 }, () => "/tmp/a"), ["a".repeat(32_769)]].map((paths) => ({ paths })) )("refuses invalid batches whole", ({ paths }) => {
    expect(quoteTerminalFilePaths(paths, "linux").kind).toBe("refused");
  });
});
