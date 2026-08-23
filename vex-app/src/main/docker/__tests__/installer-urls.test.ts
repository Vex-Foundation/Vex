/**
 * Pin the installer URL allowlist — drift here is a high-risk supply-
 * chain regression (codex turn 4 YELLOW #2). Adding/removing platforms
 * MUST update both the table and these tests deliberately.
 */

import { describe, expect, it } from "vitest";
import {
  DESKTOP_INSTALLER_URLS,
  getInstallerForPlatform,
  isAllowedInstallerUrl,
} from "../installer-urls.js";

describe("DESKTOP_INSTALLER_URLS", () => {
  it("has exactly the four supported installer targets", () => {
    expect(Object.keys(DESKTOP_INSTALLER_URLS).sort()).toEqual([
      "macos-arm64",
      "macos-x64",
      "windows-arm64",
      "windows-x64",
    ]);
  });

  it("puts the architecture in the URL path, not the filename", () => {
    const amd64 = DESKTOP_INSTALLER_URLS["windows-x64"];
    const arm64 = DESKTOP_INSTALLER_URLS["windows-arm64"];
    expect(new URL(amd64.url).pathname).toContain("/amd64/");
    expect(new URL(arm64.url).pathname).toContain("/arm64/");
    expect(arm64.filename).toBe(amd64.filename);
  });

  it("only references desktop.docker.com over https", () => {
    for (const entry of Object.values(DESKTOP_INSTALLER_URLS)) {
      const url = new URL(entry.url);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("desktop.docker.com");
    }
  });
});

describe("getInstallerForPlatform", () => {
  it.each<[NodeJS.Platform, NodeJS.Architecture, string]>([
    ["darwin", "arm64", "Docker.dmg"],
    ["darwin", "x64", "Docker.dmg"],
    ["win32", "x64", "Docker Desktop Installer.exe"],
    ["win32", "arm64", "Docker Desktop Installer.exe"],
  ])("returns entry for %s/%s", (platform, arch, expectedFilename) => {
    const entry = getInstallerForPlatform(platform, arch);
    expect(entry).not.toBeNull();
    expect(entry?.filename).toBe(expectedFilename);
  });

  it("returns null for Linux (apt repo flow, not direct download)", () => {
    expect(getInstallerForPlatform("linux", "x64")).toBeNull();
    expect(getInstallerForPlatform("linux", "arm64")).toBeNull();
  });

  it("returns null for unsupported combinations", () => {
    expect(getInstallerForPlatform("freebsd", "x64")).toBeNull();
    expect(getInstallerForPlatform("linux", "x64")).toBeNull();
  });

  // Previously asserted `getInstallerForPlatform("win32", "arm64")` is null,
  // which hard-blocked every Snapdragon-class Windows machine. Docker ships
  // an arm64 Windows installer, so that combination now resolves.
  it("selects the arm64 Windows installer on Windows on Arm", () => {
    expect(getInstallerForPlatform("win32", "arm64")?.url).toContain("/arm64/");
  });
});

describe("isAllowedInstallerUrl", () => {
  it("accepts every entry in the allowlist", () => {
    for (const entry of Object.values(DESKTOP_INSTALLER_URLS)) {
      expect(isAllowedInstallerUrl(entry.url)).toBe(true);
    }
  });

  it.each([
    "http://desktop.docker.com/mac/main/arm64/Docker.dmg", // wrong scheme
    "https://malicious.example.com/Docker.dmg",
    "https://desktop.docker.com/mac/main/arm64/MaliciousPayload.dmg",
    "https://desktop.docker.com/win/main/amd64/Docker.exe", // wrong basename
    "https://desktop.docker.com/", // not in pin set
    "javascript:alert(1)",
    "file:///Users/x/Docker.dmg",
    "",
    "not-a-url",
  ])("rejects %j", (url) => {
    expect(isAllowedInstallerUrl(url)).toBe(false);
  });
});
