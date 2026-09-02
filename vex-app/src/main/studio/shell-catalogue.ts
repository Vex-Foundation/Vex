/**
 * WHICH SHELLS EXIST ON THIS MACHINE, and what an id from the wire resolves to.
 *
 * THE ONE PLACE a `TerminalShellId` becomes an executable. The renderer names a
 * shell by id and never by path (`terminalShellIdSchema` says why); this module
 * is the other half of that contract, and it is the reason the id is safe to
 * accept: every answer it can give is a member of a table written here, so the
 * worst a compromised renderer can do is open a different shell that was
 * already installed.
 *
 * ## Cloned from VS Code, and where the clone stops
 *
 * `platform/terminal/node/terminalProfiles.ts` is the reference: profiles are
 * DETECTED on the privileged side by probing candidate paths, `PATH` is
 * searched only for a non-absolute candidate, and a profile whose binary does
 * not resolve simply is not offered. Two of its behaviours are adopted
 * verbatim in spirit:
 *
 *  - CANDIDATE LISTS, not a single path. `validateProfilePaths` walks a list
 *    and takes the first that exists, because the same shell lives in
 *    different places on different distributions and on Intel vs Apple Silicon
 *    (`/bin/zsh`, `/usr/bin/zsh`, `/usr/local/bin/fish`, `/opt/homebrew/bin/fish`).
 *    A single hard-coded path is how a shell that is installed reads as absent.
 *  - THE FILESYSTEM DECIDES. Availability is a `stat`, never a guess from the
 *    platform name.
 *
 * What is deliberately NOT cloned: VS Code's configurable profiles, its
 * extension-contributed profiles, its WSL and Git Bash discovery, and its
 * `/etc/shells` scan. All four turn the set of launchable programs into an OPEN
 * one - a setting or an extension names the binary - and an open set is exactly
 * what `terminalShellIdSchema` exists to refuse. The cost is stated: a user
 * whose shell is nushell or elvish gets it only through `system_default`.
 *
 * ## No cache
 *
 * Detection is a handful of `stat` calls on a user-initiated read, and a cache
 * here would need an invalidation story for "the user just installed fish"
 * that no event in this process can provide. Availability is re-resolved at
 * every spawn regardless, so a cache would only make the PICKER stale while
 * the enforcement stayed correct - the worst of both.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import {
  terminalShellIdSchema,
  type TerminalShellCatalogue,
  type TerminalShellId,
  type TerminalShellOption,
} from "@shared/schemas/terminal.js";

/** What a shell is called in the picker, and where it might live. */
interface ShellDefinition {
  readonly label: string;
  /** Absolute candidates, in preference order. Empty means POSIX-only shell. */
  readonly posix: readonly string[];
  /** Absolute candidates for Windows, in preference order. */
  readonly win32: readonly string[];
}

/**
 * The table. Every launchable program in the product is on it.
 *
 * Windows paths are built from `%SystemRoot%` rather than hard-coded to `C:`,
 * which is the same correction VS Code makes for its own `System32` paths, and
 * from `%ProgramFiles%` for PowerShell 7 - a machine whose system volume is not
 * `C:` is unusual but is not a machine where the terminal should offer nothing.
 */
function shellDefinitions(env: NodeJS.ProcessEnv): Record<
  Exclude<TerminalShellId, "system_default">,
  ShellDefinition
> {
  const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  const system32 = path.win32.join(systemRoot, "System32");
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  return {
    bash: {
      label: "bash",
      posix: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"],
      win32: [],
    },
    zsh: {
      label: "zsh",
      posix: ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"],
      win32: [],
    },
    fish: {
      label: "fish",
      posix: [
        "/usr/bin/fish",
        "/usr/local/bin/fish",
        // Homebrew on Apple Silicon installs outside `/usr/local`.
        "/opt/homebrew/bin/fish",
      ],
      win32: [],
    },
    sh: {
      label: "sh",
      // POSIX guarantees this one, which is why it is the fallback everywhere.
      posix: ["/bin/sh"],
      win32: [],
    },
    pwsh: {
      label: "PowerShell",
      posix: ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/microsoft/powershell/7/pwsh"],
      win32: [path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe")],
    },
    powershell: {
      label: "Windows PowerShell",
      posix: [],
      win32: [
        path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
      ],
    },
    cmd: {
      label: "Command Prompt",
      posix: [],
      win32: [path.win32.join(system32, "cmd.exe")],
    },
  };
}

/**
 * The user's OWN shell, with the platform's guaranteed fallback.
 *
 * Unchanged from what the terminal domain has always launched, and the
 * reasoning is unchanged with it: `$SHELL` with NO arguments, not a login
 * shell. `-l` re-runs the user's login profile inside an app that already
 * inherited its environment, which duplicates PATH entries and re-prints motd
 * banners into every new terminal. VS Code's default is the same. The fallbacks
 * are the POSIX and Windows guaranteed shells rather than a fancier one,
 * because a fallback that is not present turns "your shell is unset" into "the
 * terminal is broken".
 */
function systemDefaultExecutable(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") return env.ComSpec ?? "cmd.exe";
  return env.SHELL ?? "/bin/sh";
}

/** Candidates for one id on one platform, in preference order. */
function candidatesFor(
  id: TerminalShellId,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  if (id === "system_default") return [systemDefaultExecutable(platform, env)];
  const definition = shellDefinitions(env)[id];
  return platform === "win32" ? definition.win32 : definition.posix;
}

/** How a shell is named in the picker. */
function labelFor(id: TerminalShellId, env: NodeJS.ProcessEnv): string {
  if (id === "system_default") return "Default shell";
  return shellDefinitions(env)[id].label;
}

/**
 * Injected so the catalogue is testable without installing shells, and so a
 * test can prove the refusal path without uninstalling one.
 */
export interface ShellCatalogueDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Does this absolute path name a file or a symlink to one? */
  readonly exists: (candidate: string) => Promise<boolean>;
}

/** The production probe: a file or a symlink to one, never a directory. */
async function existsAsFile(candidate: string): Promise<boolean> {
  try {
    // `stat`, not `lstat`: a shell reached through a symlink is a shell, and
    // every distribution ships at least one of these as a link.
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

export function productionShellCatalogueDeps(): ShellCatalogueDeps {
  return { platform: process.platform, env: process.env, exists: existsAsFile };
}

/**
 * The first candidate that exists, or `null`.
 *
 * A NON-ABSOLUTE candidate - which only `system_default` can produce, when
 * `$SHELL` is unset and something odd is in `ComSpec` - is REFUSED rather than
 * searched for on `PATH`. Resolving a bare name against `PATH` here would mean
 * the program Vex spawns depends on an environment variable, and the pty host
 * already refuses to spawn a shell it cannot resolve to an absolute path
 * (`launch_executable_missing`), so the refusal is the same either way and this
 * is the earlier and clearer place for it.
 */
async function resolveFirst(
  candidates: readonly string[],
  deps: ShellCatalogueDeps,
): Promise<string | null> {
  for (const candidate of candidates) {
    const isAbsolute = deps.platform === "win32"
      ? path.win32.isAbsolute(candidate)
      : path.posix.isAbsolute(candidate);
    if (!isAbsolute) continue;
    if (await deps.exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Every id, with a per-machine `available`, and the id to preselect.
 *
 * The list is NOT filtered down to the available ones. A picker that silently
 * omitted zsh on a machine without zsh would leave the user wondering whether
 * Vex supports it at all; a row that says it is not installed answers that. The
 * ORDER is the enum's order, so the picker does not reshuffle itself between
 * machines.
 */
export async function readShellCatalogue(
  deps: ShellCatalogueDeps = productionShellCatalogueDeps(),
): Promise<TerminalShellCatalogue> {
  const shells: TerminalShellOption[] = [];
  for (const id of terminalShellIdSchema.options) {
    const resolved = await resolveFirst(candidatesFor(id, deps.platform, deps.env), deps);
    shells.push({ id, label: labelFor(id, deps.env), available: resolved !== null });
  }
  return { shells, defaultShellId: "system_default" };
}

/**
 * What to spawn for an id, RE-RESOLVED at the moment of the spawn.
 *
 * `null` means the shell is not installed and the create is refused
 * `launch_shell_unavailable`. There is deliberately NO FALLBACK to another
 * shell: a user who asked for fish and silently received bash would run the
 * wrong startup files and see the wrong prompt, and would have no signal that
 * anything had been substituted. A named refusal they can act on is the
 * smaller cost.
 *
 * This is the enforcement, and the `available` flag in the catalogue is not.
 * The renderer's copy of the catalogue can be arbitrarily old and can have been
 * tampered with; this call happens after it, in main, on every create.
 */
export async function resolveShellLaunch(
  shellId: TerminalShellId,
  deps: ShellCatalogueDeps = productionShellCatalogueDeps(),
): Promise<{ executable: string; args: string[] } | null> {
  const resolved = await resolveFirst(
    candidatesFor(shellId, deps.platform, deps.env),
    deps,
  );
  if (resolved === null) return null;
  // NO ARGUMENTS, for every shell. See `systemDefaultExecutable` above.
  return { executable: resolved, args: [] };
}
