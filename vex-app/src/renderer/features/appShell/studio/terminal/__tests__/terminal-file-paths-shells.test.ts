// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { quoteTerminalFilePaths } from "../terminal-file-paths.js";

const attackPaths = ['C:\\tmp\\a";whoami;#', "/tmp/a';whoami;#", "/tmp/space $HOME `whoami` \\tail\\"];
const posixShells = ["bash", "sh", "zsh", "fish"];

function installed(shell: string): boolean {
  return spawnSync(shell, ["--version"], { encoding: "utf8", timeout: 10_000 }).error === undefined;
}

function quoted(shell: string): string {
  const result = quoteTerminalFilePaths(attackPaths, shell);
  if (result.kind !== "ready") throw new Error(result.message);
  return result.text;
}

describe("literal arguments through installed shell parsers", () => {
  for (const shell of posixShells) {
    it.skipIf(!installed(shell))(`${shell} receives exactly the original paths as arguments`, () => {
      const result = spawnSync(shell, ["-c", `printf '%s\\0' ${quoted(shell)}`], { encoding: "utf8", timeout: 10_000 });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${attackPaths.join("\0")}\0`);
    });
  }

  for (const shell of ["pwsh", "powershell"]) {
    it.skipIf(!installed(shell))(`${shell} receives both attack paths as single literal arguments`, () => {
      const script = `function Read-Arguments { ConvertTo-Json -Compress -InputObject @($args) }; Read-Arguments ${quoted(shell)}`;
      const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 10_000 });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(attackPaths);
    });
  }
});
