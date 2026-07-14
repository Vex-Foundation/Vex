/** Non-secret Hyperliquid release configuration, loaded only in main. */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { z } from "zod";

const releaseConfigSchema = z.object({
  builderAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
}).strict();

function releaseConfigPaths(): readonly string[] {
  if (app.isPackaged) return [path.join(process.resourcesPath, "hyperliquid-release.json")];
  return [
    path.join(process.cwd(), "resources", "hyperliquid-release.json"),
    path.join(process.cwd(), "vex-app", "resources", "hyperliquid-release.json"),
  ];
}

/**
 * Makes the release-owned public builder address available to the in-process
 * engine. No fallback address exists in source: missing or malformed config
 * means orders omit builder fees.
 */
export function loadHyperliquidReleaseConfig(): void {
  for (const candidate of releaseConfigPaths()) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = releaseConfigSchema.parse(JSON.parse(readFileSync(candidate, "utf8")));
      process.env["VEX_HYPERLIQUID_BUILDER_ADDRESS"] = parsed.builderAddress;
      return;
    } catch {
      delete process.env["VEX_HYPERLIQUID_BUILDER_ADDRESS"];
      return;
    }
  }
  delete process.env["VEX_HYPERLIQUID_BUILDER_ADDRESS"];
}
