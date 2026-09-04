/**
 * THE PROJECTS ROOT, RESOLVED FROM A REAL `config.json` BY THE REAL CONFIG OWNER.
 *
 * `projects-root.test.ts` mocks `@config/store.js` and asks what
 * `configuredProjectsRoot()` does with a value; that is the right test for the
 * absolute/relative rule and it is deliberately left alone. It also cannot see
 * the defect this file exists for: the app never reads a `projectsRoot` VALUE,
 * it reads a DOCUMENT, and `loadConfig` decides whether that document counts at
 * all before any field of it is looked at.
 *
 *   `if (parsed.version !== 1) return defaults`  (`src/config/store.ts`)
 *
 * A document without `version: 1` is discarded WHOLE - override included - and
 * the platform default wins silently. That is exactly what happened to the e2e
 * fixture, whose `config.json` carried the override and no version: every
 * "isolated" run created its projects in the developer's real
 * `~/Vex/projects` instead of its own throwaway root.
 *
 * So this suite exercises the real chain end to end - a file on disk,
 * `loadConfig`, `resolveProjectsRootPath` - with nothing mocked but the logger.
 * The precedence table below is the contract: what the file says, and what the
 * app therefore uses.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { DEFAULT_PROJECTS_ROOT } = await import("../../paths/config-dir.js");

const originalConfigDir = process.env["VEX_CONFIG_DIR"];
const scratchDirs: string[] = [];

/**
 * Point `VEX_CONFIG_DIR` at a fresh directory holding `document`, then ask the
 * projects-root owner where projects live.
 *
 * The modules are re-imported per case because `CONFIG_DIR` and `CONFIG_FILE`
 * are resolved ONCE at import (`src/config/paths.ts`), which is also how the
 * app behaves: the config directory is decided when the process starts.
 */
async function rootConfiguredBy(document: string | null): Promise<string> {
  const configDir = await mkdtemp(path.join(tmpdir(), "vex-config-dir-"));
  scratchDirs.push(configDir);
  if (document !== null) {
    await writeFile(path.join(configDir, "config.json"), document, "utf8");
  }
  process.env["VEX_CONFIG_DIR"] = configDir;
  vi.resetModules();
  const { configuredProjectsRoot } = await import("../projects-root.js");
  return configuredProjectsRoot();
}

/** An absolute root that exists nowhere near the default, per case. */
function overrideRoot(): string {
  return path.join(tmpdir(), "vex-projects-root-override");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env["VEX_CONFIG_DIR"];
  } else {
    process.env["VEX_CONFIG_DIR"] = originalConfigDir;
  }
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("the projects root a config.json actually produces", () => {
  it("honours an absolute projectsRoot in a version-1 document", async () => {
    const root = overrideRoot();
    expect(
      await rootConfiguredBy(JSON.stringify({ version: 1, projectsRoot: root })),
    ).toBe(root);
  });

  it("IGNORES the override when the document carries no version", async () => {
    // The e2e leak, as a unit: the key is present, absolute and correct, and
    // the app still uses the default because the DOCUMENT was rejected. A
    // writer of a config file has to supply the version or the override does
    // not exist.
    expect(
      await rootConfiguredBy(JSON.stringify({ projectsRoot: overrideRoot() })),
    ).toBe(DEFAULT_PROJECTS_ROOT);
  });

  it("IGNORES the override when the document carries a future version", async () => {
    expect(
      await rootConfiguredBy(JSON.stringify({ version: 2, projectsRoot: overrideRoot() })),
    ).toBe(DEFAULT_PROJECTS_ROOT);
  });

  it("IGNORES a relative projectsRoot in an otherwise valid document", async () => {
    expect(
      await rootConfiguredBy(JSON.stringify({ version: 1, projectsRoot: "projects" })),
    ).toBe(DEFAULT_PROJECTS_ROOT);
  });

  it("uses the default when there is no config file at all", async () => {
    expect(await rootConfiguredBy(null)).toBe(DEFAULT_PROJECTS_ROOT);
  });

  it("uses the default when the config file is not JSON", async () => {
    expect(await rootConfiguredBy(",,,,")).toBe(DEFAULT_PROJECTS_ROOT);
  });
});
