/**
 * CAN VEX STUDIO USE ITS BRIDGE, AND IF NOT, WHAT IS THE USER SUPPOSED TO DO?
 *
 * `locateStudioBridge` already answers "is the binary there", honestly, and
 * refuses to write agent configs when it is not. What it does NOT do is turn
 * that refusal into something a person can act on, and the two audiences need
 * opposite sentences:
 *
 *   PACKAGED   The bridge shipped inside `resources/`. If it is gone, the
 *              installation is damaged. The remedy is reinstalling Vex, and
 *              GO IS NEVER MENTIONED (owner decision 2026-09-01). End users do
 *              not install compilers, and telling them to would be advice they
 *              cannot follow, on a screen that appeared because something
 *              already went wrong.
 *   FROM SOURCE Nobody built it yet. The remedy is a build, which needs the
 *              PINNED Go toolchain, so the toolchain is part of the diagnosis.
 *
 * ## Mirrored, not extracted, and this is the honest name for it
 *
 * `vex-app/scripts/bridge-freshness.mjs` already reads the Go pin and asks the
 * toolchain for its version. Main CANNOT import it: it is an `.mjs` dev script
 * outside the main bundle's graph, and pulling it in would drag its build
 * machinery (source hashing, artifact format assertions) into the packaged
 * app. Extracting a shared module would have to edit `scripts/`, which this
 * task does not own. So the two READS below are MIRRORED, and the mirror is
 * guarded by a test that runs the script's own `requiredGoVersion` next to
 * this module's reader and fails when they disagree.
 *
 * ## What is deliberately NOT answered here
 *
 * STALENESS. `evaluateBridgeFreshness` decides whether the built binary is
 * still the one the sources produce, and its verdict rests on a stamp over a
 * digest of every Go source file. Re-implementing that stamp in main would
 * create a SECOND source of truth for a durable format whose only writer is
 * the build wrapper, and a partial re-implementation (comparing only the
 * recorded toolchain, say) would report "current" for the most common staleness
 * there is. `pnpm dev` runs the real check through `doctor.mjs` on every start.
 * This module answers presence, not currency, and says so.
 *
 * ## Cost, and why this is a pull
 *
 * Packaged: one `access()`. From source with a built bridge: the same one
 * `access()`, and nothing else - the pin is not read and `go` is not spawned
 * unless the binary is missing. Only the already-broken path pays for a
 * subprocess, and that subprocess is bounded by a timeout and its output is
 * never forwarded anywhere.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import {
  studioGoVersionSchema,
  type StudioBridgeGoToolchain,
  type StudioBridgeHostPlatform,
  type StudioBridgeReadiness,
} from "@shared/schemas/studio-bridge-readiness.js";
import { log } from "../logger/index.js";
import {
  bridgeGoTarget,
  locateStudioBridge,
  type StudioBridgeLocation,
} from "./installer/bridge-path.js";

const execFileAsync = promisify(execFile);

/**
 * `bridge/build.sh` is the ONE owner of the pinned Go version, so this is a
 * read of that file and never a constant. Repo-root relative, mirroring
 * `BRIDGE_BUILD_SCRIPT` in `scripts/bridge-freshness.mjs`.
 */
const BRIDGE_BUILD_SCRIPT = path.join("bridge", "build.sh");

/** The same declaration `scripts/bridge-freshness.mjs` matches. */
const GO_PIN_PATTERN = /^readonly REQUIRED_GO_VERSION="([^"]+)"/m;

/**
 * A `go env GOVERSION` call takes milliseconds. Anything past this is a broken
 * PATH entry, a network filesystem or a hung wrapper script, and the user is
 * waiting on a diagnostic screen, so it is bounded rather than awaited.
 */
const GO_VERSION_TIMEOUT_MS = 5_000;

/** What asking the toolchain about itself produced. No prose crosses out. */
export type GoToolchainDetection =
  | { readonly kind: "ok"; readonly version: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unusable" };

/**
 * The three outside facts this module reads, injectable so every branch is
 * testable without uninstalling Go or unpacking an app. Production passes
 * none.
 */
export interface StudioBridgeReadinessProbes {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Where the binary is, or a reason it is not. */
  readonly locate: () => Promise<StudioBridgeLocation>;
  /** The pin from `bridge/build.sh`, or `null` when it does not declare one. */
  readonly readGoPin: () => Promise<string | null>;
  readonly detectGo: () => Promise<GoToolchainDetection>;
}

/**
 * Node's platform vocabulary narrowed to the closed wire set.
 *
 * `other` is not a failure: a from-source run on an unsupported platform is
 * reported as `unsupported_platform` before this is ever consulted, and the
 * member exists so a platform Node grows tomorrow renders generic guidance
 * instead of failing output validation.
 */
export function wirePlatform(
  platform: NodeJS.Platform,
): StudioBridgeHostPlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return platform;
  }
  return "other";
}

/**
 * The pinned Go version out of `bridge/build.sh`, or `null`.
 *
 * `null` covers both "no such file" and "the file no longer declares the pin".
 * Neither is guessed around: a from-source checkout that cannot state its own
 * pin is reported as `pin_unreadable`, because the alternative is writing
 * `go1.27.0` into a second file and letting the two drift.
 */
export async function readStudioBridgeGoPin(
  repoRoot: string,
): Promise<string | null> {
  let source: string;
  try {
    source = await readFile(path.join(repoRoot, BRIDGE_BUILD_SCRIPT), "utf8");
  } catch {
    return null;
  }
  const match = GO_PIN_PATTERN.exec(source);
  const declared = match?.[1];
  if (declared === undefined) return null;
  // A pin that is not a bare version token cannot go on the wire, and it is
  // also not something to render: the checkout declares something this reader
  // does not understand, which is the same user-visible situation as declaring
  // nothing. Rejecting it HERE keeps the failure a named readiness kind
  // instead of an output-validation contract violation with no diagnosis.
  return studioGoVersionSchema.safeParse(declared).success ? declared : null;
}

/**
 * Ask `go` which toolchain it is, the way `bridge/build.sh` does.
 *
 * `GOTOOLCHAIN=local` is the load-bearing part: without it Go reports (and
 * silently downloads) whatever a `toolchain` directive asks for, so this check
 * would pass against a toolchain the build then refuses.
 *
 * Failures are classified, never forwarded. `go`'s stderr can name the
 * developer's home directory and their whole PATH; that belongs in main's log
 * and nowhere near the renderer.
 */
export async function detectGoToolchain(): Promise<GoToolchainDetection> {
  try {
    const { stdout } = await execFileAsync("go", ["env", "GOVERSION"], {
      env: { ...process.env, GOTOOLCHAIN: "local" },
      timeout: GO_VERSION_TIMEOUT_MS,
      encoding: "utf8",
    });
    const version = stdout.trim();
    // Anything that is not a bare version token is treated as "it did not
    // report a version". `go` printing a warning line, a wrapper script
    // echoing a path, a shim answering in prose: all of them would otherwise
    // become a string this process forwards to the renderer, and the wire
    // schema would reject the whole payload, costing the user their
    // diagnostic. `unusable` is both true and actionable.
    if (!studioGoVersionSchema.safeParse(version).success) {
      log.warn(
        "[studio:bridge-readiness] go env GOVERSION did not print a version token",
      );
      return { kind: "unusable" };
    }
    return { kind: "ok", version };
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return { kind: "missing" };
    // Structural only: the message can carry PATH entries and home directories.
    log.warn(
      `[studio:bridge-readiness] go env GOVERSION failed code=${String(code)}`,
    );
    return { kind: "unusable" };
  }
}

/** Production probes. Split out so the resolver below stays pure of Electron. */
function defaultProbes(): StudioBridgeReadinessProbes {
  const repoRoot = path.resolve(app.getAppPath(), "..");
  return {
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    locate: () => locateStudioBridge(),
    readGoPin: () => readStudioBridgeGoPin(repoRoot),
    detectGo: detectGoToolchain,
  };
}

/**
 * The readiness verdict.
 *
 * Ordered so no branch can answer a question a later branch would have
 * answered differently: packaging first (it decides the whole vocabulary),
 * then platform support (nothing a developer installs changes it), then
 * presence, then the toolchain (only reached when a build is the remedy).
 */
export async function resolveStudioBridgeReadiness(
  probes: StudioBridgeReadinessProbes = defaultProbes(),
): Promise<StudioBridgeReadiness> {
  if (probes.packaged) {
    const located = await probes.locate();
    return located.kind === "found"
      ? { kind: "ready" }
      : { kind: "missing_packaged" };
  }

  if (bridgeGoTarget(probes.platform, probes.arch) === null) {
    return { kind: "unsupported_platform" };
  }

  const located = await probes.locate();
  if (located.kind === "found") return { kind: "ready" };

  const requiredGoVersion = await probes.readGoPin();
  if (requiredGoVersion === null) return { kind: "pin_unreadable" };

  const detected = await probes.detectGo();
  return {
    kind: "missing_dev",
    platform: wirePlatform(probes.platform),
    requiredGoVersion,
    go: classifyGoToolchain(detected, requiredGoVersion),
  };
}

/**
 * The pin is EXACT, not a floor: `bridge/build.sh` refuses any other patch
 * because a different patch changes the emitted binary. So a newer Go is
 * `wrong_version`, not `present`, and the renderer shows both numbers.
 */
function classifyGoToolchain(
  detected: GoToolchainDetection,
  required: string,
): StudioBridgeGoToolchain {
  if (detected.kind === "missing") return { kind: "absent" };
  if (detected.kind === "unusable") return { kind: "unusable" };
  if (detected.version !== required) {
    return { kind: "wrong_version", found: detected.version };
  }
  return { kind: "present" };
}
