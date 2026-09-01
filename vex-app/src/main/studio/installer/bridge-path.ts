/**
 * Where the `vex-mcp` bridge binary is, as an absolute path a config file can
 * name.
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
