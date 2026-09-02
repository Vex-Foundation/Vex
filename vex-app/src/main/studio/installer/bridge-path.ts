/**
 * Where the bridge binaries are, as absolute paths a config file or a spawn
 * can name.
 *
 * TWO ARTIFACTS, ONE LAYOUT. `vex-mcp` is the MCP bridge every agent config
 * points at, on every platform Vex ships. `vex-pipe-front` is the Windows-only
 * front for the named pipe, spawned by main rather than named in a config, and
 * it exists on NO other platform - `locateStudioPipeFront` says
 * `unsupported_platform` there rather than reporting a missing file, because
 * "it was never built for this OS" and "this installation is damaged" call for
 * opposite responses. Both resolve through the same packaged/development rule
 * below and the same `X_OK` check.
 *
 * Every agent config Vex writes contains this path verbatim: it is the command
 * the client spawns. There are exactly two places it can be, and they are
 * decided by packaging, never by a search:
 *
 *   - PACKAGED: `<resources>/bridge/vex-mcp` (`.exe` on Windows). Both
 *     electron-builder configs stage `resources/bridge-${arch}` to `bridge`, so
 *     the runtime path is arch-independent by construction.
 *   - DEVELOPMENT: `<repo>/bridge/dist/<goos>-<goarch>/vex-mcp`, which is where
 *     the Go build wrapper puts it (`vex-app/scripts/bridge-artifact.mjs` owns
 *     that layout and this module mirrors its vocabulary).
 *
 * NO PATH SEARCH, NO `PATH` LOOKUP, NO FALLBACK TO A BARE NAME. A config that
 * says `vex-mcp` would let any binary of that name on the user's `PATH` be
 * spawned by their coding agent with the project's authority. The path is
 * absolute and it comes from the app's own installation.
 *
 * A MISSING BINARY IS AN HONEST OUTCOME. On a development machine that has not
 * built the Go bridge, `locateStudioBridge` returns `unavailable`, and the
 * installer reports that instead of writing configs that point at nothing.
 */

import { access, constants } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

/** Electron's arch vocabulary to Go's. Mirrors `scripts/bridge-artifact.mjs`. */
const GO_ARCH: Readonly<Record<string, string>> = { x64: "amd64", arm64: "arm64" };

/** Node's platform vocabulary to Go's. Mirrors `scripts/bridge-artifact.mjs`. */
const GOOS: Readonly<Record<string, string>> = {
  darwin: "darwin",
  win32: "windows",
  linux: "linux",
};

export type StudioBridgeLocation =
  | { readonly kind: "found"; readonly command: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * The Go target Vex builds a bridge for on this machine, or `null` when it
 * builds none.
 *
 * Exported because "is this platform supported at all" is a DIFFERENT answer
 * from "is the binary there", and `locateStudioBridge` folds both into
 * `unavailable` with different prose. `bridge-readiness.ts` has to tell them
 * apart, and discriminating on a sentence would be parsing a message. The maps
 * stay here rather than being copied, so there is still one owner.
 */
export function bridgeGoTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { readonly goos: string; readonly goarch: string } | null {
  const goos = GOOS[platform];
  const goarch = GO_ARCH[arch];
  if (goos === undefined || goarch === undefined) return null;
  return { goos, goarch };
}

/** The binary's file name for the running platform. */
export function bridgeBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "vex-mcp.exe" : "vex-mcp";
}

/**
 * The absolute path to the bridge, or a named reason it is not there.
 *
 * `appPath` and `resourcesPath` are injectable so the tests can exercise both
 * layouts without an Electron runtime; production callers pass nothing.
 */
export async function locateStudioBridge(options?: {
  readonly packaged?: boolean;
  readonly resourcesPath?: string;
  readonly repoRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): Promise<StudioBridgeLocation> {
  const platform = options?.platform ?? process.platform;
  const arch = options?.arch ?? process.arch;
  const packaged = options?.packaged ?? app.isPackaged;
  const name = bridgeBinaryName(platform);

  let candidate: string;
  if (packaged) {
    const resources = options?.resourcesPath ?? process.resourcesPath;
    candidate = path.join(resources, "bridge", name);
  } else {
    const target = bridgeGoTarget(platform, arch);
    if (target === null) {
      return {
        kind: "unavailable",
        detail:
          `Vex has no Studio bridge build for ${platform}/${arch}, so no coding-agent `
          + "config was written.",
      };
    }
    const repoRoot = options?.repoRoot ?? path.resolve(app.getAppPath(), "..");
    candidate = path.join(
      repoRoot,
      "bridge",
      "dist",
      `${target.goos}-${target.goarch}`,
      name,
    );
  }

  try {
    await access(candidate, constants.X_OK);
  } catch {
    return {
      kind: "unavailable",
      detail:
        "The Vex Studio bridge binary is missing from this installation, so no "
        + "coding-agent config was written. Reinstall Vex, or build the bridge if you "
        + "are running from source.",
    };
  }
  return { kind: "found", command: candidate };
}

export type StudioPipeFrontLocation =
  | { readonly kind: "found"; readonly command: string }
  | { readonly kind: "unsupported_platform"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/** The front's file name. Windows-only, so the extension is not conditional. */
export const PIPE_FRONT_BINARY_NAME = "vex-pipe-front.exe";

/**
 * The absolute path to the Windows named-pipe front, or a named reason it is
 * not there.
 *
 * `locateStudioBridge`'s twin, deliberately: same packaged/development
 * resolution, same `X_OK` check, and the SAME refusal to search `PATH` or fall
 * back to a bare name. This binary is spawned by the privileged main process,
 * so a bare name would let any `vex-pipe-front.exe` earlier on the user's
 * `PATH` run with Vex's authority - the exact substitution the absolute path
 * exists to prevent.
 *
 * THREE OUTCOMES, NOT TWO. `unsupported_platform` is not an error and must not
 * be reported as one: `bridge/build.sh` builds this artifact for
 * `windows-amd64` and `windows-arm64` only (the table in
 * `vex-app/scripts/bridge-artifact.mjs`), so on macOS and Linux its absence is
 * the design. Only on Windows does a missing file mean a damaged installation
 * or an unbuilt source tree.
 *
 * `packaged`, `resourcesPath`, `repoRoot`, `platform` and `arch` are injectable
 * so the tests can exercise every layout without an Electron runtime;
 * production callers pass nothing.
 */
export async function locateStudioPipeFront(options?: {
  readonly packaged?: boolean;
  readonly resourcesPath?: string;
  readonly repoRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): Promise<StudioPipeFrontLocation> {
  const platform = options?.platform ?? process.platform;
  const arch = options?.arch ?? process.arch;

  if (platform !== "win32") {
    return {
      kind: "unsupported_platform",
      detail:
        `The Vex Studio pipe front is a Windows component; ${platform} has no build of it. `
        + "This is expected, not a failure.",
    };
  }

  const packaged = options?.packaged ?? app.isPackaged;
  let candidate: string;
  if (packaged) {
    const resources = options?.resourcesPath ?? process.resourcesPath;
    candidate = path.join(resources, "bridge", PIPE_FRONT_BINARY_NAME);
  } else {
    const target = bridgeGoTarget(platform, arch);
    if (target === null) {
      return {
        kind: "unsupported_platform",
        detail:
          `Vex has no Studio bridge build for ${platform}/${arch}, so there is no pipe front `
          + "on this machine.",
      };
    }
    const repoRoot = options?.repoRoot ?? path.resolve(app.getAppPath(), "..");
    candidate = path.join(
      repoRoot,
      "bridge",
      "dist",
      `${target.goos}-${target.goarch}`,
      PIPE_FRONT_BINARY_NAME,
    );
  }

  try {
    await access(candidate, constants.X_OK);
  } catch {
    return {
      kind: "unavailable",
      detail:
        "The Vex Studio pipe front is missing from this installation. Reinstall Vex, or "
        + "build the bridge if you are running from source.",
    };
  }
  return { kind: "found", command: candidate };
}
