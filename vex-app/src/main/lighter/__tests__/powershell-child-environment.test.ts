/**
 * The environment the Authenticode gate hands its PowerShell child.
 *
 * The v0.2.8 Windows release job died inside `Get-AuthenticodeSignature`:
 * Windows PowerShell 5.1, spawned from a step running under pwsh 7, inherited
 * pwsh's PSModulePath and could not load the 7.x `Microsoft.PowerShell.Security`
 * it resolved from it. The gate's answer is to hand the child no PSModulePath
 * at all, so each PowerShell computes its own. This pins that, from the Linux
 * runner, through the real module in a real node process (the same pattern
 * `signer-packaging.test.ts` uses, and for the same reason: the script resolves
 * itself by `import.meta.url`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const CHECK_PAYLOAD = path.resolve(__dirname, "..", "..", "..", "..", "scripts", "check-packaged-payload.mjs");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function childEnvironment(env: Record<string, string>): Record<string, string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vex-powershell-env-"));
  roots.push(root);
  const driver = path.join(root, "driver.mjs");
  writeFileSync(
    driver,
    `import { powerShellChildEnvironment } from ${JSON.stringify(pathToFileURL(CHECK_PAYLOAD).href)};\n`
      + `console.log(JSON.stringify(powerShellChildEnvironment(${JSON.stringify(env)})));\n`,
  );
  const stdout = execFileSync(process.execPath, [driver], { encoding: "utf8" });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
}

describe("the PowerShell child environment of the Authenticode gate", () => {
  it("drops PSModulePath in every letter case and keeps everything else", () => {
    expect(
      childEnvironment({
        PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules;C:\\Users\\r\\Documents\\PowerShell\\Modules",
        PSMODULEPATH: "C:\\Program Files\\PowerShell\\7\\Modules",
        psmodulepath: "x",
        PATH: "C:\\Windows\\System32",
        AZURE_TENANT_ID: "tenant",
      }),
    ).toEqual({ PATH: "C:\\Windows\\System32", AZURE_TENANT_ID: "tenant" });
  });

  it("leaves an environment without PSModulePath unchanged", () => {
    expect(childEnvironment({ PATH: "/usr/bin", HOME: "/home/r" })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/r",
    });
  });
});
