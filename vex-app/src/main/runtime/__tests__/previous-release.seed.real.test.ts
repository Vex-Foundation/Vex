/**
 * Seeds "the previous release" into a config dir and LEAVES it there, for the
 * built app to migrate through its UI (`e2e/native-migration.spec.ts`). The
 * same project, image, migrations and data as `docker-to-native.real.test.ts`
 * (`support/previous-release.ts`), stopped as the old app's quit leaves it.
 *
 *   VEX_SEED_PREVIOUS_RELEASE_CONFIG_DIR  absolute; gets the `.install-id`
 *   VEX_SEED_PREVIOUS_RELEASE_INSTALL_ID  must start with `migtest-`
 *   VEX_SEED_PREVIOUS_RELEASE_REPORT      absolute; what was seeded, as JSON
 *
 * The caller removes the project's containers and volumes when it is done.
 * Skipped, visibly, without those variables or without Docker and the pinned
 * image, so an ordinary test run never creates anything.
 */

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "", getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createPreviousRelease, dockerAnswers } = await import("./support/previous-release.js");

const configDir = process.env["VEX_SEED_PREVIOUS_RELEASE_CONFIG_DIR"];
const installId = process.env["VEX_SEED_PREVIOUS_RELEASE_INSTALL_ID"];
const report = process.env["VEX_SEED_PREVIOUS_RELEASE_REPORT"];

const why =
  configDir === undefined || installId === undefined || report === undefined
    ? "set VEX_SEED_PREVIOUS_RELEASE_CONFIG_DIR, _INSTALL_ID and _REPORT to seed"
    : !path.isAbsolute(configDir) || !path.isAbsolute(report)
      ? "the config dir and the report must be absolute paths"
      : !installId.startsWith("migtest-")
        ? "the install id must start with migtest-"
        : dockerAnswers();
const TITLE = "seed the previous release for the built app";

describe.skipIf(why !== null)(why === null ? TITLE : `${TITLE} (skipped: ${why})`, () => {
  it("seeds a stopped previous-release install into the config dir", { timeout: 600_000 }, async () => {
    const startedAt = Date.now();
    const release = await createPreviousRelease({ configDir: configDir as string, installId: installId as string });
    const seeded = await release.seed();
    expect(release.volumeExists(release.volumes[0] as string)).toBe(true);
    expect(release.runningContainers()).toEqual([]);
    writeFileSync(
      report as string,
      `${JSON.stringify(
        {
          installId: release.installId,
          project: release.project,
          volumes: release.volumes,
          migrationsApplied: seeded.migrationsApplied,
          counts: seeded.counts,
          databaseSize: seeded.databaseSize,
          seedMs: Date.now() - startedAt,
        },
        null,
        2,
      )}\n`,
    );
  });
});
