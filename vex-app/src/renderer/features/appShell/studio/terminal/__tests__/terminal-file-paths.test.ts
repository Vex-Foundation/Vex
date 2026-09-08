import { describe, expect, it } from "vitest";
import { quoteTerminalFilePaths } from "../terminal-file-paths.js";

describe("literal terminal file arguments", () => {
  it.each(["bash", "zsh", "sh", "fish"])("quotes spaces, apostrophes and shell syntax for %s", (shell) => {
    expect(quoteTerminalFilePaths(["/tmp/a b", "/tmp/it's $(touch nope);.png"], shell)).toEqual({
      kind: "ready", text: "'/tmp/a b' '/tmp/it'\\''s $(touch nope);.png'",
    });
  });

  it.each(["pwsh", "powershell", "pwsh.exe", "PowerShell.EXE"])("quotes both platform attack cases literally for %s", (shell) => {
    expect(quoteTerminalFilePaths(['C:\\tmp\\a";whoami;#', "/tmp/a';whoami;#"], shell)).toEqual({
      kind: "ready", text: `'C:\\tmp\\a";whoami;#' '/tmp/a'';whoami;#'`,
    });
    expect(quoteTerminalFilePaths(["/tmp/$HOME `whoami` \\", "C:\\a&b"], shell)).toEqual({
      kind: "ready", text: "'/tmp/$HOME `whoami` \\' 'C:\\a&b'",
    });
  });

  it.each(["\u2018", "\u2019", "\u201a", "\u201b", "\u201c", "\u201d", "\u201e"])("refuses PowerShell quote delimiter %j for the whole batch", (quote) => {
    expect(quoteTerminalFilePaths(["/tmp/safe", `C:\\tmp\\a${quote};whoami;#`], "pwsh")).toEqual({
      kind: "refused", message: expect.stringContaining("PowerShell"),
    });
  });

  it("quotes ordinary cmd arguments", () => {
    expect(quoteTerminalFilePaths(["C:\\my files\\shot.png", "C:\\folder\\"], "cmd.exe")).toEqual({
      kind: "ready", text: '"C:\\my files\\shot.png" "C:\\folder\\"',
    });
  });

  it.each(['"', "%", "^", "&", "|", "<", ">", "!"])("refuses cmd delimiter or expansion %j by name", (character) => {
    expect(quoteTerminalFilePaths(["C:\\safe", `C:\\tmp\\a${character}b`], "cmd")).toEqual({
      kind: "refused", message: expect.stringContaining("cmd"),
    });
  });

  it("escapes fish backslashes inside single quotes", () => {
    expect(quoteTerminalFilePaths(["/tmp/a\\\\b\\'c"], "fish")).toEqual({
      kind: "ready", text: "'/tmp/a\\\\\\\\b\\\\'\\''c'",
    });
  });

  it.each([null, undefined, "", "system_default", "nu", "linux", "darwin", "win32", "bash -c", "/bin/bash"])("refuses unknown launch metadata %j without an OS fallback", (shell) => {
    expect(quoteTerminalFilePaths(["/tmp/file"], shell)).toEqual({
      kind: "refused", message: expect.stringContaining("unknown or unsupported"),
    });
  });

  it.each([[], [""], ["/tmp/a\nb"], ["/tmp/a\u0000b"], Array.from({ length: 33 }, () => "/tmp/a"), ["a".repeat(32_769)]].map((paths) => ({ paths })))("refuses invalid batches whole", ({ paths }) => {
    expect(quoteTerminalFilePaths(paths, "bash").kind).toBe("refused");
  });
});
