/**
 * Projects-root contract (Vex Studio stage P).
 *
 * Three things are proved here, and each of them is the difference between a
 * project the user can open and a project pointing at somebody else's files:
 *
 *   1. the configured root honours an ABSOLUTE `projectsRoot` override and
 *      IGNORES a relative one (the same rule `VEX_CONFIG_DIR` follows);
 *   2. the root is REALPATH-resolved, so a symlinked root is compared as the
 *      place it actually points to rather than the link that names it;
 *   3. a root that no longer matches the one recorded in `studio_settings`
 *      fails closed with `projects.root_changed` - it never silently re-homes
 *      the existing rows, whose `root_path` is relative to the recorded root.
 */

import { mkdtemp, mkdir, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}) as { projectsRoot?: string }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@config/store.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const {
  assertProjectsRootUnchanged,
  configuredProjectsRoot,
  formatProjectDisplayPath,
  resolveProjectDirectory,
  resolveProjectsRoot,
} = await import("../projects-root.js");
const { DEFAULT_PROJECTS_ROOT } = await import("../../paths/config-dir.js");

const CORR = "corr-projects-root";
let scratch: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.loadConfig.mockReturnValue({});
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "vex-projects-root-")));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Minimal scripted `pg.Client` - only `studio_settings` is read here. */
function scriptedClient(rows: ReadonlyArray<{ projects_root: string }>): Client {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as Client;
}

describe("configuredProjectsRoot", () => {
  it("uses the platform default when no override is configured", () => {
    expect(configuredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
  });

  it("honours an ABSOLUTE projectsRoot override", () => {
    mocks.loadConfig.mockReturnValue({ projectsRoot: scratch });
    expect(configuredProjectsRoot()).toBe(scratch);
  });

  it("IGNORES a relative projectsRoot override (a typo must not redirect into the cwd)", () => {
    mocks.loadConfig.mockReturnValue({ projectsRoot: "projects" });
    expect(configuredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
    mocks.loadConfig.mockReturnValue({ projectsRoot: "./here/../there" });
    expect(configuredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
    mocks.loadConfig.mockReturnValue({ projectsRoot: "" });
    expect(configuredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
  });
});

describe("resolveProjectsRoot", () => {
  it("creates the root when absent and returns it", async () => {
    const target = path.join(scratch, "nested", "projects");
    mocks.loadConfig.mockReturnValue({ projectsRoot: target });
    const outcome = await resolveProjectsRoot(CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toBe(await realpath(target));
  });

  it("returns the REALPATH, so a symlinked root resolves to its real location", async () => {
    const real = path.join(scratch, "real-projects");
    const link = path.join(scratch, "linked-projects");
    await mkdir(real);
    await symlink(real, link, "dir");
    mocks.loadConfig.mockReturnValue({ projectsRoot: link });

    const outcome = await resolveProjectsRoot(CORR);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The link name never becomes the root: everything downstream compares
    // against the place the link points to.
    expect(outcome.data).toBe(real);
    expect(outcome.data).not.toBe(link);
  });

  it("fails closed with projects.root_unavailable when the root cannot be created", async () => {
    // A FILE where the directory belongs. Nothing is written and the failure is
    // named, not collapsed into an unexpected error.
    const filePath = path.join(scratch, "not-a-dir");
    await (await import("node:fs/promises")).writeFile(filePath, "x");
    mocks.loadConfig.mockReturnValue({ projectsRoot: filePath });

    const outcome = await resolveProjectsRoot(CORR);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.root_unavailable");
    expect(outcome.error.domain).toBe("projects");
    expect(outcome.error.redacted).toBe(true);
    // The absolute path is main-process information and never rides the error.
    expect(JSON.stringify(outcome.error)).not.toContain(filePath);
  });
});

describe("assertProjectsRootUnchanged", () => {
  it("reports 'no root recorded yet' so the create path knows it owns the first write", async () => {
    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([]),
      scratch,
      CORR,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toBeNull();
  });

  it("passes when the configured root equals the recorded one", async () => {
    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([{ projects_root: scratch }]),
      scratch,
      CORR,
    );
    expect(outcome.ok).toBe(true);
  });

  it("fails closed with projects.root_changed when a project already exists under another root", async () => {
    const outcome = await assertProjectsRootUnchanged(
      scriptedClient([{ projects_root: path.join(scratch, "old") }]),
      path.join(scratch, "new"),
      CORR,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.root_changed");
    expect(outcome.error.userActionable).toBe(true);
    expect(outcome.error.retryable).toBe(false);
    // The remedy must be stated: a refusal that does not say what to restore is
    // a dead end.
    expect(outcome.error.message).toMatch(/restore/i);
    // Neither path leaks to the renderer.
    expect(JSON.stringify(outcome.error)).not.toContain(scratch);
  });
});

describe("resolveProjectDirectory", () => {
  it("resolves exactly one segment below the root", () => {
    expect(resolveProjectDirectory("/roots/projects", "my-app")).toBe(
      path.resolve("/roots/projects", "my-app"),
    );
  });

  it("refuses anything that escapes or nests below the root (defence in depth)", () => {
    // Unreachable through the slug alphabet - this guard exists so a future
    // caller cannot widen the input without tripping it.
    for (const slug of ["..", "../escape", "a/b", "", ".", "/absolute"]) {
      expect(
        resolveProjectDirectory("/roots/projects", slug),
        `slug ${JSON.stringify(slug)} was accepted`,
      ).toBeNull();
    }
  });
});

describe("formatProjectDisplayPath", () => {
  it("collapses the home directory to ~ so a screenshot carries no identity path", () => {
    expect(
      formatProjectDisplayPath(
        path.join("/home/someone", "Vex", "projects"),
        "my-app",
        "/home/someone",
      ),
    ).toBe(path.join("~", "Vex", "projects", "my-app"));
  });

  it("leaves a root outside the home directory as-is", () => {
    expect(
      formatProjectDisplayPath("/srv/workspaces", "my-app", "/home/someone"),
    ).toBe(path.join("/srv/workspaces", "my-app"));
  });
});
