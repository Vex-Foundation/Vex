/**
 * Windows app-identity bootstrap step.
 *
 * Two contracts are proven here:
 *   1. the platform decision (win32 sets the id exactly once; every other
 *      platform sets nothing at all);
 *   2. the DRIFT GUARD - the constant compiled into main equals the `appId`
 *      electron-builder stamps into the installed shortcut. Windows matches a
 *      toast's AUMID against that shortcut, so a drift between the two is
 *      silent at build time and only shows up as missing notifications on a
 *      packaged Windows install. This test is the only mechanical link
 *      between the two files.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAppUserModelId,
  VEX_APP_USER_MODEL_ID,
  type AppUserModelIdHost,
} from "../app-user-model-id.js";

const VEX_APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * `appId` is a top-level scalar key in both configs, so a line-anchored read
 * is enough and keeps this test free of a YAML dependency the repo does not
 * otherwise carry. The assertion below fails loudly if the key stops being
 * top-level, rather than silently matching nothing.
 */
function readAppId(configFile: string): string {
  const source = readFileSync(path.join(VEX_APP_ROOT, configFile), "utf8");
  const match = /^appId:[ \t]*(\S+)[ \t]*$/m.exec(source);
  if (match === null) {
    throw new Error(
      `no top-level \`appId:\` key found in ${configFile}; the drift guard `
        + "cannot verify the Windows notification identity",
    );
  }
  return match[1] as string;
}

function recordingHost(platform: NodeJS.Platform): {
  readonly host: AppUserModelIdHost;
  readonly applied: string[];
} {
  const applied: string[] = [];
  return {
    host: {
      platform,
      setAppUserModelId: (id: string) => {
        applied.push(id);
      },
    },
    applied,
  };
}

describe("applyAppUserModelId", () => {
  it("sets the packaged app identity exactly once on win32", () => {
    const { host, applied } = recordingHost("win32");

    expect(applyAppUserModelId(host)).toBe(true);
    expect(applied).toEqual([VEX_APP_USER_MODEL_ID]);
  });

  it.each(["darwin", "linux", "freebsd"] as const)(
    "sets no app identity on %s",
    (platform) => {
      const { host, applied } = recordingHost(platform);

      expect(applyAppUserModelId(host)).toBe(false);
      // The absence IS the contract: `setAppUserModelId` is Windows-only.
      expect(applied).toEqual([]);
    },
  );
});

describe("Windows notification identity drift guard", () => {
  it.each([
    "electron-builder.yml",
    "electron-builder.release.yml",
  ])("matches the appId electron-builder stamps into %s", (configFile) => {
    expect(readAppId(configFile)).toBe(VEX_APP_USER_MODEL_ID);
  });
});
