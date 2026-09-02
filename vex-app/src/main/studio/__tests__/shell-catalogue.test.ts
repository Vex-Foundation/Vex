/**
 * SHELL DETECTION, against a scripted filesystem.
 *
 * The subject is a decision - "does this shell exist here, and what does its id
 * resolve to" - so the filesystem is the only thing faked, through the module's
 * own `exists` seam. Everything else is the production code, including the
 * candidate table, which is the part that would silently rot.
 *
 * The tests that matter are the NEGATIVE ones. A catalogue that offers a shell
 * is a convenience; a `resolveShellLaunch` that returns a path for an id it
 * should have refused is a hole, and so is one that quietly substitutes another
 * shell. Both are asserted directly.
 */

import { describe, expect, it } from "vitest";
import {
  readShellCatalogue,
  resolveShellLaunch,
  type ShellCatalogueDeps,
} from "../shell-catalogue.js";

/** A filesystem that contains exactly the listed absolute paths. */
function deps(
  present: readonly string[],
  overrides: Partial<ShellCatalogueDeps> = {},
): ShellCatalogueDeps {
  const set = new Set(present);
  return {
    platform: "linux",
    env: { SHELL: "/bin/zsh" },
    exists: (candidate) => Promise.resolve(set.has(candidate)),
    ...overrides,
  };
}

describe("readShellCatalogue", () => {
  it("lists EVERY known shell, marking the ones this machine does not have", async () => {
    const catalogue = await readShellCatalogue(deps(["/bin/bash", "/bin/sh", "/bin/zsh"]));
    const byId = new Map(catalogue.shells.map((shell) => [shell.id, shell.available]));

    expect(byId.get("bash")).toBe(true);
    expect(byId.get("sh")).toBe(true);
    // Present as a ROW, absent as a capability. A picker that omitted it would
    // leave the user unable to tell "Vex cannot do this" from "I have not
    // installed this".
    expect(byId.get("fish")).toBe(false);
    expect(byId.get("pwsh")).toBe(false);
  });

  it("finds a shell at ANY of its candidate paths, not only the first", async () => {
    const homebrew = await readShellCatalogue(deps(["/opt/homebrew/bin/fish"]));
    expect(homebrew.shells.find((shell) => shell.id === "fish")?.available).toBe(true);

    const usrLocal = await readShellCatalogue(deps(["/usr/local/bin/fish"]));
    expect(usrLocal.shells.find((shell) => shell.id === "fish")?.available).toBe(true);
  });

  it("marks system_default available from the user's own $SHELL", async () => {
    const catalogue = await readShellCatalogue(deps(["/bin/zsh"]));
    expect(catalogue.shells.find((shell) => shell.id === "system_default")?.available)
      .toBe(true);
  });

  it("names system_default as the default, so the default has ONE owner", async () => {
    const catalogue = await readShellCatalogue(deps(["/bin/bash", "/bin/sh"]));
    expect(catalogue.defaultShellId).toBe("system_default");
  });

  it("NEVER puts a filesystem path in the answer", async () => {
    const catalogue = await readShellCatalogue(deps(["/bin/bash", "/bin/sh", "/bin/zsh"]));
    const serialized = JSON.stringify(catalogue);
    expect(serialized).not.toContain("/bin/");
    expect(serialized).not.toContain("/usr/");
  });

  it("offers the Windows shells on win32 and the POSIX ones on linux", async () => {
    const windows = await readShellCatalogue(
      deps(["C:\\Windows\\System32\\cmd.exe"], {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      }),
    );
    const windowsById = new Map(windows.shells.map((s) => [s.id, s.available]));
    expect(windowsById.get("cmd")).toBe(true);
    // bash has no Windows candidate at all: it is not offered rather than
    // offered-and-broken.
    expect(windowsById.get("bash")).toBe(false);

    const linux = await readShellCatalogue(deps(["/bin/bash", "/bin/sh"]));
    const linuxById = new Map(linux.shells.map((s) => [s.id, s.available]));
    expect(linuxById.get("cmd")).toBe(false);
    expect(linuxById.get("bash")).toBe(true);
  });
});

describe("resolveShellLaunch is the enforcement", () => {
  it("resolves an installed shell to an absolute executable with no arguments", async () => {
    const launch = await resolveShellLaunch("bash", deps(["/bin/bash"]));
    expect(launch).toEqual({ executable: "/bin/bash", args: [] });
  });

  it("REFUSES a shell that is not installed, and does NOT fall back to another", async () => {
    // fish is absent; bash and sh are both present and are exactly what a
    // silent fallback would reach for.
    const launch = await resolveShellLaunch("fish", deps(["/bin/bash", "/bin/sh"]));
    expect(launch).toBeNull();
  });

  it("refuses a shell that WAS available when the catalogue was read", async () => {
    const installed = deps(["/bin/fish", "/usr/bin/fish"]);
    expect(
      (await readShellCatalogue(installed)).shells.find((s) => s.id === "fish")
        ?.available,
    ).toBe(true);

    // The user uninstalled it while the picker was open. The catalogue the
    // renderer holds still says available; this call is what decides.
    const uninstalled = deps(["/bin/bash"]);
    expect(await resolveShellLaunch("fish", uninstalled)).toBeNull();
  });

  it("refuses a $SHELL that is not an absolute path rather than searching PATH", async () => {
    // The program Vex spawns must not depend on how PATH happens to be set in
    // the environment this process inherited.
    const launch = await resolveShellLaunch(
      "system_default",
      deps(["/bin/bash"], { env: { SHELL: "bash" } }),
    );
    expect(launch).toBeNull();
  });

  it("falls back to the POSIX guaranteed shell when $SHELL is unset", async () => {
    const launch = await resolveShellLaunch(
      "system_default",
      deps(["/bin/sh"], { env: {} }),
    );
    expect(launch).toEqual({ executable: "/bin/sh", args: [] });
  });

  it("launches NO login flag, for any shell", async () => {
    for (const id of ["bash", "zsh", "sh"] as const) {
      const launch = await resolveShellLaunch(id, deps(["/bin/bash", "/bin/zsh", "/bin/sh"]));
      expect(launch?.args).toEqual([]);
    }
  });
});
