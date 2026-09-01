/**
 * EVERY user-visible string of the Studio bridge-readiness panel (B1.6).
 *
 * Its own module rather than a section of `studio-copy.ts`, because this is a
 * per-operating-system guidance TABLE, not another line of shell chrome, and
 * folding a table into the shell's copy module would make one review of that
 * file mean reviewing two unrelated vocabularies.
 *
 * ## Why the Go guidance sends people to go.dev, and says so about package
 *    managers
 *
 * The owner asked for winget / brew / distro guidance alongside the go.dev
 * route, and it is named here. But the pin is EXACT: `bridge/build.sh` refuses
 * any patch other than the one it declares, because a different patch changes
 * the emitted binary. Package managers track their own latest, so following one
 * of them will frequently land the user right back on this screen with
 * `wrong_version`. So the version-pinned route leads, the package manager is
 * named second, and the reason it may not work is stated rather than left for
 * the user to discover twice.
 *
 * ## Why the URLs are text and not links (for now)
 *
 * `go.dev/dl` and `go.dev/doc/install` ARE path-scoped entries on the
 * `shell.openExternal` allowlist (added with this feature), but the guidance
 * sentences embed the addresses inline, so turning them into `DocsLink`
 * anchors means restructuring each sentence into parts. That restructuring
 * belongs to the notification/a11y sweep, not to a copy table. Until then the
 * reader can select and copy the address; this panel is reachable only from a
 * from-source run, so its audience already has a terminal open.
 *
 * NO ROADMAP COPY and no em dashes, same as the rest of the Studio shell.
 */

import type {
  StudioBridgeGoToolchain,
  StudioBridgeHostPlatform,
} from "@shared/schemas/studio-bridge-readiness.js";

/** The exact command that builds the bridge for the current machine. */
export const STUDIO_BRIDGE_BUILD_COMMAND =
  "pnpm --dir vex-app run build:bridge:dev";

export const STUDIO_BRIDGE_RECHECK_LABEL = "Re-check";
export const STUDIO_BRIDGE_RECHECKING_LABEL = "Re-checking";
export const STUDIO_BRIDGE_PANEL_LABEL = "Vex Studio bridge";

/** The title above every failing branch: one name for one problem. */
export const STUDIO_BRIDGE_TITLES = {
  missing_packaged: "Vex Studio's bridge is missing from this installation",
  unsupported_platform: "Vex builds no Studio bridge for this system",
  pin_unreadable: "This source checkout does not declare its Go version",
  missing_dev: "Vex Studio's bridge has not been built yet",
  read_failed: "Vex could not check its Studio bridge",
} as const;

/**
 * The one sentence under each title.
 *
 * `missing_packaged` NEVER mentions Go (owner decision 2026-09-01). The user
 * did not build this binary and cannot build it; the only true remedy is
 * reinstalling, and naming a compiler here would be advice they cannot act on.
 */
export const STUDIO_BRIDGE_DETAILS = {
  missing_packaged:
    "The bridge ships inside Vex, so its absence means this installation is "
    + "damaged. Reinstall Vex to restore it. Until then, Studio writes no "
    + "coding-agent config files.",
  unsupported_platform:
    "Vex builds the Studio bridge for macOS, Windows and Linux on x64 and "
    + "arm64 only. Studio writes no coding-agent config files on this machine.",
  pin_unreadable:
    "bridge/build.sh no longer declares REQUIRED_GO_VERSION, so Vex cannot say "
    + "which Go toolchain to install without guessing. Check out the file "
    + "again, then re-check.",
  read_failed:
    "The check itself did not answer, so this says nothing about whether the "
    + "bridge is there. Try again.",
} as const;

/** What the Studio bridge is for, shown once above the remedy. */
export const STUDIO_BRIDGE_PURPOSE =
  "The bridge is the program your coding agent runs to reach Vex Studio. "
  + "Without it, Studio writes no coding-agent config files.";

/**
 * The toolchain half of the from-source diagnosis. One sentence per state,
 * with the pin (and, for a mismatch, the version actually found) rendered by
 * the caller because both are wire values.
 */
export function studioBridgeGoSentence(
  go: StudioBridgeGoToolchain,
  requiredGoVersion: string,
): string {
  if (go.kind === "present") {
    return `Go ${requiredGoVersion} is installed, so all that is missing is the build.`;
  }
  if (go.kind === "absent") {
    return `The build needs Go ${requiredGoVersion}, and no go was found on your PATH.`;
  }
  if (go.kind === "unusable") {
    return (
      `A go is on your PATH but it did not report a version. The build needs `
      + `Go ${requiredGoVersion} exactly.`
    );
  }
  return (
    `Your toolchain reports Go ${go.found}, and the bridge is pinned to `
    + `Go ${requiredGoVersion}. The pin is exact, not a minimum: a different `
    + "patch changes the emitted binary."
  );
}

/** Whether the branch needs install guidance at all. */
export function needsGoInstallGuidance(go: StudioBridgeGoToolchain): boolean {
  return go.kind !== "present";
}

/**
 * Per-operating-system Go install guidance.
 *
 * `pinned` is the route that can actually land the exact version, so it comes
 * first. `packaged` names the operating system's usual package manager and
 * states plainly why it may not satisfy an exact pin.
 */
export interface GoInstallGuidance {
  readonly pinned: string;
  readonly packaged: string | null;
}

export function studioGoInstallGuidance(
  platform: StudioBridgeHostPlatform,
  requiredGoVersion: string,
): GoInstallGuidance {
  if (platform === "win32") {
    return {
      pinned:
        `Download the Windows installer for ${requiredGoVersion} from `
        + "https://go.dev/dl/ and run it.",
      packaged:
        "winget can install Go, but it tracks the latest release, which may "
        + "not be the pinned version.",
    };
  }
  if (platform === "darwin") {
    return {
      pinned:
        `Download the macOS package for ${requiredGoVersion} from `
        + "https://go.dev/dl/ and run it.",
      packaged:
        "Homebrew's go formula tracks the latest release, which may not be "
        + "the pinned version.",
    };
  }
  if (platform === "linux") {
    return {
      pinned:
        `Download the Linux tarball for ${requiredGoVersion} from `
        + "https://go.dev/dl/ and install it as described at "
        + "https://go.dev/doc/install.",
      packaged:
        "Your distribution's Go package tracks its own version, which may not "
        + "be the pinned version.",
    };
  }
  return {
    pinned: `Install Go ${requiredGoVersion} from https://go.dev/dl/.`,
    packaged: null,
  };
}
