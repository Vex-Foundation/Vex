/**
 * Strict allowlist of Docker Desktop installer URLs (codex turn 4 YELLOW
 * #2). The renderer NEVER constructs install URLs — it asks the main
 * process for a download via `vex.docker.install({ method, ... })` and
 * main resolves the canonical URL from this table.
 *
 * Filenames are pinned to the exact basename Docker Hub serves so a
 * malicious DNS / proxy redirect that returns an HTML page or a renamed
 * binary fails the post-download integrity check (M4 download handler).
 */

export interface InstallerUrlEntry {
  readonly url: string;
  readonly filename: string;
}

export type DesktopPlatform =
  | "macos-arm64"
  | "macos-x64"
  | "windows-x64"
  | "windows-arm64";

export const DESKTOP_INSTALLER_URLS: Readonly<
  Record<DesktopPlatform, InstallerUrlEntry>
> = {
  "macos-arm64": {
    url: "https://desktop.docker.com/mac/main/arm64/Docker.dmg",
    filename: "Docker.dmg",
  },
  "macos-x64": {
    url: "https://desktop.docker.com/mac/main/amd64/Docker.dmg",
    filename: "Docker.dmg",
  },
  "windows-x64": {
    url: "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
    filename: "Docker Desktop Installer.exe",
  },
  // Windows on arm64 (Snapdragon-class machines). Docker ships this build
  // today; the architecture lives ONLY in the URL path segment, the served
  // basename is identical to the amd64 one.
  "windows-arm64": {
    url: "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe",
    filename: "Docker Desktop Installer.exe",
  },
};

const ALLOWED_HOSTS: ReadonlyArray<string> = ["desktop.docker.com"];

/**
 * Returns the installer entry for the current platform/arch combo, or
 * `null` for Linux (which uses the apt repo flow, not a direct download).
 */
export function getInstallerForPlatform(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): InstallerUrlEntry | null {
  if (platform === "darwin" && arch === "arm64") return DESKTOP_INSTALLER_URLS["macos-arm64"];
  if (platform === "darwin" && arch === "x64") return DESKTOP_INSTALLER_URLS["macos-x64"];
  if (platform === "win32" && arch === "x64") return DESKTOP_INSTALLER_URLS["windows-x64"];
  if (platform === "win32" && arch === "arm64") return DESKTOP_INSTALLER_URLS["windows-arm64"];
  return null;
}

/**
 * Validates that a URL is in the allowlist. Used as a defense-in-depth
 * check in the download handler — main code only constructs URLs from
 * this table, but a bug somewhere could pass a renderer-supplied string
 * through, and this gate would still catch it.
 */
export function isAllowedInstallerUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (!ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) return false;
    // Pin: every allowlisted entry's URL must match exactly.
    for (const entry of Object.values(DESKTOP_INSTALLER_URLS)) {
      if (entry.url === raw) return true;
    }
    return false;
  } catch {
    return false;
  }
}
